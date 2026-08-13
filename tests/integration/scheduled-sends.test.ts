import { randomUUID } from "node:crypto";

import { DateTime } from "luxon";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { POST as dispatchSends } from "@/app/api/cron/dispatch-sends/route";
import { POST as planSends } from "@/app/api/cron/plan-sends/route";

import { CLEAN_BODY, CLEAN_SUBJECT } from "../fixtures/template-vectors";
import {
  addMember,
  adminClient,
  cleanup,
  createTestOrg,
  createTestUser,
  type TestUser,
} from "../setup/stack";

// Phase 2's send path, end to end where that is possible without a live Gmail
// grant. The cron routes are imported and called directly rather than mocked:
// they are ordinary functions, and the interesting behaviour (what the claimer
// refuses, what the dispatcher re-checks) lives in them and in the database,
// not in the HTTP layer.
//
// Every route call is scoped with ?org= so a suite running against the SHARED
// cloud project can never plan or dispatch for an org it did not create.
//
// Negative cases re-read as a privileged client. A PostgREST write denied by
// RLS returns 204 with zero rows and NO error, so asserting `error !== null`
// passes vacuously against a completely broken policy.

const CRON_SECRET = process.env.CRON_SECRET ?? "";

/** Two zones 25 hours apart, so their calendar dates ALWAYS differ. */
const MAILBOX_ZONE = "Pacific/Kiritimati"; // UTC+14
const PROSPECT_ZONE = "Pacific/Midway"; // UTC-11

const orgIds: string[] = [];
let operator: TestUser;

function admin() {
  return adminClient();
}

async function makeOrg(label: string, settings: Record<string, unknown> = {}) {
  const org = await createTestOrg(label);
  orgIds.push(org.id);
  const { error } = await admin()
    .from("org_settings")
    .update({ dry_run: false, ...settings })
    .eq("org_id", org.id);
  if (error) throw new Error(`org_settings: ${error.message}`);
  return org;
}

async function makeMailbox(
  orgId: string,
  overrides: Record<string, unknown> = {},
): Promise<string> {
  const { data, error } = await admin()
    .from("mailboxes")
    .insert({
      org_id: orgId,
      user_id: operator.id,
      email: `sender-${randomUUID().slice(0, 8)}@example.test`,
      display_name: "Ojas",
      timezone: "America/New_York",
      daily_cap: 20,
      ...overrides,
    })
    .select("id")
    .single();
  if (error) throw new Error(`mailbox: ${error.message}`);
  return data.id as string;
}

async function makeTemplate(orgId: string, step = 1): Promise<string> {
  const { data, error } = await admin()
    .from("templates")
    .insert({
      org_id: orgId,
      name: `T${step}-${randomUUID().slice(0, 8)}`,
      step_number: step,
      subject: CLEAN_SUBJECT,
      body: CLEAN_BODY,
      is_active: true,
    })
    .select("id")
    .single();
  if (error) throw new Error(`template: ${error.message}`);
  return data.id as string;
}

/** A lead that is claimed, audited, qualified and ready for a first touch. */
async function makeLead(
  orgId: string,
  overrides: Record<string, unknown> = {},
): Promise<{ id: string; email: string }> {
  const email = `owner-${randomUUID().slice(0, 8)}@prospect.test`;

  const { data, error } = await admin()
    .from("leads")
    .insert({
      org_id: orgId,
      company_name: "Bright Smile Dental",
      first_name: "Dana",
      work_email: email,
      website: `https://${randomUUID().slice(0, 8)}.prospect.test`,
      rating: 4.6,
      timezone: "America/Chicago",
      timezone_source: "import",
      // The guard on leads only binds UPDATE, so a fixture may set ownership
      // at insert time without going through claim_lead().
      claimed_by: operator.id,
      claimed_at: new Date().toISOString(),
      ...overrides,
    })
    .select("id")
    .single();
  if (error) throw new Error(`lead: ${error.message}`);

  // Status is derived, never typed. This is what makes it `audited`.
  const { error: eventError } = await admin().from("lead_events").insert({
    org_id: orgId,
    lead_id: data.id,
    type: "audited",
    actor_id: operator.id,
  });
  if (eventError) throw new Error(`audited event: ${eventError.message}`);

  return { id: data.id as string, email };
}

