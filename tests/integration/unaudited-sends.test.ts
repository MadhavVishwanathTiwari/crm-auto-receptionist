import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { POST as planSends } from "@/app/api/cron/plan-sends/route";

import { CLEAN_BODY, CLEAN_SUBJECT } from "../fixtures/template-vectors";
import {
  adminClient,
  cleanup,
  createTestOrg,
  createTestUser,
  type TestUser,
} from "../setup/stack";

// Sending without an audit.
//
// The pipeline's default is that a first touch quotes an audit back, and 0019's
// copy enforces it by construction: every variable in it comes from
// lead_evidence. That is right for a lead worth the effort and wrong for the
// long tail of a scraped import, where auditing costs more than the lead is
// worth.
//
// So an operator may say "send this one without an audit", per lead. What that
// has to buy is exactly two things, and this asserts both:
//
//   1. The lead becomes sendable. A `queued` event outranks `audited`, so the
//      planner books it without any evidence existing.
//   2. It gets DIFFERENT copy. Selection is by leads.angle_type: null picks the
//      generic template, an angle picks the one pinned to it. Getting this
//      wrong sends a stranger an email quoting a phone call that never
//      happened, which is worse than sending nothing.
//
// The queue gate itself is deliberately not softened: a claimed lead that
// nobody has decided about is still not sendable. "Not every lead needs an
// audit" is a decision per lead, not the absence of a decision.

const CRON_SECRET = process.env.CRON_SECRET ?? "";

const orgIds: string[] = [];
let operator: TestUser;

function admin() {
  return adminClient();
}

async function makeTemplate(
  orgId: string,
  angle: string | null,
): Promise<string> {
  const { data, error } = await admin()
    .from("templates")
    .insert({
      org_id: orgId,
      name: `${angle ?? "generic"}-${randomUUID().slice(0, 8)}`,
      step_number: 1,
      angle_type: angle,
      subject: CLEAN_SUBJECT,
      body: CLEAN_BODY,
      is_active: true,
    })
    .select("id")
    .single();
  if (error) throw new Error(`template: ${error.message}`);
  return data.id as string;
}

/** A claimed, qualified, zoned lead with no events beyond the claim. */
async function makeClaimedLead(orgId: string): Promise<string> {
  const { data, error } = await admin()
    .from("leads")
    .insert({
      org_id: orgId,
      company_name: "Riverbend Auto Repair",
      work_email: `owner-${randomUUID().slice(0, 8)}@prospect.test`,
      website: `https://${randomUUID().slice(0, 8)}.prospect.test`,
      rating: 4.4,
      timezone: "America/Chicago",
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
    type: "claimed",
    actor_id: operator.id,
  });
  if (eventError) throw new Error(`claimed event: ${eventError.message}`);

  return data.id as string;
}

async function addEvent(orgId: string, leadId: string, type: string) {
  const { error } = await admin()
    .from("lead_events")
    .insert({ org_id: orgId, lead_id: leadId, type, actor_id: operator.id });
  if (error) throw new Error(`${type} event: ${error.message}`);
}

async function statusOf(leadId: string): Promise<string> {
  const { data } = await admin()
    .from("leads")
    .select("status")
    .eq("id", leadId)
    .single();
  return data!.status as string;
}

async function plannedSend(leadId: string) {
  const { data } = await admin()
    .from("scheduled_sends")
    .select("id, step_number, status, template_id")
    .eq("lead_id", leadId)
    .maybeSingle();
  return data;
}

function cronRequest(orgId: string) {
  return new Request(`http://localhost/api/cron/plan-sends?org=${orgId}`, {
    method: "POST",
    headers: { authorization: `Bearer ${CRON_SECRET}` },
  });
}

// ---------------------------------------------------------------------------

let orgId: string;
let genericTemplate: string;
let auditTemplate: string;

beforeAll(async () => {
  operator = await createTestUser("unaudited-operator");

  const org = await createTestOrg("unaudited");
  orgIds.push(org.id);
  orgId = org.id;

  const { error } = await admin()
    .from("org_settings")
    .update({ dry_run: false })
    .eq("org_id", orgId);
  if (error) throw new Error(`org_settings: ${error.message}`);

  const { error: memberError } = await admin()
    .from("org_members")
    .insert({ org_id: orgId, user_id: operator.id, role: "admin" });
  if (memberError) throw new Error(`member: ${memberError.message}`);

  const { error: mailboxError } = await admin().from("mailboxes").insert({
    org_id: orgId,
    user_id: operator.id,
    email: `sender-${randomUUID().slice(0, 8)}@example.test`,
    display_name: "Madhav",
    timezone: "Asia/Kolkata",
    daily_cap: 20,
  });
  if (mailboxError) throw new Error(`mailbox: ${mailboxError.message}`);

  genericTemplate = await makeTemplate(orgId, null);
  auditTemplate = await makeTemplate(orgId, "soft_text_audit");
}, 60_000);

afterAll(async () => {
  await cleanup(orgIds, [operator.id]);
}, 60_000);

describe("sending without an audit", () => {
  it("leaves a merely claimed lead unplanned", async () => {
    // The gate that stays. A lead nobody has decided about is not sendable, and
    // that is the difference between "an audit is optional" and "an audit is
    // skipped by default".
    const leadId = await makeClaimedLead(orgId);
    expect(await statusOf(leadId)).toBe("claimed");

    await planSends(cronRequest(orgId));

    expect(await plannedSend(leadId)).toBeNull();
  });

  it("plans a lead queued without an audit, using the generic copy", async () => {
    const leadId = await makeClaimedLead(orgId);
    await addEvent(orgId, leadId, "queued");

    // Derived, never typed: the event is what moves it.
    expect(await statusOf(leadId)).toBe("queued");

    await planSends(cronRequest(orgId));

    const send = await plannedSend(leadId);
    expect(send).not.toBeNull();
    expect(send!.status).toBe("planned");
    expect(send!.step_number).toBe(1);
    // The crux. angle_type is null on this lead because nobody audited it, so
    // templateFor() has to fall through to the template that quotes nothing.
    expect(send!.template_id).toBe(genericTemplate);
  });

  it("plans an audited lead using the copy pinned to its angle", async () => {
    const leadId = await makeClaimedLead(orgId);
    await addEvent(orgId, leadId, "audited");

    // What the audit screen now stamps, and what selects the audit copy.
    const { error } = await admin()
      .from("leads")
      .update({ angle_type: "soft_text_audit" })
      .eq("id", leadId);
    expect(error).toBeNull();

    await planSends(cronRequest(orgId));

    const send = await plannedSend(leadId);
    expect(send).not.toBeNull();
    expect(send!.template_id).toBe(auditTemplate);
  });

  it("still refuses a queued lead with no resolvable timezone", async () => {
    // Queueing without an audit relaxes one rule and must not relax the other.
    // A lead with no zone is refused by a trigger, not only by the planner's
    // WHERE clause, and that guard binds the service role too.
    const leadId = await makeClaimedLead(orgId);
    await admin().from("leads").update({ timezone: null }).eq("id", leadId);
    await addEvent(orgId, leadId, "queued");

    await planSends(cronRequest(orgId));

    expect(await plannedSend(leadId)).toBeNull();
  });
});
