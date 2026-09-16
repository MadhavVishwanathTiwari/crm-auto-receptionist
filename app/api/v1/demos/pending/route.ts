// What to build a demo for.
//
// The Auto-Receptionist builder's whole work queue. It replaced the query at
// the top of that repo's build-from-sheet.mjs, which selected sheet rows where
// `status == 'first_touch'` and `demo_txt` was empty; once status lived in our
// event log the sheet had nothing true to read.
//
// The eligibility rule is deliberately NOT "first touch has gone out". The
// build order puts demos at qualification, before T1, so the T1 copy is true
// when it claims one exists and T2 is not racing a build. A lead that has
// already had T1 and still has no demo is included too, and first: T2 requires
// demo_ready_at, so it is blocked until one arrives.
//
// Service role: the caller is a GitHub Action with no session.

import { requireBearer } from "@/lib/cronAuth";
import { serverEnv } from "@/lib/env";
import { createAdminSupabase } from "@/lib/supabase/admin";
import { selectAll } from "@/lib/supabase/paginate";

export const runtime = "nodejs";
export const maxDuration = 30;

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 500;

/**
 * How long a refused build keeps a lead out of the queue.
 *
 * A site that cannot be built tonight almost never can tomorrow: the phone is
 * an image, the server 403s a datacenter, the address is nowhere. Without this
 * the same twenty refusals came back first every night and took the whole
 * budget, which is what the builder's date-based rotation used to paper over.
 * A week lets a site that was merely down get another go.
 */
const FAILURE_COOLDOWN_DAYS = 7;

/**
 * Statuses that still want a demo, in the order they want it.
 *
 * Everything omitted is either finished with (replied, closed, do_not_contact)
 * or a dead address (bounced, unsubscribed), and building for those spends
 * model budget on an email that will never send.
 *
 *   0  T1 is out and T2, which carries the link, is waiting on this demo.
 *   1  Somebody owns it and is about to write to it.
 *   2  Nobody has touched it yet.
 */
const PRIORITY: Record<string, number> = {
  sent: 0,
  delivered: 0,
  opened: 0,
  claimed: 1,
  audited: 1,
  queued: 1,
  imported: 2,
  qualified: 2,
};

const WANTS_DEMO = Object.keys(PRIORITY);

interface Candidate {
  id: string;
  company_name: string | null;
  website: string;
  website_domain: string | null;
  city: string | null;
  state: string | null;
  phone: string | null;
  place_id: string | null;
  timezone: string | null;
  timezone_source: string | null;
  verification: string;
  rating: number | null;
  status: string;
  created_at: string;
}

export async function GET(request: Request) {
  const denied = requireBearer(request, serverEnv().arIngestSecret);
  if (denied) return denied;

  const url = new URL(request.url);
  const limit = Math.min(
    Math.max(Number(url.searchParams.get("limit")) || DEFAULT_LIMIT, 1),
    MAX_LIMIT,
  );
  const org = url.searchParams.get("org");

  const supabase = createAdminSupabase();
  const since = new Date(Date.now() - FAILURE_COOLDOWN_DAYS * 86_400_000).toISOString();

  // Every candidate, not the first `limit`: the cooldown and the priority are
  // applied here, after the read, so a `.limit()` in the query would slice
  // before either and hand back twenty leads that failed last night.
  const [candidates, failures, suppressions] = await Promise.all([
    selectAll<Candidate>(() => {
      let query = supabase
        .from("leads")
        .select(
          "id, company_name, website, website_domain, city, state, phone, place_id, timezone, timezone_source, verification, rating, status, created_at",
        )
        .is("archived_at", null)
        .is("demo_ready_at", null)
        .is("halted_at", null)
        .is("terminal_outcome", null)
        .eq("is_qualified", true)
        // An address a verifier called invalid will never be emailed, so a
        // demo for it is a link nobody sends. `unknown` is most of the Clay
        // imports and is emailed like anything else, so it is built for.
        .neq("verification", "invalid")
        .not("website", "is", null)
        .in("status", WANTS_DEMO);
      if (org) query = query.eq("org_id", org);
      return query;
    }),
    // Read by type and date rather than by the candidates' ids: a few hundred
    // uuids in a query string is a URL long enough to be refused, and a week
    // of refusals is a few hundred rows at most.
    selectAll<{ id: string; lead_id: string }>(() => {
      let query = supabase
        .from("lead_events")
        .select("id, lead_id")
        .eq("type", "demo_failed")
        .gte("occurred_at", since);
      if (org) query = query.eq("org_id", org);
      return query;
    }),
    // Suppressions match on domain as well as address, and a domain-level
    // entry covers rows whose own email was never suppressed. Building for a
    // suppressed company is money spent on an email the dispatcher refuses.
    selectAll<{ id: string; domain: string | null }>(() =>
      supabase.from("suppressions").select("id, domain").not("domain", "is", null),
    ),
  ]);

  // A partial answer is not an answer here: a failed failure-read would hand
  // back every refused site again, and a failed suppression read would build
  // for companies that asked us to stop.
  const readError = candidates.error ?? failures.error ?? suppressions.error;
  if (readError) return Response.json({ error: readError.message }, { status: 500 });

  const coolingDown = new Set(failures.data.map((row) => row.lead_id));
  const suppressed = new Set(
    suppressions.data.map((row) => row.domain).filter((domain): domain is string => Boolean(domain)),
  );

  const eligible = candidates.data
    .filter((lead) => !lead.website_domain || !suppressed.has(lead.website_domain))
    .filter((lead) => !coolingDown.has(lead.id));

  eligible.sort(
    (a, b) =>
      (PRIORITY[a.status] ?? 9) - (PRIORITY[b.status] ?? 9) ||
      // Oldest first within a tier: the lead that has waited longest is the
      // one closest to its follow-up.
      a.created_at.localeCompare(b.created_at),
  );

  const pending = eligible.slice(0, limit).map((lead) => ({
    lead_id: lead.id,
    // The field that repo's pipeline actually consumes.
    website: lead.website,
    domain: lead.website_domain,
    company_name: lead.company_name,
    city: lead.city,
    state: lead.state,
    // From the Maps listing. The builder may fall back on these four when the
    // site itself does not state them, and labels the fact as ours when it does.
    phone: lead.phone,
    place_id: lead.place_id,
    // Safe to hand over whatever its source: a zone is only ever stored here
    // from coordinates, a named place, or a person, never guessed from a state
    // (non-negotiable 6). The builder uses it instead of its own state-and-city
    // table, which refuses every Texas town it does not list.
    timezone: lead.timezone,
    timezone_source: lead.timezone_source,
    verification: lead.verification,
    rating: lead.rating,
    status: lead.status,
  }));

  return Response.json({
    count: pending.length,
    limit,
    // Everything that qualified, before the limit, so a caller can tell a
    // drained queue from a truncated one.
    eligible: eligible.length,
    cooling_down: candidates.data.filter((lead) => coolingDown.has(lead.id)).length,
    // Post results back to /api/v1/demos with the same bearer. Echoing lead_id
    // makes that an exact match instead of a domain lookup, and failures go in
    // the same body.
    post_results_to: "/api/v1/demos",
    leads: pending,
  });
}