/** A due, claimable send. Inserted directly so the timing is deterministic. */
async function makeDueSend(input: {
  orgId: string;
  leadId: string;
  mailboxId: string;
  templateId: string;
  prospectZone?: string;
  minutesAgo?: number;
}): Promise<string> {
  const zone = input.prospectZone ?? "America/Chicago";
  const at = DateTime.now().minus({ minutes: input.minutesAgo ?? 1 });

  const { data, error } = await admin()
    .from("scheduled_sends")
    .insert({
      org_id: input.orgId,
      lead_id: input.leadId,
      mailbox_id: input.mailboxId,
      template_id: input.templateId,
      step_number: 1,
      touch_kind: "first",
      status: "planned",
      scheduled_at: at.toUTC().toISO(),
      scheduled_local: at.setZone(zone).toFormat("yyyy-MM-dd'T'HH:mm:ss"),
      prospect_timezone: zone,
    })
    .select("id")
    .single();
  if (error) throw new Error(`scheduled_send: ${error.message}`);
  return data.id as string;
}

function cronRequest(path: string, orgId: string) {
  return new Request(`http://localhost/api/cron/${path}?org=${orgId}`, {
    method: "POST",
    headers: { authorization: `Bearer ${CRON_SECRET}` },
  });
}

// ---------------------------------------------------------------------------

beforeAll(async () => {
  if (!CRON_SECRET) {
    throw new Error("CRON_SECRET must be set in .env for these tests.");
  }
  operator = await createTestUser("sends-op");
}, 120_000);

afterAll(async () => {
  await cleanup(orgIds, [operator.id]);
}, 120_000);

// ---------------------------------------------------------------------------

describe("planning", () => {
  it("never plans a lead with no timezone", async () => {
    const org = await makeOrg("plan-tz");
    await makeMailbox(org.id);
    await makeTemplate(org.id);

    const resolvable = await makeLead(org.id);
    const unresolvable = await makeLead(org.id, {
      timezone: null,
      timezone_source: null,
    });

    const response = await planSends(cronRequest("plan-sends", org.id));
    expect(response.status).toBe(200);

    const { data: sends } = await admin()
      .from("scheduled_sends")
      .select("id, lead_id, status, prospect_timezone")
      .eq("org_id", org.id);

    const planned = (sends ?? []).filter((s) => s.lead_id === resolvable.id);
    expect(planned).toHaveLength(1);
    expect(planned[0]!.status).toBe("planned");
    expect(planned[0]!.prospect_timezone).toBe("America/Chicago");

    // The one the planner must never touch. There is no state-to-zone fallback
    // anywhere in this system, so an unresolved lead simply waits for a human.
    expect((sends ?? []).filter((s) => s.lead_id === unresolvable.id)).toHaveLength(0);
  }, 180_000);

  it("refuses a send for a lead with no timezone even from the service role", async () => {
    const org = await makeOrg("plan-tz-guard");
    const mailboxId = await makeMailbox(org.id);
    const templateId = await makeTemplate(org.id);
    const lead = await makeLead(org.id, { timezone: null, timezone_source: null });

    const at = DateTime.now();
    const { error } = await admin()
      .from("scheduled_sends")
      .insert({
        org_id: org.id,
        lead_id: lead.id,
        mailbox_id: mailboxId,
        template_id: templateId,
        step_number: 1,
        touch_kind: "first",
        scheduled_at: at.toUTC().toISO(),
        scheduled_local: at.toFormat("yyyy-MM-dd'T'HH:mm:ss"),
        prospect_timezone: "America/Chicago",
      })
      .select("id");

    expect(error).not.toBeNull();

    const { data: after } = await admin()
      .from("scheduled_sends")
      .select("id")
      .eq("lead_id", lead.id);
    expect(after ?? []).toHaveLength(0);
  }, 180_000);

  it("plans inside the prospect-local window, on an allowed weekday", async () => {
    const org = await makeOrg("plan-window");
    await makeMailbox(org.id);
    await makeTemplate(org.id);
    await makeLead(org.id, { timezone: "America/Los_Angeles" });

    await planSends(cronRequest("plan-sends", org.id));

    const { data: sends } = await admin()
      .from("scheduled_sends")
      .select("scheduled_at, scheduled_local, prospect_timezone, touch_kind, step_number")
      .eq("org_id", org.id);

    expect(sends).toHaveLength(1);
    const send = sends![0]!;
    expect(send.step_number).toBe(1);
    expect(send.touch_kind).toBe("first");

    const local = DateTime.fromISO(send.scheduled_local as string);
    // 07:00-11:00 and 13:00-16:00, ends exclusive.
    const minute = local.hour * 60 + local.minute;
    const inMorning = minute >= 7 * 60 && minute < 11 * 60;
    const inAfternoon = minute >= 13 * 60 && minute < 16 * 60;
    expect(inMorning || inAfternoon).toBe(true);

    // Tue/Wed/Thu for a first touch, from org_settings rather than hardcoded.
    expect([2, 3, 4]).toContain(local.weekday);

    // The stored instant really is that wall clock in the prospect's zone.
    const instant = DateTime.fromISO(send.scheduled_at as string).setZone(
      send.prospect_timezone as string,
    );
    expect(instant.toFormat("yyyy-MM-dd'T'HH:mm:ss")).toBe(send.scheduled_local);
  }, 180_000);
});

