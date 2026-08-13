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

const Body = z.union([
  DemoPayload,
  z.object({ demos: z.array(DemoPayload).max(200) }),
]);

const SANDBOX_BASE = "https://autoreceptionist.io/sandbox";

interface Outcome {
  slug: string;
  matched_on: "lead_id" | "place_id" | "domain" | null;
  lead_id: string | null;
  status: "recorded" | "orphaned" | "failed";
  detail?: string;
}

export async function POST(request: Request) {
  const denied = requireBearer(request, serverEnv().arIngestSecret);
  if (denied) return denied;

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

  const demos = "demos" in parsed.data ? parsed.data.demos : [parsed.data];
  const supabase = createAdminSupabase();
  const outcomes: Outcome[] = [];

  for (const demo of demos) {
    // The URL that repo publishes. Derived here when it does not send one, so a
    // caller that only has a slug still produces a working link rather than a
    // lead marked demo-ready with nothing to open.
    const txtUrl = demo.demo_txt_url ?? `${SANDBOX_BASE}/${demo.slug}`;
    const domain = normalizeDomain(demo.domain ?? demo.website ?? null);

    let leadId: string | null = null;
    let matchedOn: Outcome["matched_on"] = null;

    if (demo.lead_id) {
      const { data } = await supabase
        .from("leads")
        .select("id")
        .eq("id", demo.lead_id)
        .maybeSingle();
      if (data) {
        leadId = data.id as string;
        matchedOn = "lead_id";
      }
    }

    if (!leadId && demo.place_id) {
      const { data } = await supabase
        .from("leads")
        .select("id")
        .eq("place_id", demo.place_id)
        .is("archived_at", null)
        .limit(1);
      if (data && data.length > 0) {
        leadId = data[0]!.id as string;
        matchedOn = "place_id";
      }
    }

    if (!leadId && domain) {
      // Oldest first when a domain has more than one row: the duplicate is the
      // later import, and the original carries the audit and the claim.
      const { data } = await supabase
        .from("leads")
        .select("id")
        .eq("website_domain", domain)
        .is("archived_at", null)
        .order("created_at", { ascending: true })
        .limit(1);
      if (data && data.length > 0) {
        leadId = data[0]!.id as string;
        matchedOn = "domain";
      }
    }

    if (!leadId) {
      // Not a failure. The AR repo builds from its own list, and a demo can
      // legitimately arrive before the lead it belongs to is imported. Park it
      // as an alert so the next import can be reconciled against it by hand
      // rather than dropping a demo somebody paid to build.
      const { data: orgs } = await supabase.from("orgs").select("id").limit(1);
      const orgId = orgs?.[0]?.id as string | undefined;

      if (orgId) {
        await supabase.from("alerts").upsert(
          {
            org_id: orgId,
            kind: "orphan_demo",
            message: `Demo "${demo.slug}" (${domain ?? demo.website ?? "no domain"}) matched no lead.`,
            payload: { ...demo, demo_txt_url: txtUrl, normalized_domain: domain },
            dedupe_token: demo.slug,
          },
          { onConflict: "org_id,kind,dedupe_token", ignoreDuplicates: true },
        );
      }

      outcomes.push({ slug: demo.slug, matched_on: null, lead_id: null, status: "orphaned" });
      continue;
    }

    // record_demo() is the only path past app.leads_guard_protected_columns(),
    // which refuses a direct UPDATE of the demo columns even from the service
    // role. It writes the row and the demo_ready event in one transaction.
    const { data: lead, error } = await supabase.rpc("record_demo", {
      p_lead_id: leadId,
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
        lead_id: leadId,
        status: "failed",
        detail: error.message,
      });
      continue;
    }

    outcomes.push({
      slug: demo.slug,
      matched_on: matchedOn,
      lead_id: (lead as { id?: string } | null)?.id ?? leadId,
      status: "recorded",
    });
  }

  const recorded = outcomes.filter((o) => o.status === "recorded").length;
  const failed = outcomes.filter((o) => o.status === "failed").length;

  return Response.json(
    {
      received: demos.length,
      recorded,
      orphaned: outcomes.filter((o) => o.status === "orphaned").length,
      failed,
      results: outcomes,
    },
    // A partial failure is still a 200 with per-row detail: the caller builds a
    // batch and must be able to tell which rows to retry without parsing an
    // error page.
    { status: failed === demos.length && demos.length > 0 ? 502 : 200 },
  );
}
