import { randomUUID } from "node:crypto";

import { DateTime } from "luxon";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// No live Gmail grant exists in a test, so the two calls that would touch
// Google are replaced. Everything else -- claiming, the transitions, the event
// log, the triggers -- is the real thing against a real database, which is the
// part that was broken: mark_send_sent() raised on every call for three weeks
// and nothing in this suite had ever called it.
vi.mock("@/lib/gmail/token", () => ({
  getMailboxAccessToken: vi.fn(async () => ({ accessToken: "test-access-token" })),
  MailboxDisconnectedError: class MailboxDisconnectedError extends Error {},
}));

vi.mock("@/lib/gmail/send", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/gmail/send")>();
  return {
    ...actual,
    sendMessage: vi.fn(async (input: { message: { messageId: string } }) => ({
      providerMessageId: `gmail-${globalThis.crypto.randomUUID()}`,
      providerThreadId: `thread-${globalThis.crypto.randomUUID()}`,
      rfc822MessageId: input.message.messageId,
    })),
  };
});

import { POST as dispatchSends } from "@/app/api/cron/dispatch-sends/route";
import { POST as planSends } from "@/app/api/cron/plan-sends/route";
import { GmailSendError, sendMessage } from "@/lib/gmail/send";

import { CLEAN_BODY, CLEAN_SUBJECT } from "../fixtures/template-vectors";
import {
  addMember,
  adminClient,
  cleanup,
  createTestOrg,
  createTestUser,
  type TestUser,
} from "../setup/stack";

// Recording a send, and what happens when recording fails.
//
// Every route call is scoped with ?org= so a run against the shared cloud
// project can never plan or dispatch for an org it did not create. Negative
// cases re-read as a privileged client, because a refused write is not always
// an error.

const CRON_SECRET = process.env.CRON_SECRET ?? "";
const ZONE = "America/Chicago";

const orgIds: string[] = [];
const userIds: string[] = [];

function admin() {
  return adminClient();
}

/**
 * A fresh operator per org. app.current_org_id() resolves the caller's org
 * from their membership, so a user who belongs to several test orgs would make
 * every RPC in this file ambiguous.
 */
async function makeOrg(label: string, role: "admin" | "member" = "member") {
  const org = await createTestOrg(label);
  orgIds.push(org.id);
  const { error } = await admin()
    .from("org_settings")
    .update({ dry_run: false })
    .eq("org_id", org.id);
  if (error) throw new Error(`org_settings: ${error.message}`);

  const operator = await createTestUser(`${label}-op`);
  userIds.push(operator.id);
  await addMember(org.id, operator.id, role);

  return { org, operator };
}

