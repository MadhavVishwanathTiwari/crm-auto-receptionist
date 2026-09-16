import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { POST as ingestDemos } from "@/app/api/v1/demos/route";
import { GET as pendingDemos } from "@/app/api/v1/demos/pending/route";

import { adminClient, cleanup, createTestOrg } from "../setup/stack";

// The contract the Auto-Receptionist repo replaces its Google Sheet with.
//
// Two properties matter more than the happy path, and both are asserted below:
//
//   * The demo columns cannot be written except through record_demo(). The
//     guard in 0004 binds the service role too, so a route that "just updates
//     the row" fails at runtime rather than at review, and only a test that
//     tries the direct write proves the RPC is doing the work.
//   * A demo whose domain matches nothing is parked, never dropped. Somebody
//     paid a model to build it.
//
// Every call is scoped with ?org= where the route supports it, and every
// fixture lives in an org this file creates, so running against the SHARED
// cloud project cannot touch a real lead.

const INGEST_SECRET = process.env.AR_INGEST_SECRET ?? "";

const orgIds: string[] = [];
let orgId: string;

function admin() {
  return adminClient();
}

function post(body: unknown, secret = INGEST_SECRET, query = ""): Request {
  return new Request(`http://localhost/api/v1/demos${query}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${secret}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

function get(query: string, secret = INGEST_SECRET): Request {
  return new Request(`http://localhost/api/v1/demos/pending${query}`, {
    headers: { Authorization: `Bearer ${secret}` },
  });
}

/** A qualified lead with a website and no demo: exactly what /pending returns. */
async function makeLead(
  overrides: Record<string, unknown> = {},
): Promise<{ id: string; domain: string; website: string }> {
  const domain = `${randomUUID().slice(0, 8)}.prospect.test`;
  const website = `https://www.${domain}/contact`;

  const { data, error } = await admin()
    .from("leads")
    .insert({
      org_id: orgId,
      company_name: "Az Perfect Comfort",
      work_email: `owner-${randomUUID().slice(0, 8)}@prospect.test`,
      website,
      rating: 4.6,
      timezone: "America/Phoenix",
      timezone_source: "import",
      ...overrides,
    })
    .select("id, website, website_domain")
    .single();
  if (error) throw new Error(`lead: ${error.message}`);

  // The generated column is what the route joins on, so assert the two agree
  // rather than assuming this repo's normalizer and the SQL one still match.
  // Skipped when a case deliberately overrides the website away.
  if (data.website === website) expect(data.website_domain).toBe(domain);

  return { id: data.id as string, domain, website };
}

beforeAll(async () => {
  if (!INGEST_SECRET) throw new Error("AR_INGEST_SECRET is not set in .env");
  const org = await createTestOrg("demo-ingest");
  orgIds.push(org.id);
  orgId = org.id;
});

afterAll(async () => {
  await cleanup(orgIds, []);
});

