import { randomUUID } from "node:crypto";

import { DateTime } from "luxon";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

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

// What a mailbox really sent, recorded where the app counts touches (0042), and
// the two rules that ride with it: the planner leaves a lead with recorded
// history to /write, and the claimer never sends one lead two emails inside 20
// hours.
//
// Every route call is scoped with ?org= so a run against the shared cloud
// project can never plan for an org it did not create. Negative cases re-read
// as a privileged client, because a refused write is not always an error.

const CRON_SECRET = process.env.CRON_SECRET ?? "";
const ZONE = "America/Chicago";
const SUBJECT = "Bright Smile Dental and the calls that ring out";

const orgIds: string[] = [];
const userIds: string[] = [];

function admin() {
  return adminClient();
}

async function makeOrg(label: string) {
  const org = await createTestOrg(label);
  orgIds.push(org.id);
  const { error } = await admin()
    .from("org_settings")
    .update({ dry_run: false })
    .eq("org_id", org.id);
  if (error) throw new Error(`org_settings: ${error.message}`);

  const operator = await createTestUser(`${label}-op`);
  userIds.push(operator.id);
  await addMember(org.id, operator.id, "member");

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

async function makeTemplate(orgId: string, step: number): Promise<string> {
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

/** Claimed, audited, qualified, zoned: a lead the planner would work. */
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
  step: number;
  at: DateTime;
}) {
  return {
    org_id: input.orgId,
    lead_id: input.leadId,
    mailbox_id: input.mailboxId,
    template_id: input.templateId ?? null,
    step_number: input.step,
    touch_kind: input.step === 1 ? "first" : "followup",
    scheduled_at: input.at.toUTC().toISO(),
    scheduled_local: input.at.setZone(ZONE).toFormat("yyyy-MM-dd'T'HH:mm:ss"),
    prospect_timezone: ZONE,
  };
}

/** One message out of a Sent folder, as the reconcile script hands it over. */
function touch(mailboxId: string, at: DateTime) {
  return {
    message_id: `gmail-${randomUUID()}`,
    thread_id: `thread-${randomUUID()}`,
    rfc822_id: `<${randomUUID()}@example.test>`,
    subject: SUBJECT,
    mailbox_id: mailboxId,
    sent_at: at.toUTC().toISO(),
  };
}

async function record(leadId: string, touches: unknown[], dryRun: boolean) {
  const { data, error } = await admin().rpc("record_mailbox_touches", {
    p_lead_id: leadId,
    p_touches: touches,
    // No sheet: these leads have no raw row to read cells from.
    p_sheet_zone: null,
    p_dry_run: dryRun,
  });
  if (error) throw new Error(`record_mailbox_touches: ${error.message}`);
  return (data as Record<string, unknown>[])[0]!;
}

async function sendsFor(leadId: string) {
  const { data } = await admin()
    .from("scheduled_sends")
    .select(
      "id, status, step_number, touch_kind, mailbox_id, template_id, provider_message_id, provider_thread_id",
    )
    .eq("lead_id", leadId)
    .order("step_number");
  return data ?? [];
}

