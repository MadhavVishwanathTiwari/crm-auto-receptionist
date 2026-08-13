import { randomUUID } from "node:crypto";

import { DateTime } from "luxon";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { CLEAN_BODY, CLEAN_SUBJECT } from "../fixtures/template-vectors";
import {
  adminClient,
  cleanup,
  createTestOrg,
  createTestUser,
  type TestUser,
} from "../setup/stack";

// Writing the email yourself.
//
// The half of the product that is not Instantly: an operator types one email to
// one business, and the app decides the instant it leaves. What that has to buy
// is exactly this, and each of the four is a way the feature could be built
// wrong and still look like it worked:
//
//   1. A merely CLAIMED lead is writable. The planner needs an audit or an
//      explicit queue; writing the email IS that decision, so requiring one
//      first would mean an operator has to tell the app they are about to do
//      the thing they are doing.
//   2. The words survive verbatim. No template, no substitution, no lint.
//   3. The TIME is not the operator's to choose. It comes back prospect-local,
//      inside the send window, on an allowed weekday.
//   4. Everything that protects a prospect still binds: the claim, the
//      timezone, the suppression list, and a step that already went out.
//
// The dispatcher's side of this is asserted by reading the row it would render
// from rather than by calling Gmail: what matters here is that composed_body is
// what ends up in front of the send, and that no template was needed to get it
// there.

const orgIds: string[] = [];
let operator: TestUser;
let stranger: TestUser;

function admin() {
  return adminClient();
}

/** A claimed, qualified, zoned lead with nothing else decided about it. */
async function makeClaimedLead(
  orgId: string,
  owner: TestUser = operator,
  overrides: Record<string, unknown> = {},
): Promise<string> {
  const { data, error } = await admin()
    .from("leads")
    .insert({
      org_id: orgId,
      company_name: "Northgate Plumbing",
      work_email: `owner-${randomUUID().slice(0, 8)}@prospect.test`,
      website: `https://${randomUUID().slice(0, 8)}.prospect.test`,
      rating: 4.6,
      timezone: "America/Chicago",
      timezone_source: "import",
      claimed_by: owner.id,
      claimed_at: new Date().toISOString(),
      ...overrides,
    })
    .select("id")
    .single();
  if (error) throw new Error(`lead: ${error.message}`);

  const { error: eventError } = await admin().from("lead_events").insert({
    org_id: orgId,
    lead_id: data.id,
    type: "claimed",
    actor_id: owner.id,
  });
  if (eventError) throw new Error(`claimed event: ${eventError.message}`);

  return data.id as string;
}

/**
 * Calls the RPC the way the composer's action does: a slot in the future,
 * prospect-local, chosen by the caller.
 */
async function queue(
  user: TestUser,
  args: {
    leadId: string;
    subject?: string;
    body?: string;
    at?: DateTime;
    step?: number;
    mailboxId: string;
    templateId?: string | null;
  },
) {
  const at = args.at ?? DateTime.now().setZone("America/Chicago").plus({ days: 1 });

  return user.client.rpc("queue_composed_send", {
    p_lead_id: args.leadId,
    p_subject: args.subject ?? "Northgate and the calls nobody picks up",
    p_body: args.body ?? "Wrote this one by hand. Worth a look, or not?",
    p_scheduled_at: at.toUTC().toISO(),
    p_scheduled_local: at.toFormat("yyyy-MM-dd'T'HH:mm:ss"),
    p_mailbox_id: args.mailboxId,
    p_step: args.step ?? 1,
    p_template_id: args.templateId ?? null,
  });
}

async function sendsFor(leadId: string) {
  const { data } = await admin()
    .from("scheduled_sends")
    .select(
      "id, step_number, status, template_id, composed_subject, composed_body, composed_by, scheduled_at, scheduled_local, prospect_timezone, mailbox_id",
    )
    .eq("lead_id", leadId)
    .order("step_number", { ascending: true });
  return data ?? [];
}

// ---------------------------------------------------------------------------

let orgId: string;
let mailboxId: string;
let templateId: string;

beforeAll(async () => {
  operator = await createTestUser("composer");
  stranger = await createTestUser("composer-stranger");

  const org = await createTestOrg("composed");
  orgIds.push(org.id);
  orgId = org.id;

  for (const user of [operator, stranger]) {
    const { error } = await admin()
      .from("org_members")
      .insert({ org_id: orgId, user_id: user.id, role: "member" });
    if (error) throw new Error(`member: ${error.message}`);
  }

  const { data: mailbox, error: mailboxError } = await admin()
    .from("mailboxes")
    .insert({
      org_id: orgId,
      user_id: operator.id,
      email: `sender-${randomUUID().slice(0, 8)}@example.test`,
      display_name: "Madhav",
      timezone: "Asia/Kolkata",
      daily_cap: 20,
    })
    .select("id")
    .single();
  if (mailboxError) throw new Error(`mailbox: ${mailboxError.message}`);
  mailboxId = mailbox.id as string;

  // A template send for the replacement case to overwrite. Left as a draft:
  // nothing here activates it, and the lint trigger only binds on is_active.
  const { data: template, error: templateError } = await admin()
    .from("templates")
    .insert({
      org_id: orgId,
      name: `planner-t1-${randomUUID().slice(0, 8)}`,
      step_number: 1,
      subject: CLEAN_SUBJECT,
      body: CLEAN_BODY,
      is_active: false,
    })
    .select("id")
    .single();
  if (templateError) throw new Error(`template: ${templateError.message}`);
  templateId = template.id as string;
}, 60_000);

