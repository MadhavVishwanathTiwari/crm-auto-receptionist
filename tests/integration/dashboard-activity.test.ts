// dashboard_activity(): the figures the dashboard cannot count for itself.
//
// Three things are worth proving here and nothing else is:
//
//   1. The day series is GAP-FILLED. A quiet day has to arrive as a zero, or a
//      slow week renders as a busy one with fewer bars.
//   2. The operator roster COLLAPSES an alias group. This is the only reason
//      the function exists rather than a handful of head:true counts --
//      app.operator_aliases is revoked from `authenticated`, so TypeScript
//      cannot answer it at all.
//   3. The org predicate holds. The function is SECURITY DEFINER, so RLS is
//      bypassed inside it and `where org_id = v_org` is hand-written on every
//      subquery. Nothing but a test proves a hand-written predicate.

import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  addMember,
  adminClient,
  anonClient,
  cleanup,
  createTestOrg,
  createTestUser,
  runSql,
  type TestOrg,
  type TestUser,
} from "../setup/stack";

interface Activity {
  zone: string;
  days: number;
  series: { day: string; sent: number }[];
  sends: { planned: number; blocked: number; failed: number; sent: number; written: number };
  mailboxes: { email: string; used_today: number; daily_cap: number }[];
  events: { replied: number; bounced: number; unsubscribed: number; closed: number };
  stage_moves: Record<string, number>;
  open_alerts: number;
  operators: { operator: string; user_ids: string[]; emails: string[] }[];
  sent_by_operator: Record<string, number>;
}