describe("claiming", () => {
  it("counts caps in the mailbox timezone, not the prospect's", async () => {
    // The two zones are 25 hours apart, so their dates never coincide. If the
    // cap were counted in the prospect's day, cap_date would come back as the
    // other date and this test would say so.
    const org = await makeOrg("cap-zone");
    const mailboxId = await makeMailbox(org.id, {
      timezone: MAILBOX_ZONE,
      daily_cap: 1,
    });
    const templateId = await makeTemplate(org.id);

    for (let i = 0; i < 2; i++) {
      const lead = await makeLead(org.id, { timezone: PROSPECT_ZONE });
      await makeDueSend({
        orgId: org.id,
        leadId: lead.id,
        mailboxId,
        templateId,
        prospectZone: PROSPECT_ZONE,
      });
    }

    const { data: claimed, error } = await admin().rpc("claim_due_sends", {
      p_org_id: org.id,
      p_limit: 10,
    });

    expect(error).toBeNull();
    expect(claimed).toHaveLength(1);

    const mailboxToday = DateTime.now().setZone(MAILBOX_ZONE).toISODate();
    const prospectToday = DateTime.now().setZone(PROSPECT_ZONE).toISODate();
    expect(mailboxToday).not.toBe(prospectToday);

    expect(claimed![0]!.cap_date).toBe(mailboxToday);
    expect(claimed![0]!.cap_date).not.toBe(prospectToday);

    // And the cap really is spent: a second call gets nothing.
    const { data: second } = await admin().rpc("claim_due_sends", {
      p_org_id: org.id,
      p_limit: 10,
    });
    expect(second).toHaveLength(0);
  }, 180_000);

  it("hands two concurrent callers disjoint sets", async () => {
    const org = await makeOrg("claim-race");
    const mailboxId = await makeMailbox(org.id, { daily_cap: 20 });
    const templateId = await makeTemplate(org.id);

    for (let i = 0; i < 6; i++) {
      const lead = await makeLead(org.id);
      await makeDueSend({ orgId: org.id, leadId: lead.id, mailboxId, templateId });
    }

    const [first, second] = await Promise.all([
      admin().rpc("claim_due_sends", { p_org_id: org.id, p_limit: 3 }),
      admin().rpc("claim_due_sends", { p_org_id: org.id, p_limit: 3 }),
    ]);

    expect(first.error).toBeNull();
    expect(second.error).toBeNull();

    const firstIds = new Set((first.data ?? []).map((s: { id: string }) => s.id));
    const secondIds = new Set((second.data ?? []).map((s: { id: string }) => s.id));

    // SKIP LOCKED is what makes this disjoint; the advisory lock is what keeps
    // the two of them from both reading the same remaining capacity.
    for (const id of firstIds) expect(secondIds.has(id)).toBe(false);
    expect(firstIds.size + secondIds.size).toBe(6);

    const { data: stillPlanned } = await admin()
      .from("scheduled_sends")
      .select("id")
      .eq("org_id", org.id)
      .eq("status", "planned");
    expect(stillPlanned ?? []).toHaveLength(0);
  }, 180_000);

  it("returns nothing at all while dry_run is on", async () => {
    const org = await makeOrg("dry-run", { dry_run: true });
    const mailboxId = await makeMailbox(org.id);
    const templateId = await makeTemplate(org.id);
    const lead = await makeLead(org.id);
    const sendId = await makeDueSend({
      orgId: org.id,
      leadId: lead.id,
      mailboxId,
      templateId,
    });

    const { data: claimed, error } = await admin().rpc("claim_due_sends", {
      p_org_id: org.id,
      p_limit: 10,
    });

    expect(error).toBeNull();
    expect(claimed).toHaveLength(0);

    // Untouched, not merely unreturned.
    const { data: after } = await admin()
      .from("scheduled_sends")
      .select("status, claimed_at")
      .eq("id", sendId)
      .single();
    expect(after?.status).toBe("planned");
    expect(after?.claimed_at).toBeNull();
  }, 180_000);

  it("cannot see a send that missed its slot", async () => {
    // Past slot_grace_minutes the send is invisible to the claimer and gets
    // re-planned instead of firing hours outside the window it was chosen for.
    const org = await makeOrg("grace", { slot_grace_minutes: 20 });
    const mailboxId = await makeMailbox(org.id);
    const templateId = await makeTemplate(org.id);
    const lead = await makeLead(org.id);
    const sendId = await makeDueSend({
      orgId: org.id,
      leadId: lead.id,
      mailboxId,
      templateId,
      minutesAgo: 120,
    });

    const { data: claimed } = await admin().rpc("claim_due_sends", {
      p_org_id: org.id,
      p_limit: 10,
    });
    expect(claimed).toHaveLength(0);

    // The planner rolls it forward rather than leaving it stranded.
    await planSends(cronRequest("plan-sends", org.id));

    const { data: after } = await admin()
      .from("scheduled_sends")
      .select("status, scheduled_at, plan_attempt")
      .eq("id", sendId)
      .single();

    expect(after?.status).toBe("planned");
    expect(after?.plan_attempt).toBe(1);
    expect(DateTime.fromISO(after!.scheduled_at as string) > DateTime.now()).toBe(true);
  }, 180_000);

  it("skips a lead that replied after its send was booked", async () => {
    const org = await makeOrg("halted");
    const mailboxId = await makeMailbox(org.id);
    const templateId = await makeTemplate(org.id);
    const lead = await makeLead(org.id);
    await makeDueSend({ orgId: org.id, leadId: lead.id, mailboxId, templateId });

    await admin().from("lead_events").insert({
      org_id: org.id,
      lead_id: lead.id,
      type: "replied",
      dedupe_token: `reply-${randomUUID()}`,
    });

    const { data: claimed } = await admin().rpc("claim_due_sends", {
      p_org_id: org.id,
      p_limit: 10,
    });
    expect(claimed).toHaveLength(0);
  }, 180_000);
});