describe("the demo ingest API", () => {
  it("refuses a wrong secret", async () => {
    const response = await ingestDemos(post({ slug: "nope" }, "not-the-secret"));
    expect(response.status).toBe(401);
  });

  it("refuses a payload with no slug", async () => {
    const response = await ingestDemos(post({ website: "https://example.com" }));
    expect(response.status).toBe(422);
  });

  it("records a demo onto the lead it matches by domain", async () => {
    const lead = await makeLead();

    const response = await ingestDemos(
      post({
        website: lead.website,
        slug: "az-perfect-comfort",
        demo_txt_url: "https://autoreceptionist.io/sandbox/az-perfect-comfort",
        // Their state-and-city zone. Accepted, recorded, never applied.
        timezone: "America/Denver",
      }),
    );
    expect(response.status).toBe(200);

    const body = (await response.json()) as {
      recorded: number;
      results: { matched_on: string | null; lead_id: string | null }[];
    };
    expect(body.recorded).toBe(1);
    expect(body.results[0]!.matched_on).toBe("domain");
    expect(body.results[0]!.lead_id).toBe(lead.id);

    const { data: row } = await admin()
      .from("leads")
      .select("demo_slug, demo_txt_url, demo_ready_at, timezone")
      .eq("id", lead.id)
      .single();

    expect(row!.demo_slug).toBe("az-perfect-comfort");
    expect(row!.demo_ready_at).not.toBeNull();
    // The zone they reported is Denver; Phoenix does not observe DST and the
    // two diverge for eight months of the year. Ours must survive the ingest.
    expect(row!.timezone).toBe("America/Phoenix");

    const { data: events } = await admin()
      .from("lead_events")
      .select("type, dedupe_token, payload")
      .eq("lead_id", lead.id)
      .eq("type", "demo_ready");
    expect(events).toHaveLength(1);
    expect(events![0]!.dedupe_token).toBe("az-perfect-comfort");
    expect(
      (events![0]!.payload as { reported_timezone?: string }).reported_timezone,
    ).toBe("America/Denver");
  });

  it("is idempotent: a re-post does not move demo_ready_at", async () => {
    const lead = await makeLead();
    const payload = {
      website: lead.website,
      slug: `rebuild-${randomUUID().slice(0, 6)}`,
    };

    await ingestDemos(post(payload));
    const { data: first } = await admin()
      .from("leads")
      .select("demo_ready_at")
      .eq("id", lead.id)
      .single();

    await ingestDemos(post(payload));
    const { data: second } = await admin()
      .from("leads")
      .select("demo_ready_at")
      .eq("id", lead.id)
      .single();

    // demo_ready_at gates T2. Bumping it on every re-run would keep moving the
    // moment the demo "arrived" and, with it, nothing at all: the send is
    // already planned. It would still be a lie in the timeline.
    expect(second!.demo_ready_at).toBe(first!.demo_ready_at);

    const { data: events } = await admin()
      .from("lead_events")
      .select("id")
      .eq("lead_id", lead.id)
      .eq("type", "demo_ready");
    expect(events).toHaveLength(1);
  });

  it("derives the sandbox URL when the caller sends only a slug", async () => {
    const lead = await makeLead();
    await ingestDemos(post({ website: lead.website, slug: "island-breeze" }));

    const { data: row } = await admin()
      .from("leads")
      .select("demo_txt_url")
      .eq("id", lead.id)
      .single();
    expect(row!.demo_txt_url).toBe(
      "https://autoreceptionist.io/sandbox/island-breeze",
    );
  });

  it("parks a demo that matches no lead instead of dropping it", async () => {
    const slug = `orphan-${randomUUID().slice(0, 8)}`;
    const response = await ingestDemos(
      post({ website: "https://nobody-here.invalid", slug }),
    );

    const body = (await response.json()) as { orphaned: number };
    expect(body.orphaned).toBe(1);

    const { data: alerts } = await admin()
      .from("alerts")
      .select("kind, payload")
      .eq("kind", "orphan_demo")
      .eq("dedupe_token", slug);
    expect(alerts).toHaveLength(1);
  });

  it("still refuses a direct write to the demo columns", async () => {
    const lead = await makeLead();

    // The service role, straight at the row. If this ever succeeds, the guard
    // has been weakened and the ingest API is no longer the only writer.
    const { error } = await admin()
      .from("leads")
      .update({ demo_txt_url: "https://evil.example/sandbox/whatever" })
      .eq("id", lead.id);

    expect(error).not.toBeNull();
    expect(error!.message).toContain("demo URLs are written by the demo ingest API");
  });
});

