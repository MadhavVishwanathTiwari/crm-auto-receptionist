import { randomUUID } from "node:crypto";

import { DateTime } from "luxon";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// The model and the website fetch are the only things faked. The candidate
// scan, the claim, the daily count under the advisory lock, the planner
// booking a send-mode row, attach_ai_draft and RLS are the real thing.
const fake = vi.hoisted(() => ({
  calls: 0,
  reads: 0,
  site: { ok: true, url: "https://bright.example.test/", text: "Bright Smile Plumbing. 24/7 emergency service across Austin. Call us any time." } as
    | { ok: true; url: string; text: string }
    | { ok: false; reason: string },
  result: {
    kind: "written",
    subject: "your 24/7 line in austin",
    body: "Saw that Bright Smile promises 24/7 emergency service across Austin.\n\nWhen the crew is on a job, those calls go unanswered and the customer is going elsewhere.\n\nWorth a look, or is the phone covered?\n\nMadhav",
    reason: "They lead with 24/7 emergency service.",
    model: "openai/gpt-6-sol",
    inputTokens: 2000,
    outputTokens: 150,
  } as Record<string, unknown>,
}));

vi.mock("@/lib/ai/client", () => ({
  REPLY_MODEL: "openai/gpt-6-sol",
  modelIsConfigured: () => true,
  getModelClient: () => {
    throw new Error("the model client must never be reached in a test");
  },
}));

vi.mock("@/lib/ai/outbound/website", () => ({
  readWebsite: vi.fn(async () => {
    fake.reads += 1;
    return fake.site;
  }),
}));

vi.mock("@/lib/ai/outbound/write", () => ({
  writeFirstTouch: vi.fn(async () => {
    fake.calls += 1;
    return fake.result;
  }),
}));

import { POST as aiOutbound } from "@/app/api/cron/ai-outbound/route";
import { POST as planSends } from "@/app/api/cron/plan-sends/route";

import {
  addMember,
  adminClient,
  anonClient,
  cleanup,
  createTestOrg,
  createTestUser,
  type TestUser,
} from "../setup/stack";

// Every route call is ?org= scoped so a run never touches an org this file
// did not create. Negative writes re-read as a privileged client: a write
// denied by RLS is 204 with zero rows and no error.

const CRON_SECRET = process.env.CRON_SECRET ?? "";
const WRITTEN = { ...fake.result };

const orgIds: string[] = [];
const userIds: string[] = [];

function admin() {
  return adminClient();
}

function cron(path: string, orgId: string) {
  return new Request(`http://localhost/api/cron/${path}?org=${orgId}`, {
    method: "POST",
    headers: { authorization: `Bearer ${CRON_SECRET}` },
  });
}

async function run(orgId: string) {
  const response = await aiOutbound(cron("ai-outbound", orgId));
  expect(response.status).toBe(200);
  const json = (await response.json()) as { reports: Record<string, unknown>[] };
  return json.reports[0]!;
}

/** An org with its own two operators: a user belongs to one org only. */
async function makeOrg(settings: Record<string, unknown> = {}) {
  const org = await createTestOrg("ai-outbound");
  orgIds.push(org.id);
  const owner: TestUser = await createTestUser("outbound-owner");
  const stranger: TestUser = await createTestUser("outbound-stranger");
  userIds.push(owner.id, stranger.id);
  await addMember(org.id, owner.id, "admin");
  await addMember(org.id, stranger.id, "member");

  const { data: mailbox, error: mailboxError } = await admin()
    .from("mailboxes")
    .insert({
      org_id: org.id,
      user_id: owner.id,
      email: `madhav-${randomUUID().slice(0, 8)}@example.test`,
      display_name: "Madhav",
      timezone: "Asia/Kolkata",
      daily_cap: 20,
    })
    .select("id")
    .single();
  if (mailboxError) throw new Error(`mailbox: ${mailboxError.message}`);

  const { error } = await admin()
    .from("org_settings")
    .update({
      dry_run: true,
      ai_outbound_mode: "draft",
      ai_outbound_daily: 5,
      ai_outbound_mailbox_id: mailbox.id,
      ...settings,
    })
    .eq("org_id", org.id);
  if (error) throw new Error(`settings: ${error.message}`);

  return { orgId: org.id, mailboxId: mailbox.id as string, owner, stranger };
}

async function makeLead(orgId: string, overrides: Record<string, unknown> = {}) {
  const { data, error } = await admin()
    .from("leads")
    .insert({
      org_id: orgId,
      company_name: "Bright Smile Plumbing",
      work_email: `office-${randomUUID().slice(0, 8)}@prospect.test`,
      website: `https://${randomUUID().slice(0, 8)}.prospect.test`,
      rating: 4.6,
      timezone: "America/Chicago",
      timezone_source: "import",
      ...overrides,
    })
    .select("id, work_email")
    .single();
  if (error) throw new Error(`lead: ${error.message}`);
  return data as { id: string; work_email: string };
}

