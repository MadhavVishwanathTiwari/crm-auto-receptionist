import { randomUUID } from "node:crypto";

import { DateTime } from "luxon";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { POST as dispatchSends } from "@/app/api/cron/dispatch-sends/route";

import { CLEAN_BODY, CLEAN_SUBJECT } from "../fixtures/template-vectors";
import {
  adminClient,
  cleanup,
  createTestOrg,
  createTestUser,
  type TestUser,
} from "../setup/stack";

// 0046: a send that was claimed and never reached the Gmail call goes back to
// the queue, and the dispatcher that held the claim can no longer send it.
// Before 0046 nothing moved a row out of `claimed`, so a dispatcher that died
// between claiming and sending froze its lead for good.
//
// Everything here runs as the service role, as the dispatcher does, so the
// operator is an owner of rows rather than a member of each org (org_members
// allows one org per user).

const CRON_SECRET = process.env.CRON_SECRET ?? "";
const ZONE = "America/Chicago";

const orgIds: string[] = [];
let operator: TestUser;

function admin() {
  return adminClient();
}

function minutesAgo(minutes: number): string {
  return DateTime.now().minus({ minutes }).toUTC().toISO()!;
}

/** An org with dry run off, one mailbox, one template, and one due send. */
async function dueSend(label: string, scheduledMinutesAgo = 1) {
  const org = await createTestOrg(label);
  orgIds.push(org.id);

  const { error: settingsError } = await admin()
    .from("org_settings")
    .update({ dry_run: false })
    .eq("org_id", org.id);
  if (settingsError) throw new Error(`org_settings: ${settingsError.message}`);

  const { data: mailbox, error: mailboxError } = await admin()
    .from("mailboxes")
    .insert({
      org_id: org.id,
      user_id: operator.id,
      email: `sender-${randomUUID().slice(0, 8)}@example.test`,
      display_name: "Ojas",
      timezone: "America/New_York",
      daily_cap: 20,
    })
    .select("id")
    .single();
  if (mailboxError) throw new Error(`mailbox: ${mailboxError.message}`);

  const { data: template, error: templateError } = await admin()
    .from("templates")
    .insert({
      org_id: org.id,
      name: `T1-${randomUUID().slice(0, 8)}`,
      step_number: 1,
      subject: CLEAN_SUBJECT,
      body: CLEAN_BODY,
      is_active: true,
    })
    .select("id")
    .single();
  if (templateError) throw new Error(`template: ${templateError.message}`);

  const { data: lead, error: leadError } = await admin()
    .from("leads")
    .insert({
      org_id: org.id,
      company_name: "Bright Smile Dental",
      first_name: "Dana",
      work_email: `owner-${randomUUID().slice(0, 8)}@prospect.test`,
      website: `https://${randomUUID().slice(0, 8)}.prospect.test`,
      timezone: ZONE,
      timezone_source: "import",
      claimed_by: operator.id,
      claimed_at: new Date().toISOString(),
    })
    .select("id")
    .single();
  if (leadError) throw new Error(`lead: ${leadError.message}`);

  const at = DateTime.now().minus({ minutes: scheduledMinutesAgo });
  const { data: send, error: sendError } = await admin()
    .from("scheduled_sends")
    .insert({
      org_id: org.id,
      lead_id: lead.id,
      mailbox_id: mailbox.id,
      template_id: template.id,
      step_number: 1,
      touch_kind: "first",
      status: "planned",
      scheduled_at: at.toUTC().toISO(),
      scheduled_local: at.setZone(ZONE).toFormat("yyyy-MM-dd'T'HH:mm:ss"),
      prospect_timezone: ZONE,
    })
    .select("id")
    .single();
  if (sendError) throw new Error(`scheduled_send: ${sendError.message}`);

  return { orgId: org.id, sendId: send.id as string };
}

async function claim(orgId: string): Promise<string> {
  const { data, error } = await admin().rpc("claim_due_sends", {
    p_org_id: orgId,
    p_limit: 5,
  });
  expect(error).toBeNull();
  expect(data).toHaveLength(1);
  return (data as { claim_token: string }[])[0]!.claim_token;
}

async function sendRow(sendId: string) {
  const { data } = await admin()
    .from("scheduled_sends")
    .select("status, claim_token, claimed_at, cap_date, outcome_reason")
    .eq("id", sendId)
    .single();
  return data!;
}

// ---------------------------------------------------------------------------

beforeAll(async () => {
  if (!CRON_SECRET) {
    throw new Error("CRON_SECRET must be set in .env for these tests.");
  }
  operator = await createTestUser("claims-op");
});

afterAll(async () => {
  await cleanup(orgIds, operator ? [operator.id] : []);
}, 120_000);

// ---------------------------------------------------------------------------

describe("an expired claim", () => {
  it("goes back to the queue, and the claim that held it can no longer send", async () => {
    const { orgId, sendId } = await dueSend("claims-expire");
    const token = await claim(orgId);

    // A claim minutes old is a dispatcher at work. Leave it alone.
    const { data: early } = await admin().rpc("release_expired_claims", {
      p_org_id: orgId,
    });
    expect(early).toBe(0);
    expect((await sendRow(sendId)).status).toBe("claimed");

    // A dispatcher that died holding it, longer ago than stall_minutes.
    const { error: ageError } = await admin()
      .from("scheduled_sends")
      .update({ claimed_at: minutesAgo(30) })
      .eq("id", sendId);
    expect(ageError).toBeNull();

    const { data: released, error } = await admin().rpc("release_expired_claims", {
      p_org_id: orgId,
    });
    expect(error).toBeNull();
    expect(released).toBe(1);

    const row = await sendRow(sendId);
    expect(row.status).toBe("planned");
    expect(row.claim_token).toBeNull();
    expect(row.claimed_at).toBeNull();
    // No longer counted against that day's cap.
    expect(row.cap_date).toBeNull();
    expect(row.outcome_reason).toContain("went back to the queue");

    // The point of no return refuses the old claim, so a dispatcher that was
    // merely slow rather than dead still never sends it.
    const { data: locked } = await admin().rpc("mark_send_sending", {
      p_send_id: sendId,
      p_claim_token: token,
    });
    expect(locked).toBe(false);
    expect((await sendRow(sendId)).status).toBe("planned");
  }, 180_000);

  it("is released by the dispatcher before it claims anything", async () => {
    // Scheduled two hours ago, outside the grace window, so once released it
    // is not claimable again and the run never reaches Gmail.
    const { orgId, sendId } = await dueSend("claims-dispatch", 120);

    const { error: claimError } = await admin()
      .from("scheduled_sends")
      .update({
        status: "claimed",
        claim_token: randomUUID(),
        claimed_at: minutesAgo(30),
      })
      .eq("id", sendId);
    expect(claimError).toBeNull();

    const response = await dispatchSends(
      new Request(`http://localhost/api/cron/dispatch-sends?org=${orgId}`, {
        method: "POST",
        headers: { authorization: `Bearer ${CRON_SECRET}` },
      }),
    );
    expect(response.status).toBe(200);

    const body = (await response.json()) as {
      reports: { released: number; claimed: number }[];
    };
    expect(body.reports[0]!.released).toBe(1);
    expect(body.reports[0]!.claimed).toBe(0);
    expect((await sendRow(sendId)).status).toBe("planned");
  }, 180_000);
});