describe("GET /api/v1/demos/pending", () => {
  it("refuses a wrong secret", async () => {
    const response = await pendingDemos(get(`?org=${orgId}`, "not-the-secret"));
    expect(response.status).toBe(401);
  });

  it("returns qualified leads with a website and no demo yet", async () => {
    const lead = await makeLead();

    const response = await pendingDemos(get(`?org=${orgId}&limit=100`));
    const body = (await response.json()) as {
      leads: { lead_id: string; website: string; domain: string }[];
    };

    const found = body.leads.find((row) => row.lead_id === lead.id);
    expect(found).toBeDefined();
    expect(found!.website).toBe(lead.website);
    expect(found!.domain).toBe(lead.domain);
  });

  it("drops a lead once its demo lands", async () => {
    const lead = await makeLead();
    await ingestDemos(post({ website: lead.website, slug: `built-${randomUUID().slice(0, 6)}` }));

    const response = await pendingDemos(get(`?org=${orgId}&limit=100`));
    const body = (await response.json()) as { leads: { lead_id: string }[] };
    expect(body.leads.some((row) => row.lead_id === lead.id)).toBe(false);
  });

  it("does not offer an unqualified lead, or one with no website", async () => {
    // No work email fails the generated is_qualified gate. Since 0031 that is
    // the whole gate: a low rating, or none at all, no longer disqualifies.
    const unqualified = await makeLead({ work_email: null });
    const noSite = await makeLead({ website: null });

    const response = await pendingDemos(get(`?org=${orgId}&limit=100`));
    const body = (await response.json()) as { leads: { lead_id: string }[] };
    const ids = body.leads.map((row) => row.lead_id);

    expect(ids).not.toContain(unqualified.id);
    expect(ids).not.toContain(noSite.id);
  });

  it("does not offer a suppressed domain", async () => {
    const lead = await makeLead();
    const { error } = await admin().from("suppressions").insert({
      org_id: orgId,
      domain: lead.domain,
      reason: "unsubscribed",
      lead_id: lead.id,
    });
    expect(error).toBeNull();

    const response = await pendingDemos(get(`?org=${orgId}&limit=100`));
    const body = (await response.json()) as { leads: { lead_id: string }[] };
    expect(body.leads.some((row) => row.lead_id === lead.id)).toBe(false);
  });
});

describe("dry runs and refused builds", () => {
  it("a dry run matches but writes nothing, not even an orphan alert", async () => {
    const lead = await makeLead();
    const orphanSlug = `dry-orphan-${randomUUID().slice(0, 8)}`;

    const response = await ingestDemos(
      post(
        {
          demos: [
            { website: lead.website, slug: `dry-${randomUUID().slice(0, 6)}` },
            { website: "https://nobody-here.invalid", slug: orphanSlug },
          ],
        },
        INGEST_SECRET,
        "?dry_run=1",
      ),
    );
    expect(response.status).toBe(200);

    const body = (await response.json()) as {
      dry_run: boolean;
      recorded: number;
      results: { status: string; lead_id: string | null; lead_status?: string }[];
    };
    expect(body.dry_run).toBe(true);
    expect(body.recorded).toBe(0);
    expect(body.results.map((r) => r.status)).toEqual(["would_record", "would_orphan"]);
    expect(body.results[0]!.lead_id).toBe(lead.id);
    expect(body.results[0]!.lead_status).toBe("imported");

    // Re-read as admin: a 200 proves nothing about what did not happen.
    const { data: row } = await admin()
      .from("leads")
      .select("demo_slug, demo_ready_at")
      .eq("id", lead.id)
      .single();
    expect(row!.demo_slug).toBeNull();
    expect(row!.demo_ready_at).toBeNull();

    const { data: events } = await admin()
      .from("lead_events")
      .select("id")
      .eq("lead_id", lead.id)
      .eq("type", "demo_ready");
    expect(events).toHaveLength(0);

    const { data: alerts } = await admin()
      .from("alerts")
      .select("id")
      .eq("kind", "orphan_demo")
      .eq("dedupe_token", orphanSlug);
    expect(alerts).toHaveLength(0);
  });

  it("records a refused build once per day and moves no status", async () => {
    const lead = await makeLead();
    const failure = { lead_id: lead.id, reason: "missing essential fact(s): phone", stage: "verify" };

    const first = await ingestDemos(post({ failures: [failure] }));
    expect(first.status).toBe(200);
    const firstBody = (await first.json()) as { failures_recorded: number };
    expect(firstBody.failures_recorded).toBe(1);

    // The builder re-runs by hand as often as anyone likes.
    const second = await ingestDemos(post({ failures: [failure] }));
    const secondBody = (await second.json()) as {
      failures_recorded: number;
      failure_results: { status: string }[];
    };
    expect(secondBody.failures_recorded).toBe(0);
    expect(secondBody.failure_results[0]!.status).toBe("already_recorded");

    const { data: events } = await admin()
      .from("lead_events")
      .select("payload")
      .eq("lead_id", lead.id)
      .eq("type", "demo_failed");
    expect(events).toHaveLength(1);
    expect((events![0]!.payload as { reason: string }).reason).toBe(failure.reason);

    const { data: row } = await admin()
      .from("leads")
      .select("status, demo_ready_at")
      .eq("id", lead.id)
      .single();
    expect(row!.status).toBe("imported");
    expect(row!.demo_ready_at).toBeNull();
  });

  it("reports a failure for a lead that does not exist, without inventing one", async () => {
    const response = await ingestDemos(
      post({ failures: [{ lead_id: randomUUID(), reason: "scrape blocked" }] }),
    );
    // Everything in the batch failed, so the batch did.
    expect(response.status).toBe(502);
    const body = (await response.json()) as { failure_results: { status: string }[] };
    expect(body.failure_results[0]!.status).toBe("failed");
  });
});