async function outboundRows(orgId: string) {
  const { data } = await admin()
    .from("ai_outbound")
    .select("lead_id, outcome, owner_id, subject, body, scheduled_send_id, edited")
    .eq("org_id", orgId);
  return data ?? [];
}

async function leadRow(id: string) {
  const { data } = await admin()
    .from("leads")
    .select("claimed_by, status")
    .eq("id", id)
    .single();
  return data!;
}

beforeAll(() => {
  if (!CRON_SECRET) throw new Error("CRON_SECRET must be set in .env for these tests.");
});

afterAll(async () => {
  await cleanup(orgIds, userIds);
}, 120_000);

beforeEach(() => {
  fake.calls = 0;
  fake.reads = 0;
  fake.site = { ok: true, url: "https://bright.example.test/", text: "x".repeat(200) };
  fake.result = { ...WRITTEN };
});

describe("ai-outbound", () => {
  it("does nothing at all while the mode is off", async () => {
    const { orgId } = await makeOrg({ ai_outbound_mode: "off" });
    const lead = await makeLead(orgId);

    await run(orgId);

    expect(fake.reads).toBe(0);
    expect(fake.calls).toBe(0);
    expect(await outboundRows(orgId)).toEqual([]);
    expect((await leadRow(lead.id)).claimed_by).toBeNull();
  }, 60_000);

  it("in draft mode, claims the lead for the mailbox owner and books nothing", async () => {
    const { orgId, owner } = await makeOrg();
    const lead = await makeLead(orgId);

    const report = await run(orgId);
    expect(report.written).toBe(1);

    const rows = await outboundRows(orgId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      lead_id: lead.id,
      outcome: "drafted",
      owner_id: owner.id,
      subject: WRITTEN.subject,
      scheduled_send_id: null,
    });

    const after = await leadRow(lead.id);
    expect(after.claimed_by).toBe(owner.id);
    expect(after.status).toBe("claimed");

    const { data: sends } = await admin().from("scheduled_sends").select("id").eq("lead_id", lead.id);
    expect(sends ?? []).toEqual([]);

    const { data: events } = await admin()
      .from("lead_events")
      .select("type, actor_id, payload")
      .eq("lead_id", lead.id)
      .eq("type", "claimed");
    expect(events).toHaveLength(1);
    expect(events![0]!.actor_id).toBe(owner.id);
    expect((events![0]!.payload as { source: string }).source).toBe("ai_outbound");
  }, 60_000);

  it("in send mode, hands a blocked written row to the planner, which books it", async () => {
    const { orgId, mailboxId } = await makeOrg({ ai_outbound_mode: "send" });
    const lead = await makeLead(orgId);

    await run(orgId);

    const { data: blocked } = await admin()
      .from("scheduled_sends")
      .select("id, status, step_number, composed_body, composed_by, ai_outbound_id, mailbox_id")
      .eq("lead_id", lead.id);
    expect(blocked).toHaveLength(1);
    expect(blocked![0]).toMatchObject({
      status: "blocked",
      step_number: 1,
      composed_body: WRITTEN.body,
      // Nobody wrote it, so nobody is credited with it.
      composed_by: null,
      mailbox_id: mailboxId,
    });
    expect(blocked![0]!.ai_outbound_id).not.toBeNull();
    expect((await leadRow(lead.id)).status).toBe("queued");

    const planned = await planSends(cron("plan-sends", orgId));
    expect(planned.status).toBe(200);

    const { data: booked } = await admin()
      .from("scheduled_sends")
      .select("status, composed_body, scheduled_at")
      .eq("lead_id", lead.id)
      .single();
    expect(booked!.status).toBe("planned");
    expect(booked!.composed_body).toBe(WRITTEN.body);
    expect(DateTime.fromISO(booked!.scheduled_at as string) > DateTime.now()).toBe(true);
  }, 90_000);

  it("stops at the daily number, and a second run spends nothing", async () => {
    const { orgId } = await makeOrg({ ai_outbound_daily: 1 });
    await makeLead(orgId);
    await makeLead(orgId);

    await run(orgId);
    expect(fake.calls).toBe(1);
    expect((await outboundRows(orgId)).filter((r) => r.outcome === "drafted")).toHaveLength(1);

    const second = await run(orgId);
    expect(second.capped).toBe(true);
    expect(fake.calls).toBe(1);
  }, 60_000);

  it("records a skip, leaves the lead in the pool, and never asks about it again", async () => {
    const { orgId } = await makeOrg();
    const lead = await makeLead(orgId);
    fake.result = {
      kind: "skipped",
      reason: "A labor union. Nobody calls it for a job.",
      model: "openai/gpt-6-sol",
      inputTokens: 900,
      outputTokens: 40,
    };

    await run(orgId);
    await run(orgId);

    expect(fake.calls).toBe(1);
    const rows = await outboundRows(orgId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.outcome).toBe("skipped");
    expect((await leadRow(lead.id)).claimed_by).toBeNull();
  }, 60_000);

  it("does not write blind when the website cannot be read", async () => {
    const { orgId } = await makeOrg();
    const lead = await makeLead(orgId);
    fake.site = { ok: false, reason: "bright.example.test answered 503" };

    await run(orgId);

    expect(fake.calls).toBe(0);
    const rows = await outboundRows(orgId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.outcome).toBe("skipped");
    expect((await leadRow(lead.id)).claimed_by).toBeNull();
  }, 60_000);

  it("leaves claimed and suppressed leads alone", async () => {
    const { orgId, stranger } = await makeOrg();
    await makeLead(orgId, { claimed_by: stranger.id, claimed_at: new Date().toISOString() });
    const suppressed = await makeLead(orgId);
    const { error: suppressionError } = await admin().from("suppressions").insert({
      org_id: orgId,
      email_norm: suppressed.work_email.toLowerCase(),
      reason: "manual_dnc",
    });
    expect(suppressionError).toBeNull();

    await run(orgId);

    expect(fake.reads).toBe(0);
    expect(await outboundRows(orgId)).toEqual([]);
  }, 60_000);

  it("leaves a model outage undecided, so the next run tries again", async () => {
    const { orgId } = await makeOrg();
    const lead = await makeLead(orgId);
    fake.result = { kind: "failed", reason: "could not reach the model API", retryable: true };

    const report = await run(orgId);

    expect(report.error).toMatch(/model API/);
    expect(await outboundRows(orgId)).toEqual([]);
    expect((await leadRow(lead.id)).claimed_by).toBeNull();
  }, 60_000);
});