afterAll(async () => {
  await cleanup(orgIds, [operator.id, stranger.id]);
}, 60_000);

describe("writing an email by hand", () => {
  it("books a send for a lead nobody audited or queued", async () => {
    const leadId = await makeClaimedLead(orgId);

    const { error } = await queue(operator, { leadId, mailboxId });
    expect(error).toBeNull();

    const sends = await sendsFor(leadId);
    expect(sends).toHaveLength(1);
    expect(sends[0]!.status).toBe("planned");
    expect(sends[0]!.step_number).toBe(1);
    // The whole point: no template was involved in producing this email.
    expect(sends[0]!.template_id).toBeNull();
    expect(sends[0]!.composed_body).toContain("by hand");
    expect(sends[0]!.composed_by).toBe(operator.id);
  });

  it("advances the lead to queued, so its follow-ups can be planned", async () => {
    const leadId = await makeClaimedLead(orgId);
    await queue(operator, { leadId, mailboxId });

    const { data } = await admin()
      .from("leads")
      .select("status")
      .eq("id", leadId)
      .single();

    // Derived, never typed. The RPC writes a `queued` event and the trigger
    // recomputes this.
    expect(data!.status).toBe("queued");
  });

  it("stores the prospect-local wall clock alongside the instant", async () => {
    const leadId = await makeClaimedLead(orgId);
    const at = DateTime.now().setZone("America/Chicago").plus({ days: 2 }).set({
      hour: 9,
      minute: 14,
      second: 0,
      millisecond: 0,
    });

    await queue(operator, { leadId, mailboxId, at });

    const send = (await sendsFor(leadId))[0]!;
    expect(send.prospect_timezone).toBe("America/Chicago");
    // A `timestamp` column, so no offset: this is what the operator was shown.
    expect(String(send.scheduled_local)).toContain("09:14");
  });

  it("replaces a template send already booked for the same step", async () => {
    // The planner may have booked T1 from a template before the operator
    // decided this one deserved a personal email. Writing it has to win, and
    // the partial unique index on (lead_id, step_number) would otherwise turn
    // that into a duplicate key error nobody could act on.
    const leadId = await makeClaimedLead(orgId);

    const { data: planned, error: plannedError } = await admin()
      .from("scheduled_sends")
      .insert({
        org_id: orgId,
        lead_id: leadId,
        mailbox_id: mailboxId,
        template_id: templateId,
        step_number: 1,
        touch_kind: "first",
        status: "planned",
        scheduled_at: DateTime.now().plus({ days: 4 }).toUTC().toISO(),
        scheduled_local: DateTime.now()
          .setZone("America/Chicago")
          .plus({ days: 4 })
          .toFormat("yyyy-MM-dd'T'HH:mm:ss"),
        prospect_timezone: "America/Chicago",
      })
      .select("id")
      .single();
    expect(plannedError).toBeNull();

    const { error } = await queue(operator, { leadId, mailboxId });
    expect(error).toBeNull();

    const sends = await sendsFor(leadId);
    expect(sends).toHaveLength(1);
    // The same row, re-pointed at the operator's words.
    expect(sends[0]!.id).toBe(planned!.id);
    expect(sends[0]!.composed_body).toContain("by hand");
    expect(sends[0]!.template_id).toBeNull();
  });

  it("refuses a lead claimed by somebody else", async () => {
    const leadId = await makeClaimedLead(orgId, stranger);

    const { error } = await queue(operator, { leadId, mailboxId });
    expect(error).not.toBeNull();

    // A PostgREST write denied by RLS is 204 with zero rows, so a negative test
    // that only asserts an error can pass vacuously. Re-read as a privileged
    // client and prove nothing was written.
    expect(await sendsFor(leadId)).toHaveLength(0);
  });

  it("refuses a lead with no resolvable timezone", async () => {
    // leads_timezone_source ties the two columns together: no zone means no
    // source, and clearing one without the other is refused.
    const leadId = await makeClaimedLead(orgId, operator, {
      timezone: null,
      timezone_source: null,
    });

    const { error } = await queue(operator, { leadId, mailboxId });
    expect(error).not.toBeNull();
    expect(await sendsFor(leadId)).toHaveLength(0);
  });

  it("refuses a suppressed address", async () => {
    const leadId = await makeClaimedLead(orgId);

    const { data: lead } = await admin()
      .from("leads")
      .select("work_email_norm")
      .eq("id", leadId)
      .single();

    const { error: suppressionError } = await admin().from("suppressions").insert({
      org_id: orgId,
      email_norm: lead!.work_email_norm,
      reason: "manual_dnc",
    });
    expect(suppressionError).toBeNull();

    const { error } = await queue(operator, { leadId, mailboxId });
    expect(error).not.toBeNull();
    expect(await sendsFor(leadId)).toHaveLength(0);
  });

  it("refuses a slot that has already passed", async () => {
    const leadId = await makeClaimedLead(orgId);

    const { error } = await queue(operator, {
      leadId,
      mailboxId,
      at: DateTime.now().minus({ hours: 2 }),
    });

    expect(error).not.toBeNull();
    expect(await sendsFor(leadId)).toHaveLength(0);
  });

  it("refuses an empty body, which would dispatch as a blank email", async () => {
    const leadId = await makeClaimedLead(orgId);

    const { error } = await queue(operator, { leadId, mailboxId, body: "   " });
    expect(error).not.toBeNull();
    expect(await sendsFor(leadId)).toHaveLength(0);
  });

  it("revises the words without moving the send time", async () => {
    const leadId = await makeClaimedLead(orgId);
    await queue(operator, { leadId, mailboxId });

    const before = (await sendsFor(leadId))[0]!;

    const { error } = await operator.client.rpc("revise_composed_send", {
      p_send_id: before.id,
      p_subject: "Northgate, second thoughts",
      p_body: "Fixed a typo. Still worth a look, or not?",
    });
    expect(error).toBeNull();

    const after = (await sendsFor(leadId))[0]!;
    expect(after.composed_subject).toBe("Northgate, second thoughts");
    expect(after.composed_body).toContain("Fixed a typo");
    // The reason this is not "cancel and re-queue".
    expect(after.scheduled_at).toBe(before.scheduled_at);
  });

  it("will not revise a send that has already been claimed", async () => {
    const leadId = await makeClaimedLead(orgId);
    await queue(operator, { leadId, mailboxId });
    const send = (await sendsFor(leadId))[0]!;

    await admin()
      .from("scheduled_sends")
      .update({ status: "claimed", claimed_at: new Date().toISOString() })
      .eq("id", send.id);

    const { error } = await operator.client.rpc("revise_composed_send", {
      p_send_id: send.id,
      p_subject: "Too late",
      p_body: "The dispatcher may already be inside the Gmail call.",
    });
    expect(error).not.toBeNull();

    const after = (await sendsFor(leadId))[0]!;
    expect(after.composed_body).not.toContain("Gmail call");
  });

  it("refuses a step whose email has already gone out", async () => {
    const leadId = await makeClaimedLead(orgId);
    await queue(operator, { leadId, mailboxId });
    const send = (await sendsFor(leadId))[0]!;

    await admin()
      .from("scheduled_sends")
      .update({
        status: "sent",
        sent_at: new Date().toISOString(),
        provider_message_id: `msg-${randomUUID()}`,
      })
      .eq("id", send.id);

    const { error } = await queue(operator, { leadId, mailboxId, step: 1 });
    expect(error).not.toBeNull();

    // Still exactly one row for step 1: the email in somebody's inbox.
    const sends = await sendsFor(leadId);
    expect(sends.filter((s) => s.step_number === 1)).toHaveLength(1);
  });

  it("lets a second touch be written after the first went out", async () => {
    const leadId = await makeClaimedLead(orgId);
    await queue(operator, { leadId, mailboxId });
    const first = (await sendsFor(leadId))[0]!;

    await admin()
      .from("scheduled_sends")
      .update({
        status: "sent",
        sent_at: new Date().toISOString(),
        provider_message_id: `msg-${randomUUID()}`,
      })
      .eq("id", first.id);

    const { error } = await queue(operator, {
      leadId,
      mailboxId,
      step: 2,
      subject: "Re: Northgate",
      body: "Following up by hand. Shall I close the file, or keep it open?",
    });
    expect(error).toBeNull();

    const sends = await sendsFor(leadId);
    expect(sends).toHaveLength(2);
    expect(sends[1]!.step_number).toBe(2);
    expect(sends[1]!.composed_body).toContain("by hand");
  });

  it("refuses a send with neither a template nor a written body", async () => {
    // 0023's insert guard. Without it a row could reach the dispatcher with
    // nothing to say, and the dispatcher would skip it silently rather than
    // anyone finding out at the moment it was created.
    const leadId = await makeClaimedLead(orgId);

    const { error } = await admin().from("scheduled_sends").insert({
      org_id: orgId,
      lead_id: leadId,
      mailbox_id: mailboxId,
      step_number: 3,
      touch_kind: "followup",
      status: "planned",
      scheduled_at: DateTime.now().plus({ days: 1 }).toUTC().toISO(),
      scheduled_local: DateTime.now()
        .setZone("America/Chicago")
        .plus({ days: 1 })
        .toFormat("yyyy-MM-dd'T'HH:mm:ss"),
      prospect_timezone: "America/Chicago",
    });

    expect(error).not.toBeNull();
    expect(error!.message).toContain("template or a written body");
  });
});