async function makeMailbox(orgId: string, operator: TestUser): Promise<string> {
  const { data, error } = await admin()
    .from("mailboxes")
    .insert({
      org_id: orgId,
      user_id: operator.id,
      email: `sender-${randomUUID().slice(0, 8)}@example.test`,
      display_name: "Ojas",
      timezone: "America/New_York",
      daily_cap: 20,
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

/** Claimed, audited, qualified, zoned: ready for a first touch. */
async function makeLead(orgId: string, operator: TestUser): Promise<string> {
  const { data, error } = await admin()
    .from("leads")
    .insert({
      org_id: orgId,
      company_name: "Bright Smile Dental",
      first_name: "Dana",
      work_email: `owner-${randomUUID().slice(0, 8)}@prospect.test`,
      website: `https://${randomUUID().slice(0, 8)}.prospect.test`,
      rating: 4.6,
      timezone: ZONE,
      timezone_source: "import",
      claimed_by: operator.id,
      claimed_at: new Date().toISOString(),
    })
    .select("id")
    .single();
  if (error) throw new Error(`lead: ${error.message}`);

  const { error: eventError } = await admin().from("lead_events").insert({
    org_id: orgId,
    lead_id: data.id,
    type: "audited",
    actor_id: operator.id,
  });
  if (eventError) throw new Error(`audited event: ${eventError.message}`);

  return data.id as string;
}

function sendRow(input: {
  orgId: string;
  leadId: string;
  mailboxId: string;
  templateId?: string | null;
  step?: number;
  at: DateTime;
}) {
  const step = input.step ?? 1;
  return {
    org_id: input.orgId,
    lead_id: input.leadId,
    mailbox_id: input.mailboxId,
    template_id: input.templateId ?? null,
    step_number: step,
    touch_kind: step === 1 ? "first" : "followup",
    scheduled_at: input.at.toUTC().toISO(),
    scheduled_local: input.at.setZone(ZONE).toFormat("yyyy-MM-dd'T'HH:mm:ss"),
    prospect_timezone: ZONE,
  };
}

/** A hand-written send that is due now, so the dispatcher renders nothing. */
async function makeDueWrittenSend(orgId: string, leadId: string, mailboxId: string) {
  const { data, error } = await admin()
    .from("scheduled_sends")
    .insert({
      ...sendRow({ orgId, leadId, mailboxId, at: DateTime.now().minus({ minutes: 1 }) }),
      status: "planned",
      composed_subject: "Bright Smile Dental and the calls that ring out",
      composed_body: "A short, plain email a person wrote.",
    })
    .select("id")
    .single();
  if (error) throw new Error(`due send: ${error.message}`);
  return data.id as string;
}

/**
 * What 247 rows in production look like: the dispatcher reached the Gmail call
 * (sending_at is set) and nothing afterwards was recorded.
 */
async function makeStalledSend(input: {
  orgId: string;
  leadId: string;
  mailboxId: string;
  templateId: string;
  minutesAgo: number;
  step?: number;
}) {
  const at = DateTime.now().minus({ minutes: input.minutesAgo });
  const { data, error } = await admin()
    .from("scheduled_sends")
    .insert({
      ...sendRow({ ...input, at }),
      status: "failed",
      error_code: "stalled",
      claimed_at: at.toUTC().toISO(),
      sending_at: at.toUTC().toISO(),
    })
    .select("id")
    .single();
  if (error) throw new Error(`stalled send: ${error.message}`);
  return data.id as string;
}

function cronRequest(path: string, orgId: string) {
  return new Request(`http://localhost/api/cron/${path}?org=${orgId}`, {
    method: "POST",
    headers: { authorization: `Bearer ${CRON_SECRET}` },
  });
}

async function sendsFor(leadId: string) {
  const { data } = await admin()
    .from("scheduled_sends")
    .select("id, status, step_number, error_code, sent_at, sending_at")
    .eq("lead_id", leadId)
    .order("created_at");
  return data ?? [];
}

// ---------------------------------------------------------------------------

beforeAll(() => {
  if (!CRON_SECRET) {
    throw new Error("CRON_SECRET must be set in .env for these tests.");
  }
});

afterAll(async () => {
  await cleanup(orgIds, userIds);
}, 120_000);

// ---------------------------------------------------------------------------

describe("recording a send", () => {
  it("marks the row sent, logs the event, derives status and stamps the mailbox", async () => {
    // The regression proof. Before 0040 the final call here raised, because the
    // mailbox guard saw `postgres` (the definer) rather than `service_role`,
    // and the whole transaction rolled back.
    const { org, operator } = await makeOrg("record-sent");
    const mailboxId = await makeMailbox(org.id, operator);
    const leadId = await makeLead(org.id, operator);
    const sendId = await makeDueWrittenSend(org.id, leadId, mailboxId);

    const { data: claimed, error: claimError } = await admin().rpc("claim_due_sends", {
      p_org_id: org.id,
      p_limit: 5,
    });
    expect(claimError).toBeNull();
    expect(claimed).toHaveLength(1);

    const { data: locked } = await admin().rpc("mark_send_sending", {
      p_send_id: sendId,
      p_claim_token: claimed![0]!.claim_token,
    });
    expect(locked).toBe(true);

    const messageId = `gmail-${randomUUID()}`;
    const { error } = await admin().rpc("mark_send_sent", {
      p_send_id: sendId,
      p_message_id: messageId,
      p_thread_id: `thread-${randomUUID()}`,
      p_rfc822_id: `<${randomUUID()}@example.test>`,
      p_subject: "subject",
      p_body: "body",
    });
    expect(error).toBeNull();

    const { data: row } = await admin()
      .from("scheduled_sends")
      .select("status, provider_message_id, sent_at")
      .eq("id", sendId)
      .single();
    expect(row?.status).toBe("sent");
    expect(row?.provider_message_id).toBe(messageId);
    expect(row?.sent_at).not.toBeNull();

    const { data: events } = await admin()
      .from("lead_events")
      .select("type, dedupe_token")
      .eq("lead_id", leadId)
      .eq("type", "sent");
    expect(events).toEqual([{ type: "sent", dedupe_token: messageId }]);

    const { data: lead } = await admin()
      .from("leads")
      .select("status")
      .eq("id", leadId)
      .single();
    expect(lead?.status).toBe("sent");

    const { data: mailbox } = await admin()
      .from("mailboxes")
      .select("last_send_at")
      .eq("id", mailboxId)
      .single();
    expect(mailbox?.last_send_at).not.toBeNull();
  }, 180_000);

  it("dispatches end to end and records what went out", async () => {
    // The test that would have caught it: the real route, the real RPCs, only
    // Gmail itself stubbed.
    const { org, operator } = await makeOrg("dispatch-records");
    const mailboxId = await makeMailbox(org.id, operator);
    const leadId = await makeLead(org.id, operator);
    const sendId = await makeDueWrittenSend(org.id, leadId, mailboxId);

    vi.mocked(sendMessage).mockClear();
    const response = await dispatchSends(cronRequest("dispatch-sends", org.id));
    expect(response.status).toBe(200);

    const body = (await response.json()) as {
      reports: { sent: number; unrecorded: number }[];
    };
    expect(body.reports[0]?.sent).toBe(1);
    expect(body.reports[0]?.unrecorded).toBe(0);
    expect(vi.mocked(sendMessage)).toHaveBeenCalledTimes(1);

    const { data: row } = await admin()
      .from("scheduled_sends")
      .select("status, provider_message_id, rendered_body")
      .eq("id", sendId)
      .single();
    expect(row?.status).toBe("sent");
    expect(row?.provider_message_id).toMatch(/^gmail-/);
    expect(row?.rendered_body).toBe("A short, plain email a person wrote.");
  }, 180_000);

  it("holds an email Gmail gave no clear answer about, and fails one it refused", async () => {
    const { org, operator } = await makeOrg("dispatch-gmail-errors");
    // Two mailboxes, because each one sends at most once per run (0041).
    const unclear = {
      mailboxId: await makeMailbox(org.id, operator),
      leadId: await makeLead(org.id, operator),
    };
    const refused = {
      mailboxId: await makeMailbox(org.id, operator),
      leadId: await makeLead(org.id, operator),
    };
    const unclearSend = await makeDueWrittenSend(org.id, unclear.leadId, unclear.mailboxId);
    const refusedSend = await makeDueWrittenSend(org.id, refused.leadId, refused.mailboxId);

    const { data: refusedLead } = await admin()
      .from("leads")
      .select("work_email")
      .eq("id", refused.leadId)
      .single();

    const original = vi.mocked(sendMessage).getMockImplementation();
    vi.mocked(sendMessage).mockImplementation(async (input) => {
      if (input.message.to.email === refusedLead?.work_email) {
        throw new GmailSendError("gmail send failed (400): Invalid To header", 400);
      }
      throw new GmailSendError("gmail send failed (503): backendError", 503);
    });

    try {
      const response = await dispatchSends(cronRequest("dispatch-sends", org.id));
      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        reports: { sent: number; failed: number; unknown: number }[];
      };
      expect(body.reports[0]).toMatchObject({ sent: 0, failed: 1, unknown: 1 });
    } finally {
      vi.mocked(sendMessage).mockImplementation(original!);
    }

    // A 503 may be an email that went out. Recorded as failed, /write offered
    // the step again; left in `sending`, the reaper parks it as `stalled`,
    // which holds the lead for a person.
    const [unclearRow] = await sendsFor(unclear.leadId);
    expect(unclearRow?.status).toBe("sending");

    // A 400 is Gmail saying no. The step is open again.
    const [refusedRow] = await sendsFor(refused.leadId);
    expect(refusedRow?.status).toBe("failed");
    expect(refusedRow?.error_code).toBe("gmail_400");

    // And both say so, rather than the lead quietly showing the same step.
    const { data: raised } = await admin()
      .from("alerts")
      .select("dedupe_token")
      .eq("org_id", org.id)
      .in("dedupe_token", [`send-unknown:${unclearSend}`, `send-failed:${refusedSend}`]);
    expect((raised ?? []).map((a) => a.dedupe_token).sort()).toEqual(
      [`send-failed:${refusedSend}`, `send-unknown:${unclearSend}`].sort(),
    );
  }, 180_000);
});

describe("an unknown outcome holds the lead", () => {
  it("is not re-planned, raises an alert, and refuses a direct insert", async () => {
    const { org, operator } = await makeOrg("stalled-held");
    const mailboxId = await makeMailbox(org.id, operator);
    const templateId = await makeTemplate(org.id);
    const leadId = await makeLead(org.id, operator);
    await makeStalledSend({ orgId: org.id, leadId, mailboxId, templateId, minutesAgo: 60 });

    // Before 0040 this booked T1 again, which is how one business got the same
    // first touch 41 times.
    const response = await planSends(cronRequest("plan-sends", org.id));
    expect(response.status).toBe(200);

    const after = await sendsFor(leadId);
    expect(after.filter((s) => s.status === "planned")).toHaveLength(0);

    const { data: alerts } = await admin()
      .from("alerts")
      .select("kind")
      .eq("org_id", org.id)
      .eq("dedupe_token", `stalled:${leadId}`);
    expect(alerts ?? []).toHaveLength(1);

    // And the trigger binds the service role, so a writer that forgets to check
    // is refused all the same.
    const { error } = await admin()
      .from("scheduled_sends")
      .insert({
        ...sendRow({
          orgId: org.id,
          leadId,
          mailboxId,
          templateId,
          at: DateTime.now().plus({ hours: 2 }),
        }),
        status: "planned",
      })
      .select("id");
    expect(error).not.toBeNull();

    const reread = await sendsFor(leadId);
    expect(reread.filter((s) => s.status === "planned")).toHaveLength(0);
  }, 180_000);

  it("records it as sent when the operator says it went out, and moves on to T2", async () => {
    const { org, operator } = await makeOrg("resolve-went-out");
    const mailboxId = await makeMailbox(org.id, operator);
    const templateId = await makeTemplate(org.id, 1);
    await makeTemplate(org.id, 2);
    const leadId = await makeLead(org.id, operator);
    // Ten days ago, so T2's three business days have already passed.
    const stalledId = await makeStalledSend({
      orgId: org.id,
      leadId,
      mailboxId,
      templateId,
      minutesAgo: 10 * 24 * 60,
    });

    const { error } = await operator.client.rpc("resolve_stalled_send", {
      p_send_id: stalledId,
      p_went_out: true,
    });
    expect(error).toBeNull();

    const [row] = (await sendsFor(leadId)).filter((s) => s.id === stalledId);
    expect(row?.status).toBe("sent");
    expect(row?.error_code).toBeNull();
    // Dated when it left, not when somebody pressed the button.
    expect(row?.sent_at).toBe(row?.sending_at);

    const { data: lead } = await admin()
      .from("leads")
      .select("status")
      .eq("id", leadId)
      .single();
    expect(lead?.status).toBe("sent");

    await planSends(cronRequest("plan-sends", org.id));

    const planned = (await sendsFor(leadId)).filter((s) => s.status === "planned");
    expect(planned).toHaveLength(1);
    expect(planned[0]?.step_number).toBe(2);
  }, 180_000);

  it("releases the step when the operator says it did not go out", async () => {
    const { org, operator } = await makeOrg("resolve-not-sent");
    const mailboxId = await makeMailbox(org.id, operator);
    const templateId = await makeTemplate(org.id);
    const leadId = await makeLead(org.id, operator);
    const stalledId = await makeStalledSend({
      orgId: org.id,
      leadId,
      mailboxId,
      templateId,
      minutesAgo: 60,
    });

    const { error } = await operator.client.rpc("resolve_stalled_send", {
      p_send_id: stalledId,
      p_went_out: false,
    });
    expect(error).toBeNull();

    await planSends(cronRequest("plan-sends", org.id));

    const sends = await sendsFor(leadId);
    expect(sends.find((s) => s.id === stalledId)?.error_code).toBe("stalled_not_sent");
    const planned = sends.filter((s) => s.status === "planned");
    expect(planned).toHaveLength(1);
    expect(planned[0]?.step_number).toBe(1);
  }, 180_000);
});

describe("repairing the backlog", () => {
  it("previews without writing, then records the latest attempt once", async () => {
    const { org, operator: owner } = await makeOrg("repair-stalled", "admin");
    const mailboxId = await makeMailbox(org.id, owner);
    const templateId = await makeTemplate(org.id);
    const leadId = await makeLead(org.id, owner);

    // The re-booking the planner made after the last stall. Inserted first: the
    // trigger refuses it once a stalled row exists, which is the point of 0040.
    const { data: rebooked, error: rebookError } = await admin()
      .from("scheduled_sends")
      .insert({
        ...sendRow({
          orgId: org.id,
          leadId,
          mailboxId,
          templateId,
          at: DateTime.now().plus({ hours: 3 }),
        }),
        status: "planned",
      })
      .select("id")
      .single();
    expect(rebookError).toBeNull();

    const oldest = await makeStalledSend({ orgId: org.id, leadId, mailboxId, templateId, minutesAgo: 300 });
    const middle = await makeStalledSend({ orgId: org.id, leadId, mailboxId, templateId, minutesAgo: 200 });
    const latest = await makeStalledSend({ orgId: org.id, leadId, mailboxId, templateId, minutesAgo: 100 });

    const before = await sendsFor(leadId);

    const { data: preview, error: previewError } = await owner.client.rpc(
      "repair_stalled_sends",
      { p_dry_run: true },
    );
    expect(previewError).toBeNull();
    expect(preview).toHaveLength(1);
    expect(preview![0]).toMatchObject({
      lead_id: leadId,
      step_number: 1,
      attempts: 3,
      cancelled_planned: 1,
      outcome: "recorded",
    });

    // A dry run is a dry run: re-read, and nothing moved.
    expect(await sendsFor(leadId)).toEqual(before);

    const { data: applied, error: applyError } = await owner.client.rpc(
      "repair_stalled_sends",
      { p_dry_run: false },
    );
    expect(applyError).toBeNull();
    expect(applied![0]?.outcome).toBe("recorded");

    const after = new Map((await sendsFor(leadId)).map((s) => [s.id, s]));
    expect(after.get(latest)?.status).toBe("sent");
    expect(after.get(middle)?.error_code).toBe("sent_unrecorded_repeat");
    expect(after.get(oldest)?.error_code).toBe("sent_unrecorded_repeat");
    expect(after.get(rebooked!.id as string)?.status).toBe("cancelled");

    const { data: events } = await admin()
      .from("lead_events")
      .select("id")
      .eq("lead_id", leadId)
      .eq("type", "sent");
    expect(events ?? []).toHaveLength(1);

    const { data: lead } = await admin()
      .from("leads")
      .select("status")
      .eq("id", leadId)
      .single();
    expect(lead?.status).toBe("sent");

    // Re-runnable: nothing is stalled any more, so nothing is reported.
    const { data: again } = await owner.client.rpc("repair_stalled_sends", {
      p_dry_run: false,
    });
    expect(again ?? []).toHaveLength(0);
  }, 180_000);

  it("refuses a member", async () => {
    const { operator: member } = await makeOrg("repair-member", "member");
    const { error } = await member.client.rpc("repair_stalled_sends", {
      p_dry_run: true,
    });
    expect(error?.code).toBe("42501");
  }, 180_000);
});