describe("dispatch", () => {
  it("skips a suppressed lead instead of emailing it", async () => {
    const org = await makeOrg("dispatch-suppressed");
    const mailboxId = await makeMailbox(org.id);
    const templateId = await makeTemplate(org.id);
    const lead = await makeLead(org.id);
    const sendId = await makeDueSend({
      orgId: org.id,
      leadId: lead.id,
      mailboxId,
      templateId,
    });

    // Added AFTER the send was booked, which is the whole reason suppressions
    // are re-checked immediately before the send rather than at plan time.
    const { data: leadRow } = await admin()
      .from("leads")
      .select("work_email_norm")
      .eq("id", lead.id)
      .single();

    const { error: suppressionError } = await admin().from("suppressions").insert({
      org_id: org.id,
      email_norm: leadRow!.work_email_norm,
      reason: "manual_dnc",
      lead_id: lead.id,
    });
    expect(suppressionError).toBeNull();

    const response = await dispatchSends(cronRequest("dispatch-sends", org.id));
    expect(response.status).toBe(200);

    const { data: after } = await admin()
      .from("scheduled_sends")
      .select("status, outcome_reason, provider_message_id")
      .eq("id", sendId)
      .single();

    expect(after?.status).toBe("skipped");
    expect(after?.outcome_reason).toContain("do-not-contact");
    expect(after?.provider_message_id).toBeNull();

    // Nothing was logged as sent, so the lead never advanced.
    const { data: events } = await admin()
      .from("lead_events")
      .select("type")
      .eq("lead_id", lead.id);
    expect((events ?? []).some((e) => e.type === "sent")).toBe(false);

    const { data: leadAfter } = await admin()
      .from("leads")
      .select("status")
      .eq("id", lead.id)
      .single();
    expect(leadAfter?.status).toBe("audited");
  }, 180_000);
});