describe("an operator sends the draft", () => {
  it("records that it started as the assistant's, and that it was edited", async () => {
    const { orgId, mailboxId, owner, stranger } = await makeOrg();
    const lead = await makeLead(orgId);
    await run(orgId);
    const [draft] = await admin().from("ai_outbound").select("id").eq("lead_id", lead.id).then((r) => r.data!);

    const at = DateTime.now().plus({ days: 1 });
    const { data: send, error } = await owner.client.rpc("queue_composed_send", {
      p_lead_id: lead.id,
      p_subject: WRITTEN.subject,
      p_body: `${WRITTEN.body}\n\nP.S. one line of my own.`,
      p_scheduled_at: at.toUTC().toISO(),
      p_scheduled_local: at.setZone("America/Chicago").toFormat("yyyy-MM-dd'T'HH:mm:ss"),
      p_mailbox_id: mailboxId,
      p_step: 1,
    });
    expect(error).toBeNull();
    const sendId = (Array.isArray(send) ? send[0] : send).id as string;

    // Somebody else cannot claim the draft as theirs.
    const { error: strangerError } = await stranger.client.rpc("attach_ai_draft", {
      p_draft_id: draft!.id,
      p_send_id: sendId,
    });
    expect(strangerError).not.toBeNull();
    const [untouched] = await outboundRows(orgId);
    expect(untouched!.scheduled_send_id).toBeNull();

    const { error: attachError } = await owner.client.rpc("attach_ai_draft", {
      p_draft_id: draft!.id,
      p_send_id: sendId,
    });
    expect(attachError).toBeNull();

    const [used] = await outboundRows(orgId);
    expect(used).toMatchObject({ scheduled_send_id: sendId, edited: true });

    const { data: row } = await admin()
      .from("scheduled_sends")
      .select("ai_outbound_id, composed_by")
      .eq("id", sendId)
      .single();
    // They approved it, so it is theirs; and it says where the words began.
    expect(row).toEqual({ ai_outbound_id: draft!.id, composed_by: owner.id });
  }, 90_000);
});

describe("what a browser may not do", () => {
  it("cannot read, write or fabricate the assistant's record", async () => {
    const { orgId, mailboxId, owner } = await makeOrg();
    const lead = await makeLead(orgId);
    await run(orgId);

    const { data: anonRows } = await anonClient().from("ai_outbound").select("id").eq("org_id", orgId);
    expect(anonRows ?? []).toEqual([]);

    const { data: mine } = await owner.client.from("ai_outbound").select("id").eq("org_id", orgId);
    expect(mine).toHaveLength(1);

    await owner.client.from("ai_outbound").update({ body: "rewritten history" }).eq("lead_id", lead.id);
    const [after] = await outboundRows(orgId);
    expect(after!.body).toBe(WRITTEN.body);

    const other = await makeLead(orgId);
    const { error } = await owner.client.rpc("record_ai_outbound", {
      p_org: orgId,
      p_lead_id: other.id,
      p_mailbox_id: mailboxId,
      p_send: true,
      p_subject: "s",
      p_body: "b",
      p_reason: "r",
      p_model: null,
      p_input_tokens: null,
      p_output_tokens: null,
      p_website_chars: 0,
    });
    expect(error).not.toBeNull();
    expect((await leadRow(other.id)).claimed_by).toBeNull();
  }, 60_000);
});
