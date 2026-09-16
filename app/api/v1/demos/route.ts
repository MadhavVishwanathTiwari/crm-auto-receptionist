// Demo ingest, called by the Auto-Receptionist repo after it builds a sandbox.
//
// This is the half of the contract that replaces writing `demo_txt` back into
// the outreach Google Sheet. GET /api/v1/demos/pending is the other half, and
// that one has to ship before the sheet is retired, because build-from-sheet.mjs
// currently reads `status == 'first_touch'` from it to decide what to build.
//
// Service role: the caller is a GitHub Action with no user session, and it has
// to see every org's leads.
//
// The join key is the NORMALIZED DOMAIN, not the slug, and that is a decision
// with a reason: slugs come from the hostname via slugFromUrl(), and nine
// hand-written demos in that repo use human-chosen slugs that do not match
// their domain at all. That repo already reconciles on domain via domainKey(),
// whose semantics lib/normalize/domain.ts deliberately matches. place_id is
// accepted and preferred when present so the key can be promoted later, but
// nothing in the AR repo has ever produced one.
//
// The same body carries the builds that were REFUSED, as `failures`. Each one
// becomes a `demo_failed` event, which is what lets the lead drawer and /write
// say why a lead has no demo, and what /pending reads back as a cooldown. A
// failure is not a URL, so the builder posts them straight away, on nights when
// nothing built as much as on any other.
//
// `?dry_run=1` matches everything and writes nothing: no record_demo(), no
// event, no orphan alert. The one-off backfill of demos built before this
// contract existed reads it before posting for real.

import { z } from "zod";

import { requireBearer } from "@/lib/cronAuth";
import { serverEnv } from "@/lib/env";
import { normalizeDomain } from "@/lib/normalize";
import { createAdminSupabase } from "@/lib/supabase/admin";

export const runtime = "nodejs";
export const maxDuration = 30;

/**
 * The payload, shaped around what that repo actually has in hand at the end of
 * buildOne(): the website it was given, the slug it derived, and the sandbox
 * URL. Everything else is optional because nothing over there produces it.
 *
 * `timezone` is accepted and deliberately NOT written to the lead. That repo
 * resolves zones from state and city, which is precisely the state-to-timezone
 * mapping this project refuses: it silently corrupts FL, TX, TN, ID, OR, KS,
 * NE, ND, SD, MI, IN, KY and Arizona. Ours comes from coordinates via geo-tz or
 * from a human. The value is kept in the event payload for comparison and
 * nothing reads it.
 */
const DemoPayload = z.object({
  lead_id: z.uuid().optional(),
  place_id: z.string().trim().min(1).optional(),
  website: z.string().trim().min(1).optional(),
  domain: z.string().trim().min(1).optional(),
  slug: z.string().trim().min(1),
  demo_txt_url: z.string().trim().url().optional(),
  demo_web_url: z.string().trim().url().optional(),
  /** Accepted, stored in the event payload, never applied. See above. */
  timezone: z.string().trim().optional(),
  /** One global Retell agent serves every demo; kept for the contract. */
  agent_id: z.string().trim().optional(),
  built_at: z.string().trim().optional(),
});

/**
 * A build the Auto-Receptionist pipeline refused to publish. Always echoes the
 * lead_id it was handed by /pending, so there is nothing to match on.
 */
const FailurePayload = z.object({
  lead_id: z.uuid(),
  website: z.string().trim().optional(),
  /** The builder's own blockers, e.g. "missing essential fact(s): phone". */
  reason: z.string().trim().min(1).max(500),
  /** Where it stopped: scrape, extract, verify, retrieval. Free text. */
  stage: z.string().trim().max(40).optional(),
});

const Body = z.union([
  DemoPayload,
  z
    .object({
      demos: z.array(DemoPayload).max(200).optional(),
      failures: z.array(FailurePayload).max(200).optional(),
    })
    // Without this `{ website }` with no slug parses as an empty batch and
    // answers 200, which is a refusal the caller would never see.
    .refine((body) => (body.demos?.length ?? 0) + (body.failures?.length ?? 0) > 0, {
      message: "nothing to record: send a demo, `demos` or `failures`",
    }),
]);

const SANDBOX_BASE = "https://autoreceptionist.io/sandbox";