describe("inbound events", () => {
  it("does not produce a second event for a redelivered notification", async () => {
    const org = await makeOrg("redelivery");
    const lead = await makeLead(org.id);
    const gmailMessageId = `gmail-${randomUUID()}`;

    const row = {
      org_id: org.id,
      lead_id: lead.id,
      type: "replied",
      actor_id: null,
      payload: { gmail_message_id: gmailMessageId },
      dedupe_token: gmailMessageId,
    };

    // The exact call the poller makes, twice. Gmail's history pages overlap and
    // a re-run after a crash replays them.
    for (let i = 0; i < 2; i++) {
      const { error } = await admin()
        .from("lead_events")
        .upsert(row, {
          onConflict: "lead_id,type,dedupe_token",
          ignoreDuplicates: true,
        });
      expect(error).toBeNull();
    }

    const { data: events } = await admin()
      .from("lead_events")
      .select("id")
      .eq("lead_id", lead.id)
      .eq("type", "replied");

    expect(events).toHaveLength(1);

    // And the one event did its job: status is derived, and a reply halts.
    const { data: leadAfter } = await admin()
      .from("leads")
      .select("status, halted_at, halt_reason")
      .eq("id", lead.id)
      .single();

    expect(leadAfter?.status).toBe("replied");
    expect(leadAfter?.halted_at).not.toBeNull();
    expect(leadAfter?.halt_reason).toBe("replied");
  }, 180_000);
});

describe("what a browser may not do", () => {
  it("never lets a member read a refresh token", async () => {
    const org = await makeOrg("secrets");
    const member = await createTestUser("secrets-member");
    await addMember(org.id, member.id, "member");
    const mailboxId = await makeMailbox(org.id);

    const { error: secretError } = await admin().from("mailbox_secrets").insert({
      mailbox_id: mailboxId,
      refresh_token: "1//super-secret-refresh-token",
      scope: "https://www.googleapis.com/auth/gmail.send",
    });
    expect(secretError).toBeNull();

    // RLS is on with no policies at all, and the table grants are revoked
    // outright, so this is denied at the privilege level rather than filtered.
    const { data, error } = await member.client
      .from("mailbox_secrets")
      .select("refresh_token");

    expect(data ?? []).toHaveLength(0);
    expect(error).not.toBeNull();

    await cleanup([], [member.id]);
  }, 180_000);

  it("never lets a member fabricate a sent send", async () => {
    const org = await makeOrg("fabricate");
    const member = await createTestUser("fabricate-member");
    await addMember(org.id, member.id, "member");
    const mailboxId = await makeMailbox(org.id);
    const templateId = await makeTemplate(org.id);
    const lead = await makeLead(org.id);
    const sendId = await makeDueSend({
      orgId: org.id,
      leadId: lead.id,
      mailboxId,
      templateId,
    });

    // scheduled_sends is read-only to the browser: there is a select policy and
    // no update policy at all.
    const { data: refused, error } = await member.client
      .from("scheduled_sends")
      .update({ status: "sent", provider_message_id: "made-up" })
      .eq("id", sendId)
      .select("id");

    expect(error === null ? (refused ?? []).length : 0).toBe(0);

    // 204 with zero rows is what a denied write looks like, so re-read.
    const { data: after } = await admin()
      .from("scheduled_sends")
      .select("status, provider_message_id")
      .eq("id", sendId)
      .single();

    expect(after?.status).toBe("planned");
    expect(after?.provider_message_id).toBeNull();

    // But they can see it, because the queue screen shows the whole pipeline.
    const { data: visible } = await member.client
      .from("scheduled_sends")
      .select("id")
      .eq("id", sendId);
    expect(visible).toHaveLength(1);

    await cleanup([], [member.id]);
  }, 180_000);
});