function cronRequest(path: string, orgId: string) {
  return new Request(`http://localhost/api/cron/${path}?org=${orgId}`, {
    method: "POST",
    headers: { authorization: `Bearer ${CRON_SECRET}` },
  });
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

describe("record_mailbox_touches", () => {
  it("records Sent-folder touches as sent rows on their thread, once", async () => {
    const { org, operator } = await makeOrg("history-record");
    const mailboxId = await makeMailbox(org.id, operator);
    const leadId = await makeLead(org.id, operator);
    const touches = [
      touch(mailboxId, DateTime.now().minus({ days: 12 })),
      touch(mailboxId, DateTime.now().minus({ days: 6 })),
    ];

    const dry = await record(leadId, touches, true);
    expect(dry).toMatchObject({ outcome: "would_record", inserted: 2, touches: 2 });
    expect(await sendsFor(leadId)).toHaveLength(0);

    const applied = await record(leadId, touches, false);
    expect(applied).toMatchObject({ outcome: "recorded", inserted: 2, touches: 2, next_step: 3 });

    const rows = await sendsFor(leadId);
    expect(rows.map((r) => [r.step_number, r.touch_kind, r.status])).toEqual([
      [1, "first", "sent"],
      [2, "followup", "sent"],
    ]);
    // The mailbox and thread are what pin and thread the follow-up.
    expect(rows.map((r) => r.provider_message_id)).toEqual(touches.map((t) => t.message_id));
    expect(rows.map((r) => r.provider_thread_id)).toEqual(touches.map((t) => t.thread_id));
    expect(rows.every((r) => r.mailbox_id === mailboxId && r.template_id === null)).toBe(true);

    const { data: events } = await admin()
      .from("lead_events")
      .select("dedupe_token")
      .eq("lead_id", leadId)
      .eq("type", "sent");
    expect((events ?? []).map((e) => e.dedupe_token).sort()).toEqual(
      touches.map((t) => t.message_id).sort(),
    );

    const { data: lead } = await admin().from("leads").select("status").eq("id", leadId).single();
    expect(lead?.status).toBe("sent");

    const again = await record(leadId, touches, false);
    expect(again.outcome).toBe("already_present");
    expect(await sendsFor(leadId)).toHaveLength(2);
  });

  it("moves the app's own send up a step when an earlier email turns up", async () => {
    const { org, operator } = await makeOrg("history-renumber");
    const mailboxId = await makeMailbox(org.id, operator);
    const leadId = await makeLead(org.id, operator);

    // What Sep 10 looked like: the app's "T1" to a lead the sheet era had
    // already written to.
    const appAt = DateTime.now().minus({ days: 1 });
    const appTouch = touch(mailboxId, appAt);
    const { error } = await admin()
      .from("scheduled_sends")
      .insert({
        ...sendRow({ orgId: org.id, leadId, mailboxId, step: 1, at: appAt }),
        status: "sent",
        sent_at: appAt.toUTC().toISO(),
        provider_message_id: appTouch.message_id,
        provider_thread_id: appTouch.thread_id,
      });
    if (error) throw new Error(`app send: ${error.message}`);

    const earlier = touch(mailboxId, DateTime.now().minus({ days: 9 }));
    const result = await record(leadId, [earlier, appTouch], false);
    expect(result).toMatchObject({ outcome: "recorded", inserted: 1, renumbered: 1, touches: 2 });

    const rows = await sendsFor(leadId);
    expect(rows.map((r) => [r.step_number, r.touch_kind, r.provider_message_id])).toEqual([
      [1, "first", earlier.message_id],
      [2, "followup", appTouch.message_id],
    ]);
  });

  it("cancels a booked step the Sent folder shows already went out", async () => {
    const { org, operator } = await makeOrg("history-cancel");
    const mailboxId = await makeMailbox(org.id, operator);
    const templateId = await makeTemplate(org.id, 1);
    const leadId = await makeLead(org.id, operator);

    const { data: booked, error } = await admin()
      .from("scheduled_sends")
      .insert({
        ...sendRow({
          orgId: org.id,
          leadId,
          mailboxId,
          templateId,
          step: 1,
          at: DateTime.now().plus({ days: 2 }),
        }),
        status: "planned",
      })
      .select("id")
      .single();
    if (error) throw new Error(`booked: ${error.message}`);

    const result = await record(leadId, [touch(mailboxId, DateTime.now().minus({ days: 4 }))], false);
    expect(result).toMatchObject({ outcome: "recorded", inserted: 1, cancelled: 1 });

    const rows = await sendsFor(leadId);
    expect(rows.find((r) => r.id === booked.id)?.status).toBe("cancelled");
    expect(rows.filter((r) => r.status === "sent")).toHaveLength(1);
  });

  it("refuses more touches than the sequence has steps, and writes nothing", async () => {
    const { org, operator } = await makeOrg("history-too-many");
    const mailboxId = await makeMailbox(org.id, operator);
    const leadId = await makeLead(org.id, operator);
    const five = [20, 16, 12, 8, 4].map((days) =>
      touch(mailboxId, DateTime.now().minus({ days })),
    );

    const result = await record(leadId, five, false);
    expect(result.outcome).toBe("too_many_touches");
    expect(await sendsFor(leadId)).toHaveLength(0);
  });
});

describe("plan-sends and recorded history", () => {
  it("leaves the follow-up to /write and cancels a template booked over it", async () => {
    const { org, operator } = await makeOrg("history-planner");
    const mailboxId = await makeMailbox(org.id, operator);
    const t2 = await makeTemplate(org.id, 2);
    const leadId = await makeLead(org.id, operator);

    await record(leadId, [touch(mailboxId, DateTime.now().minus({ days: 10 }))], false);

    // A template follow-up somebody booked before the history was known.
    const { data: booked, error } = await admin()
      .from("scheduled_sends")
      .insert({
        ...sendRow({
          orgId: org.id,
          leadId,
          mailboxId,
          templateId: t2,
          step: 2,
          at: DateTime.now().plus({ days: 1 }),
        }),
        status: "planned",
      })
      .select("id")
      .single();
    if (error) throw new Error(`booked: ${error.message}`);

    const response = await planSends(cronRequest("plan-sends", org.id));
    expect(response.status).toBe(200);
    const body = (await response.json()) as { reports: Record<string, number>[] };
    expect(body.reports[0]!.skipped_hand_written).toBe(1);

    const rows = await sendsFor(leadId);
    expect(rows.find((r) => r.id === booked.id)?.status).toBe("cancelled");
    expect(rows.filter((r) => r.status === "planned" || r.status === "blocked")).toHaveLength(0);
  });
});

describe("claim_due_sends and the 20-hour rule", () => {
  /** A lead whose last email reached Gmail `hoursAgo`, with a written T2 due now. */
  async function dueFollowUp(label: string, hoursAgo: number) {
    const { org, operator } = await makeOrg(label);
    const mailboxId = await makeMailbox(org.id, operator);
    const leadId = await makeLead(org.id, operator);
    const sentAt = DateTime.now().minus({ hours: hoursAgo });

    const { error: sentError } = await admin()
      .from("scheduled_sends")
      .insert({
        ...sendRow({ orgId: org.id, leadId, mailboxId, step: 1, at: sentAt }),
        status: "sent",
        sending_at: sentAt.toUTC().toISO(),
        sent_at: sentAt.toUTC().toISO(),
        provider_message_id: `gmail-${randomUUID()}`,
      });
    if (sentError) throw new Error(`sent: ${sentError.message}`);

    const { data: due, error } = await admin()
      .from("scheduled_sends")
      .insert({
        ...sendRow({
          orgId: org.id,
          leadId,
          mailboxId,
          step: 2,
          at: DateTime.now().minus({ minutes: 1 }),
        }),
        status: "planned",
        composed_subject: SUBJECT,
        composed_body: "A short, plain follow-up a person wrote.",
      })
      .select("id")
      .single();
    if (error) throw new Error(`due: ${error.message}`);

    return { orgId: org.id, dueId: due.id as string };
  }

  it("holds a lead that had an email reach Gmail two hours ago", async () => {
    const { orgId, dueId } = await dueFollowUp("claim-20h-hold", 2);

    const { data, error } = await admin().rpc("claim_due_sends", { p_org_id: orgId, p_limit: 5 });
    expect(error).toBeNull();
    expect(data).toEqual([]);

    const { data: row } = await admin().from("scheduled_sends").select("status").eq("id", dueId).single();
    expect(row?.status).toBe("planned");
  });

  it("claims it once twenty hours have passed", async () => {
    const { orgId, dueId } = await dueFollowUp("claim-20h-release", 25);

    const { data, error } = await admin().rpc("claim_due_sends", { p_org_id: orgId, p_limit: 5 });
    expect(error).toBeNull();
    expect((data as { id: string }[]).map((r) => r.id)).toEqual([dueId]);
  });
});

describe("close_leads_dnc", () => {
  it("closes and suppresses, and its dry run writes nothing", async () => {
    const { org, operator } = await makeOrg("history-close");
    const leadId = await makeLead(org.id, operator);
    const args = {
      p_lead_ids: [leadId],
      p_token: "repeat-send",
      p_note: "sent the same email repeatedly",
    };

    const { data: dry, error: dryError } = await admin().rpc("close_leads_dnc", {
      ...args,
      p_dry_run: true,
    });
    expect(dryError).toBeNull();
    expect(dry).toMatchObject([{ lead_id: leadId, outcome: "closed" }]);

    const { data: untouched } = await admin()
      .from("leads")
      .select("terminal_outcome, work_email_norm")
      .eq("id", leadId)
      .single();
    expect(untouched?.terminal_outcome).toBeNull();

    const { data: closed, error } = await admin().rpc("close_leads_dnc", {
      ...args,
      p_dry_run: false,
    });
    expect(error).toBeNull();
    expect(closed).toMatchObject([{ lead_id: leadId, outcome: "closed" }]);

    const { data: lead } = await admin()
      .from("leads")
      .select("terminal_outcome")
      .eq("id", leadId)
      .single();
    expect(lead?.terminal_outcome).toBe("do_not_contact");

    const { data: suppressions } = await admin()
      .from("suppressions")
      .select("email_norm, reason")
      .eq("org_id", org.id);
    expect(suppressions).toEqual([
      { email_norm: untouched?.work_email_norm, reason: "manual_dnc" },
    ]);

    const { data: again } = await admin().rpc("close_leads_dnc", { ...args, p_dry_run: false });
    expect(again).toMatchObject([{ outcome: "already_closed" }]);
  });
});

describe("a sheet cell dated before the sheet existed (0043)", () => {
  it("is reported, not recorded as a touch", async () => {
    // Nuvo HVAC: `06/08/25 22:41` for 6 Aug 2026. Read literally it was a
    // phantom T1 a year before the real one, which put /write a step ahead.
    const { org, operator } = await makeOrg("history-sheet-typo");
    const mailboxId = await makeMailbox(org.id, operator);

    const { data: lead, error } = await admin()
      .from("leads")
      .insert({
        org_id: org.id,
        company_name: "Nuvo HVAC",
        work_email: `owner-${randomUUID().slice(0, 8)}@prospect.test`,
        website: `https://${randomUUID().slice(0, 8)}.prospect.test`,
        timezone: ZONE,
        timezone_source: "import",
        claimed_by: operator.id,
        claimed_at: new Date().toISOString(),
        raw: { status: "first_touch", first_touch: "06/08/25 22:41" },
      })
      .select("id")
      .single();
    if (error) throw new Error(`lead: ${error.message}`);

    const { data, error: rpcError } = await admin().rpc("record_mailbox_touches", {
      p_lead_id: lead.id,
      p_touches: [touch(mailboxId, DateTime.now().minus({ days: 20 }))],
      p_sheet_zone: "Asia/Kolkata",
      p_dry_run: false,
    });
    if (rpcError) throw new Error(`record_mailbox_touches: ${rpcError.message}`);

    const result = (data as Record<string, unknown>[])[0]!;
    expect(result).toMatchObject({ outcome: "recorded", touches: 1, next_step: 2 });
    expect(String(result.detail)).toContain("first_touch");

    const rows = await sendsFor(lead.id as string);
    expect(rows.map((r) => [r.step_number, r.mailbox_id])).toEqual([[1, mailboxId]]);
  });
});