describe("dashboard_activity", () => {
  let org: TestOrg;
  let stranger: TestOrg;
  let owner: TestUser;
  /** The same human as `owner`, at a second address. */
  let alias: TestUser;
  let outsider: TestUser;
  let operatorName: string;
  let mailboxId: string;

  beforeAll(async () => {
    org = await createTestOrg("dash");
    stranger = await createTestOrg("dash-other");
    owner = await createTestUser("dash-owner");
    alias = await createTestUser("dash-alias");
    outsider = await createTestUser("dash-outsider");
    await addMember(org.id, owner.id, "member");
    await addMember(org.id, alias.id, "member");
    await addMember(stranger.id, outsider.id, "admin");

    operatorName = `dash-op-${org.slug}`;
    await runSql(
      `insert into app.operator_aliases (email, operator, note)
       values ($1, $3, 'dashboard test'), ($2, $3, 'dashboard test')
       on conflict (email) do nothing`,
      [owner.email, alias.email, operatorName],
    );

    const admin = adminClient();

    const { data: mailbox, error: mailboxError } = await admin
      .from("mailboxes")
      .insert({
        org_id: org.id,
        user_id: owner.id,
        email: `dash-${randomUUID().slice(0, 8)}@example.test`,
        timezone: "America/New_York",
        daily_cap: 20,
      })
      .select("id")
      .single();
    if (mailboxError) throw new Error(`Could not seed mailbox: ${mailboxError.message}`);
    mailboxId = mailbox.id as string;

    // Three leads, not three sends against one: scheduled_sends_lead_step_live
    // permits a single live row per (lead, step) and counts `sent` as live,
    // which is the guard that makes a duplicate T1 impossible. Three businesses
    // each getting their first touch is also what the real data looks like.
    const leadIds: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      const { data: lead, error: leadError } = await admin
        .from("leads")
        .insert({
          org_id: org.id,
          company_name: `Dashboard Target ${i}`,
          work_email: `dash-${randomUUID().slice(0, 8)}@dash-target.test`,
          timezone: "America/Chicago",
          timezone_source: "import",
        })
        .select("id")
        .single();
      if (leadError) throw new Error(`Could not seed lead: ${leadError.message}`);
      leadIds.push(lead.id as string);
    }

    // Two on one day and one three days earlier, so there is a gap in the
    // middle of the window and today is empty.
    const day = (ago: number) => {
      const at = new Date();
      at.setUTCDate(at.getUTCDate() - ago);
      at.setUTCHours(15, 0, 0, 0);
      return at.toISOString();
    };

    const rows = [day(2), day(2), day(5)].map((sentAt, i) => ({
      org_id: org.id,
      lead_id: leadIds[i],
      mailbox_id: mailboxId,
      step_number: 1,
      touch_kind: "first",
      status: "sent",
      scheduled_at: sentAt,
      scheduled_local: sentAt.slice(0, 19),
      prospect_timezone: "America/Chicago",
      sent_at: sentAt,
      cap_date: sentAt.slice(0, 10),
      composed_body: "hand written",
      composed_subject: "hello",
    }));

    const { error: sendError } = await admin.from("scheduled_sends").insert(rows);
    if (sendError) throw new Error(`Could not seed sends: ${sendError.message}`);
  }, 120_000);

  afterAll(async () => {
    // cleanup() drops orgs and users only; alias rows are keyed by email and
    // would be orphaned, and this suite may have landed on the cloud project.
    await runSql(`delete from app.operator_aliases where email = any($1)`, [
      [owner.email, alias.email],
    ]);
    await cleanup([org.id, stranger.id], [owner.id, alias.id, outsider.id]);
  }, 60_000);

  async function activity(user: TestUser, days = 14): Promise<Activity> {
    const { data, error } = await user.client.rpc("dashboard_activity", {
      p_days: days,
    });
    if (error) throw new Error(`dashboard_activity failed: ${error.message}`);
    return data as Activity;
  }

  it("gap-fills the day series", async () => {
    const result = await activity(owner);

    expect(result.series).toHaveLength(14);
    // Every day in the window, whether or not anything happened on it. A chart
    // that omitted the quiet days would compress them out of existence.
    const zeros = result.series.filter((point) => point.sent === 0);
    expect(zeros.length).toBeGreaterThan(0);
    expect(result.series.reduce((sum, point) => sum + point.sent, 0)).toBe(3);
  }, 120_000);

  it("honours p_days and clamps it", async () => {
    expect((await activity(owner, 7)).series).toHaveLength(7);
    // least(greatest(coalesce(...), 1), 90): a caller cannot ask for a year.
    expect((await activity(owner, 500)).days).toBe(90);
  }, 120_000);

  it("counts the sends and marks the hand-written ones", async () => {
    const result = await activity(owner);
    expect(result.sends.sent).toBe(3);
    // composed_body is the only thing separating what somebody typed on /write
    // from what the planner rendered off a template.
    expect(result.sends.written).toBe(3);
  }, 120_000);

  it("collapses two accounts into one operator", async () => {
    const result = await activity(owner);

    const group = result.operators.find((entry) => entry.operator === operatorName);
    expect(group).toBeDefined();
    // The whole reason this is an RPC. app.operator_aliases has no API path, so
    // no amount of TypeScript could have worked this out.
    expect(group?.user_ids).toHaveLength(2);
    expect(group?.user_ids).toEqual(
      expect.arrayContaining([owner.id, alias.id]),
    );
  }, 120_000);

  it("attributes sends to the operator whose mailbox they left from", async () => {
    const result = await activity(owner);
    expect(result.sent_by_operator[operatorName]).toBe(3);
  }, 120_000);

  it("reports per-mailbox cap headroom", async () => {
    const result = await activity(owner);
    const mailbox = result.mailboxes.find((entry) => entry.daily_cap === 20);
    expect(mailbox).toBeDefined();
    // Counted on cap_date in the mailbox's own zone, the day the cap resets in.
    expect(mailbox?.used_today).toBe(0);
  }, 120_000);

  it("shows an outsider none of this org's numbers", async () => {
    // The predicate is hand-written on every subquery because SECURITY DEFINER
    // bypasses RLS. This is the test that proves it is actually there.
    const result = await activity(outsider);

    expect(result.sends.sent).toBe(0);
    expect(result.series.reduce((sum, point) => sum + point.sent, 0)).toBe(0);
    expect(result.mailboxes).toHaveLength(0);
    expect(
      result.operators.some((entry) => entry.operator === operatorName),
    ).toBe(false);
  }, 120_000);

  it("is not executable anonymously", async () => {
    const { error } = await anonClient().rpc("dashboard_activity", { p_days: 14 });
    expect(error).not.toBeNull();
  }, 120_000);
});
