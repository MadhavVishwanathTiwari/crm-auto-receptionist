// Resolves IANA timezones for leads that have no zone yet.
//
// This is the ONLY module that imports lib/timezone/resolve, and therefore the
// only lambda carrying geo-tz's ~70 MB of boundary data. Keep it that way.
//
// Each run reads EVERY unresolved lead, in pages, not the first 500. A lead
// that cannot be resolved stays unresolved by design (non-negotiable 6), and
// the batch used to be "the first 500 with no zone" in no particular order:
// once 500 unresolvable leads existed they were that batch on every run, and a
// fresh import behind them was never looked at. Resolution is in-memory; the
// cost is the reads, at a thousand rows each.
//
// Uses the service role: it runs from pg_cron with no user session, and must
// see every org's leads.

import { createAdminSupabase } from "@/lib/supabase/admin";
import { requireBearer } from "@/lib/cronAuth";
import { serverEnv } from "@/lib/env";
import { selectAll } from "@/lib/supabase/paginate";
import { resolveTimezone } from "@/lib/timezone/resolve";
import { resolveTimezoneFromPlace } from "@/lib/timezone/places";

export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * No new write is started past this, well inside maxDuration. Whatever is left
 * is still unresolved and the next run, an hour later, starts on it.
 */
const RUN_BUDGET_MS = 45_000;

export async function POST(request: Request) {
  const denied = requireBearer(request, serverEnv().cronSecret);
  if (denied) return denied;

  const deadline = Date.now() + RUN_BUDGET_MS;
  const supabase = createAdminSupabase();

  const { data: leads, error } = await selectAll<{
    id: string;
    latitude: number;
    longitude: number;
  }>(() =>
    supabase
      .from("leads")
      .select("id, latitude, longitude")
      .is("timezone", null)
      // An archived lead is never scheduled, so it has no use for a zone.
      .is("archived_at", null)
      .not("latitude", "is", null)
      .not("longitude", "is", null),
  );

  if (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }

  let resolved = 0;
  let unresolved = 0;
  let deferred = 0;

  for (const lead of leads) {
    if (Date.now() > deadline) {
      deferred += 1;
      continue;
    }

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
  const { data: placeLeads, error: placeError } = await selectAll<{
    id: string;
    city: string | null;
    state: string | null;
    country_code: string | null;
  }>(() =>
    supabase
      .from("leads")
      .select("id, city, state, country_code")
      .is("timezone", null)
      .is("archived_at", null)
      .or("latitude.is.null,longitude.is.null"),
  );

  if (placeError) {
    return Response.json({ error: placeError.message }, { status: 500 });
  }

  let placed = 0;
  let unplaced = 0;

  for (const lead of placeLeads) {
    if (Date.now() > deadline) {
      deferred += 1;
      continue;
    }

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
    examined: leads.length,
    resolved,
    unresolved,
    examinedPlaces: placeLeads.length,
    placed,
    unplaced,
    // Out of time before these were tried. The next run starts on them.
    deferred,
    more: deferred > 0,
  });
}
