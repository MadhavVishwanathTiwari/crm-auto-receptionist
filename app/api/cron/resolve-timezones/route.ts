// Resolves IANA timezones for leads that have coordinates but no zone yet.
//
// This is the ONLY module that imports lib/timezone/resolve, and therefore the
// only lambda carrying geo-tz's ~70 MB of boundary data. Keep it that way.
//
// Uses the service role: it runs from pg_cron with no user session, and must
// see every org's leads.

import { createAdminSupabase } from "@/lib/supabase/admin";
import { requireBearer } from "@/lib/cronAuth";
import { serverEnv } from "@/lib/env";
import { resolveTimezone } from "@/lib/timezone/resolve";
import { resolveTimezoneFromPlace } from "@/lib/timezone/places";

export const runtime = "nodejs";
export const maxDuration = 60;

const BATCH = 500;

export async function POST(request: Request) {
  const denied = requireBearer(request, serverEnv().cronSecret);
  if (denied) return denied;

  const supabase = createAdminSupabase();

  const { data: leads, error } = await supabase
    .from("leads")
    .select("id, latitude, longitude")
    .is("timezone", null)
    .not("latitude", "is", null)
    .not("longitude", "is", null)
    .limit(BATCH);

  if (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }

  let resolved = 0;
  let unresolved = 0;

  for (const lead of leads ?? []) {
    const result = resolveTimezone(lead.latitude, lead.longitude);

    if (!result.ok) {
      // Leave timezone null so the lead stays in the manual-assignment queue.
      // Guessing here is what corrupts every send time downstream.
      unresolved += 1;
      continue;
    }

    const { error: updateError } = await supabase
      .from("leads")
      .update({ timezone: result.timezone, timezone_source: "coordinates" })
      .eq("id", lead.id)
      // Never overwrite a zone a human has already corrected.
      .is("timezone", null)
      .select("id");

    if (updateError) unresolved += 1;
    else resolved += 1;
  }

  // ---------------------------------------------------------------------
  // Second pass: leads with no usable coordinates, placed from location text.
  //
  // Coordinates are always preferred and are never re-derived from text; this
  // only ever sees rows the pass above could not touch. See lib/timezone/places
  // for why this is not the state lookup non-negotiable 6 forbids: a split
  // state resolves from a named city or not at all.
  // ---------------------------------------------------------------------
  const { data: placeLeads, error: placeError } = await supabase
    .from("leads")
    .select("id, city, state, country_code")
    .is("timezone", null)
    .or("latitude.is.null,longitude.is.null")
    .limit(BATCH);

  if (placeError) {
    return Response.json({ error: placeError.message }, { status: 500 });
  }

  let placed = 0;
  let unplaced = 0;

  for (const lead of placeLeads ?? []) {
    const result = resolveTimezoneFromPlace(
      lead.city,
      lead.state,
      lead.country_code,
    );

    if (!result.ok) {
      unplaced += 1;
      continue;
    }

    const { error: updateError } = await supabase
      .from("leads")
      .update({ timezone: result.timezone, timezone_source: "place" })
      .eq("id", lead.id)
      // Same as above: never overwrite a zone anyone or anything already set.
      .is("timezone", null)
      .select("id");

    if (updateError) unplaced += 1;
    else placed += 1;
  }

  return Response.json({
    examined: leads?.length ?? 0,
    resolved,
    unresolved,
    examinedPlaces: placeLeads?.length ?? 0,
    placed,
    unplaced,
    // More may remain; pg_cron calls this on an interval until it drains.
    more: (leads?.length ?? 0) === BATCH || (placeLeads?.length ?? 0) === BATCH,
  });
}