describe("GET /api/v1/demos/pending, as the builder's only queue", () => {
  async function pendingIds(): Promise<string[]> {
    const response = await pendingDemos(get(`?org=${orgId}&limit=500`));
    expect(response.status).toBe(200);
    const body = (await response.json()) as { leads: { lead_id: string }[] };
    return body.leads.map((row) => row.lead_id);
  }

  async function failedAgo(leadId: string, days: number) {
    const { error } = await admin()
      .from("lead_events")
      .insert({
        org_id: orgId,
        lead_id: leadId,
        type: "demo_failed",
        occurred_at: new Date(Date.now() - days * 86_400_000).toISOString(),
        payload: { reason: "no timezone could be resolved" },
        dedupe_token: `test:${randomUUID()}`,
      });
    expect(error).toBeNull();
  }

  it("hands over the Maps facts and the zone the builder falls back on", async () => {
    const lead = await makeLead({ phone: "+1 480 555 0142", city: "Mesa", state: "AZ" });

    const response = await pendingDemos(get(`?org=${orgId}&limit=500`));
    const body = (await response.json()) as {
      leads: {
        lead_id: string;
        phone: string | null;
        timezone: string | null;
        timezone_source: string | null;
        city: string | null;
      }[];
    };
    const found = body.leads.find((row) => row.lead_id === lead.id);
    expect(found).toMatchObject({
      phone: "+1 480 555 0142",
      timezone: "America/Phoenix",
      timezone_source: "import",
      city: "Mesa",
    });
  });

  it("builds for an unverified address but not an invalid one", async () => {
    const unknown = await makeLead({ verification: "unknown" });
    const invalid = await makeLead({ verification: "invalid" });

    const ids = await pendingIds();
    expect(ids).toContain(unknown.id);
    expect(ids).not.toContain(invalid.id);
  });

  it("rests a lead for a week after a refused build", async () => {
    const recent = await makeLead();
    const old = await makeLead();
    await failedAgo(recent.id, 2);
    await failedAgo(old.id, 8);

    const ids = await pendingIds();
    expect(ids).not.toContain(recent.id);
    expect(ids).toContain(old.id);
  });

  it("puts a lead whose T1 is out ahead of an older untouched one", async () => {
    const untouched = await makeLead();
    const contacted = await makeLead();

    // Status is derived: the event is what makes the lead `sent`.
    const { error } = await admin().from("lead_events").insert({
      org_id: orgId,
      lead_id: contacted.id,
      type: "sent",
      dedupe_token: `test:${randomUUID()}`,
    });
    expect(error).toBeNull();

    const ids = await pendingIds();
    expect(ids.indexOf(contacted.id)).toBeGreaterThanOrEqual(0);
    expect(ids.indexOf(contacted.id)).toBeLessThan(ids.indexOf(untouched.id));
  });
});