interface Outcome {
  slug: string;
  matched_on: "lead_id" | "place_id" | "domain" | null;
  lead_id: string | null;
  /** Where the matched lead is now, so a dry run can say what a demo unblocks. */
  lead_status?: string;
  status: "recorded" | "orphaned" | "failed" | "would_record" | "would_orphan";
  detail?: string;
}

interface FailureOutcome {
  lead_id: string;
  status: "recorded" | "already_recorded" | "failed" | "would_record";
  detail?: string;
}

interface MatchRow {
  id: string;
  status: string;
}

export async function POST(request: Request) {
  const denied = requireBearer(request, serverEnv().arIngestSecret);
  if (denied) return denied;

  const dryRun = ["1", "true"].includes(new URL(request.url).searchParams.get("dry_run") ?? "");

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return Response.json({ error: "body is not JSON" }, { status: 400 });
  }

  const parsed = Body.safeParse(raw);
  if (!parsed.success) {
    return Response.json(
      { error: "payload rejected", detail: z.treeifyError(parsed.error) },
      { status: 422 },
    );
  }

  const batch = "slug" in parsed.data ? { demos: [parsed.data], failures: [] } : parsed.data;
  const demos = batch.demos ?? [];
  const failures = batch.failures ?? [];
  const supabase = createAdminSupabase();
  const outcomes: Outcome[] = [];

  for (const demo of demos) {
    // The URL that repo publishes. Derived here when it does not send one, so a
    // caller that only has a slug still produces a working link rather than a
    // lead marked demo-ready with nothing to open.
    const txtUrl = demo.demo_txt_url ?? `${SANDBOX_BASE}/${demo.slug}`;
    const domain = normalizeDomain(demo.domain ?? demo.website ?? null);

    let match: MatchRow | null = null;
    let matchedOn: Outcome["matched_on"] = null;

    if (demo.lead_id) {
      const { data } = await supabase
        .from("leads")
        .select("id, status")
        .eq("id", demo.lead_id)
        .maybeSingle();
      if (data) {
        match = data as MatchRow;
        matchedOn = "lead_id";
      }
    }

    if (!match && demo.place_id) {
      const { data } = await supabase
        .from("leads")
        .select("id, status")
        .eq("place_id", demo.place_id)
        .is("archived_at", null)
        .limit(1);
      if (data && data.length > 0) {
        match = data[0] as MatchRow;
        matchedOn = "place_id";
      }
    }

    if (!match && domain) {
      // Oldest first when a domain has more than one row: the duplicate is the
      // later import, and the original carries the audit and the claim.
      const { data } = await supabase
        .from("leads")
        .select("id, status")
        .eq("website_domain", domain)
        .is("archived_at", null)
        .order("created_at", { ascending: true })
        .limit(1);
      if (data && data.length > 0) {
        match = data[0] as MatchRow;
        matchedOn = "domain";
      }
    }

    if (!match) {
      if (dryRun) {
        outcomes.push({ slug: demo.slug, matched_on: null, lead_id: null, status: "would_orphan" });
        continue;
      }

      // Not a failure. The AR repo builds from its own list, and a demo can
      // legitimately arrive before the lead it belongs to is imported. Park it
      // as an alert so the next import can be reconciled against it by hand
      // rather than dropping a demo somebody paid to build.
      //
      // Which org hears about it. There is no lead to say, so: the org that
      // actually sends email, by its oldest mailbox. This used to be an
      // unordered `orgs.limit(1)`, which on the hosted project returned a
      // leftover test org no operator belongs to, so RLS hid every orphan
      // alert from the people who could act on it.
      const { data: sender } = await supabase
        .from("mailboxes")
        .select("org_id")
        .order("created_at", { ascending: true })
        .limit(1);
      let orgId = sender?.[0]?.org_id as string | undefined;
      if (!orgId) {
        const { data: orgs } = await supabase
          .from("orgs")
          .select("id")
          .order("created_at", { ascending: true })
          .limit(1);
        orgId = orgs?.[0]?.id as string | undefined;
      }

      if (orgId) {
        const { error: alertError } = await supabase.from("alerts").upsert(
          {
            org_id: orgId,
            kind: "orphan_demo",
            message: `Demo "${demo.slug}" (${domain ?? demo.website ?? "no domain"}) matched no lead.`,
            payload: { ...demo, demo_txt_url: txtUrl, normalized_domain: domain },
            dedupe_token: demo.slug,
          },
          { onConflict: "org_id,kind,dedupe_token", ignoreDuplicates: true },
        );
        if (alertError) {
          console.error(`demos: parking orphan ${demo.slug} failed: ${alertError.message}`);
        }
      }

      outcomes.push({ slug: demo.slug, matched_on: null, lead_id: null, status: "orphaned" });
      continue;
    }

    if (dryRun) {
      outcomes.push({
        slug: demo.slug,
        matched_on: matchedOn,
        lead_id: match.id,
        lead_status: match.status,
        status: "would_record",
      });
      continue;
    }

    // record_demo() is the only path past app.leads_guard_protected_columns(),
    // which refuses a direct UPDATE of the demo columns even from the service
    // role. It writes the row and the demo_ready event in one transaction.
    const { data: lead, error } = await supabase.rpc("record_demo", {
      p_lead_id: match.id,
      p_slug: demo.slug,
      p_txt_url: txtUrl,
      p_web_url: demo.demo_web_url ?? null,
      p_payload: {
        matched_on: matchedOn,
        source_website: demo.website ?? null,
        source_domain: domain,
        agent_id: demo.agent_id ?? null,
        // Their state-and-city derived zone, recorded and not applied.
        reported_timezone: demo.timezone ?? null,
        built_at: demo.built_at ?? null,
      },
    });

    if (error) {
      outcomes.push({
        slug: demo.slug,
        matched_on: matchedOn,
        lead_id: match.id,
        lead_status: match.status,
        status: "failed",
        detail: error.message,
      });
      continue;
    }

    outcomes.push({
      slug: demo.slug,
      matched_on: matchedOn,
      lead_id: (lead as { id?: string } | null)?.id ?? match.id,
      lead_status: match.status,
      status: "recorded",
    });
  }

  const failureOutcomes: FailureOutcome[] = [];
  // One refusal per lead per UTC day. The builder re-runs by hand as often as
  // anyone likes, and each re-post of the same night is the same fact.
  const day = new Date().toISOString().slice(0, 10);

  for (const failure of failures) {
    const { data: lead, error: leadError } = await supabase
      .from("leads")
      .select("id, org_id")
      .eq("id", failure.lead_id)
      .maybeSingle();

    if (leadError || !lead) {
      failureOutcomes.push({
        lead_id: failure.lead_id,
        status: "failed",
        detail: leadError?.message ?? "no such lead",
      });
      continue;
    }

    if (dryRun) {
      failureOutcomes.push({ lead_id: failure.lead_id, status: "would_record" });
      continue;
    }

    // Straight into the log rather than through an RPC: nothing about a failed
    // build is guarded, and the event is rank 0, so it moves no status.
    const { data: inserted, error } = await supabase
      .from("lead_events")
      .upsert(
        {
          org_id: lead.org_id,
          lead_id: lead.id,
          type: "demo_failed",
          payload: {
            reason: failure.reason,
            stage: failure.stage ?? null,
            source_website: failure.website ?? null,
          },
          dedupe_token: `demo_failed:${day}`,
        },
        { onConflict: "lead_id,type,dedupe_token", ignoreDuplicates: true },
      )
      .select("id");

    if (error) {
      failureOutcomes.push({ lead_id: failure.lead_id, status: "failed", detail: error.message });
      continue;
    }

    failureOutcomes.push({
      lead_id: failure.lead_id,
      status: (inserted ?? []).length > 0 ? "recorded" : "already_recorded",
    });
  }

  const failed =
    outcomes.filter((o) => o.status === "failed").length +
    failureOutcomes.filter((o) => o.status === "failed").length;
  const received = demos.length + failures.length;

  return Response.json(
    {
      dry_run: dryRun,
      received: demos.length,
      recorded: outcomes.filter((o) => o.status === "recorded").length,
      orphaned: outcomes.filter((o) => o.status === "orphaned").length,
      failed: outcomes.filter((o) => o.status === "failed").length,
      results: outcomes,
      failures_received: failures.length,
      failures_recorded: failureOutcomes.filter((o) => o.status === "recorded").length,
      failures_failed: failureOutcomes.filter((o) => o.status === "failed").length,
      failure_results: failureOutcomes,
    },
    // A partial failure is still a 200 with per-row detail: the caller builds a
    // batch and must be able to tell which rows to retry without parsing an
    // error page.
    { status: failed === received && received > 0 ? 502 : 200 },
  );
}
