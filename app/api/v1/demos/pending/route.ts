// What to build a demo for.
//
// This replaces the query at the top of build-from-sheet.mjs, which selects
// sheet rows where `status == 'first_touch'` and `verification == 'verified'`
// and `demo_txt` is empty. Once status lives in our event log that sheet has
// nothing to read, which is why this route had to exist before the sheet could
// be retired rather than after.
//
// The eligibility rule is deliberately NOT "first touch has gone out". The
// build order puts demos at qualification, before T1, so the T1 copy is true
// when it claims one exists and T2 is not racing a build. A lead that has
// already had T1 and still has no demo is included too: T2 requires
// demo_ready_at, so it is blocked until one arrives.
//
// Service role: the caller is a GitHub Action with no session.

import { requireBearer } from "@/lib/cronAuth";
import { serverEnv } from "@/lib/env";
import { createAdminSupabase } from "@/lib/supabase/admin";

export const runtime = "nodejs";
export const maxDuration = 30;

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 500;

/**
 * Statuses that still want a demo. Everything omitted is either finished with
 * (replied, closed, do_not_contact) or a dead address (bounced, unsubscribed),
 * and building for those spends model budget on an email that will never send.
 */
const WANTS_DEMO: string[] = [
  "imported",
  "qualified",
  "claimed",
  "audited",
  "queued",
  "sent",
  "delivered",
  "opened",
];

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

  let query = supabase
    .from("leads")
    .select(
      "id, org_id, company_name, website, website_domain, city, state, verification, rating, status, created_at",
    )
    .is("archived_at", null)
    .is("demo_ready_at", null)
    .is("halted_at", null)
    .is("terminal_outcome", null)
    .eq("is_qualified", true)
    .not("website", "is", null)
    .in("status", WANTS_DEMO)
    // Oldest first: a lead waiting on a demo is a lead whose T2 is waiting, and
    // the one that has waited longest is the one closest to its follow-up.
    .order("created_at", { ascending: true })
    .limit(limit);

  if (org) query = query.eq("org_id", org);

  const { data, error } = await query;
  if (error) return Response.json({ error: error.message }, { status: 500 });

  const leads = data ?? [];

  // Suppressions are checked here rather than in the query because they match
  // on domain as well as address, and a domain-level entry covers rows whose
  // own email was never suppressed. Building for a suppressed company is money
  // spent on an email the dispatcher will refuse to send.
  const domains = [
    ...new Set(leads.map((lead) => lead.website_domain).filter(Boolean)),
  ] as string[];

  const suppressed = new Set<string>();
  if (domains.length > 0) {
    const { data: rows } = await supabase
      .from("suppressions")
      .select("domain")
      .in("domain", domains);
    for (const row of rows ?? []) {
      if (row.domain) suppressed.add(row.domain as string);
    }
  }

  const pending = leads
    .filter((lead) => !lead.website_domain || !suppressed.has(lead.website_domain))
    .map((lead) => ({
      lead_id: lead.id,
      // The field that repo's pipeline actually consumes. Everything below it
      // is context for its logs and for a human reading the response.
      website: lead.website,
      domain: lead.website_domain,
      company_name: lead.company_name,
      city: lead.city,
      state: lead.state,
      // Its own selectRows() gates on verification == "verified". Passed
      // through so that rule stays that repo's to keep or drop, rather than
      // being silently reinterpreted here.
      verification: lead.verification,
      rating: lead.rating,
      status: lead.status,
    }));

  return Response.json({
    count: pending.length,
    limit,
    // Post results back to /api/v1/demos with the same bearer. Echoing lead_id
    // makes that an exact match instead of a domain lookup.
    post_results_to: "/api/v1/demos",
    leads: pending,
  });
}
