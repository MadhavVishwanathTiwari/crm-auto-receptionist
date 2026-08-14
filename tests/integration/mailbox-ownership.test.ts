import { randomUUID } from "node:crypto";

import { DateTime } from "luxon";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  addMember,
  adminClient,
  cleanup,
  createTestOrg,
  createTestUser,
  runSql,
  type TestUser,
} from "../setup/stack";

// An email leaves from the mailbox of the person who wrote it.
//
// It did not, and nothing in the database said it had to. pickMailbox() was
// handed every sendable mailbox in the org and returned the emptiest, so a
// hand-written email went out over a colleague's name and the prospect's reply
// landed in a colleague's inbox. Filtering the candidate list in TypeScript is
// what makes the composer offer the right mailbox; it is NOT what makes the
// wrong one impossible, because this RPC is reachable by any member of the org.
// These are the assertions about the gate itself.
//
// Two things it must NOT do, either:
//
//   - refuse a second account belonging to the same human. madhav connected the
//     mailbox as one account and claimed the leads as another, so a strict
//     user_id comparison locks him out of his own 30 leads.
//   - refuse the mailbox a lead's thread already started on. dispatch-sends
//     reuses a Gmail threadId that only exists inside the account that issued
//     it, so a sequence is committed to its first mailbox whoever owns it now.

const orgIds: string[] = [];
const userIds: string[] = [];

let ojas: TestUser;
let madhavMailbox: TestUser; // connected the mailbox
let madhavLeads: TestUser; // claimed the leads
let orgId: string;
let ojasBox: string;
let madhavBox: string;

function admin() {
  return adminClient();
}

async function makeMailbox(owner: TestUser, label: string): Promise<string> {
  const { data, error } = await admin()
    .from("mailboxes")
    .insert({
      org_id: orgId,
      user_id: owner.id,
      email: `${label}-${randomUUID().slice(0, 8)}@example.test`,
      display_name: label,
      timezone: "Asia/Kolkata",
      daily_cap: 20,
    })
    .select("id")
    .single();
  if (error) throw new Error(`mailbox: ${error.message}`);
  return data.id as string;
}

async function makeClaimedLead(owner: TestUser): Promise<string> {
  const { data, error } = await admin()
    .from("leads")
    .insert({
      org_id: orgId,
      company_name: "Way Cool Plumbing & Air",
      work_email: `owner-${randomUUID().slice(0, 8)}@prospect.test`,
      website: `https://${randomUUID().slice(0, 8)}.prospect.test`,
      timezone: "America/Phoenix",
      timezone_source: "import",
      claimed_by: owner.id,
      claimed_at: new Date().toISOString(),
    })
    .select("id")
    .single();
  if (error) throw new Error(`lead: ${error.message}`);

  await admin()
    .from("lead_events")
    .insert({ org_id: orgId, lead_id: data.id, type: "claimed", actor_id: owner.id });

  return data.id as string;
}

async function queue(user: TestUser, leadId: string, mailboxId: string, step = 1) {
  const at = DateTime.now().setZone("America/Phoenix").plus({ days: 1 });

  return user.client.rpc("queue_composed_send", {
    p_lead_id: leadId,
    p_subject: "The calls nobody picks up",
    p_body: "Wrote this one by hand. Worth a look, or not?",
    p_scheduled_at: at.toUTC().toISO(),
    p_scheduled_local: at.toFormat("yyyy-MM-dd'T'HH:mm:ss"),
    p_mailbox_id: mailboxId,
    p_step: step,
    p_template_id: null,
  });
}

/**
 * Re-reads as the service role.
 *
 * A PostgREST write denied by RLS returns 204 with zero rows rather than an
 * error, so asserting on the error alone passes vacuously against a policy that
 * does nothing at all. These particular denials are RAISEs inside a SECURITY
 * DEFINER function and so do surface as errors -- but the row is checked
 * anyway, because the assertion that matters is what is in the table.
 */
async function liveSendsFor(leadId: string) {
  const { data } = await admin()
    .from("scheduled_sends")
    .select("id, step_number, status, mailbox_id, composed_by")
    .eq("lead_id", leadId)
    .order("step_number", { ascending: true });
  return data ?? [];
}

beforeAll(async () => {
  ojas = await createTestUser("mbown-ojas");
  madhavMailbox = await createTestUser("mbown-madhav-io");
  madhavLeads = await createTestUser("mbown-madhav-try");
  userIds.push(ojas.id, madhavMailbox.id, madhavLeads.id);

  const org = await createTestOrg("mbown");
  orgIds.push(org.id);
  orgId = org.id;

  await addMember(orgId, ojas.id, "member");
  await addMember(orgId, madhavMailbox.id, "admin");
  await addMember(orgId, madhavLeads.id, "admin");

  ojasBox = await makeMailbox(ojas, "Ojas");
  madhavBox = await makeMailbox(madhavMailbox, "Madhav");

  // The two madhav accounts are one human. This is what app.operator_aliases
  // records for the real project; seeded here so same_operator() has something
  // to resolve. Ojas is deliberately left out of every group.
  await runSql(
    `insert into app.operator_aliases (email, operator, note)
     values ($1, $3, 'test'), ($2, $3, 'test')
     on conflict (email) do nothing`,
    [madhavMailbox.email, madhavLeads.email, `madhav-${randomUUID().slice(0, 8)}`],
  );
}, 60_000);

afterAll(async () => {
  await runSql(`delete from app.operator_aliases where note = 'test'`);
  await cleanup(orgIds, userIds);
}, 60_000);

describe("queue_composed_send: whose mailbox", () => {
  it("refuses a colleague's mailbox, and writes nothing", async () => {
    const lead = await makeClaimedLead(ojas);

    const { error } = await queue(ojas, lead, madhavBox);

    expect(error).not.toBeNull();
    expect(error?.message).toMatch(/belongs to somebody else/i);

    // The assertion that actually binds: no row exists on the wrong mailbox.
    expect(await liveSendsFor(lead)).toEqual([]);
  });

  it("accepts the operator's own mailbox", async () => {
    const lead = await makeClaimedLead(ojas);

    const { error } = await queue(ojas, lead, ojasBox);
    expect(error).toBeNull();

    const sends = await liveSendsFor(lead);
    expect(sends).toHaveLength(1);
    expect(sends[0].mailbox_id).toBe(ojasBox);
    expect(sends[0].composed_by).toBe(ojas.id);
  });

  it("accepts a mailbox connected by the operator's other account", async () => {
    // The state of the real project: the lead is claimed by one madhav account
    // and the mailbox was connected by the other. Refusing this is a bug of its
    // own, and a larger one than the bug being fixed.
    const lead = await makeClaimedLead(madhavLeads);

    const { error } = await queue(madhavLeads, lead, madhavBox);
    expect(error).toBeNull();

    const sends = await liveSendsFor(lead);
    expect(sends).toHaveLength(1);
    expect(sends[0].mailbox_id).toBe(madhavBox);
  });

  it("keeps a lead on the mailbox its thread started on", async () => {
    // T1 went out from madhav@ before the lead moved to Ojas. The Gmail
    // threadId dispatch-sends will reuse only exists in that mailbox, so T2 has
    // to go from there too, even though it is not Ojas's account.
    const lead = await makeClaimedLead(ojas);

    const { error: sentError } = await admin()
      .from("scheduled_sends")
      .insert({
        org_id: orgId,
        lead_id: lead,
        mailbox_id: madhavBox,
        step_number: 1,
        touch_kind: "first",
        status: "sent",
        scheduled_at: DateTime.now().minus({ days: 4 }).toUTC().toISO(),
        scheduled_local: DateTime.now().minus({ days: 4 }).toFormat(
          "yyyy-MM-dd'T'HH:mm:ss",
        ),
        prospect_timezone: "America/Phoenix",
        sent_at: DateTime.now().minus({ days: 4 }).toUTC().toISO(),
        composed_body: "the first touch",
        composed_subject: "the first touch",
      });
    expect(sentError).toBeNull();

    const { error } = await queue(ojas, lead, madhavBox, 2);
    expect(error).toBeNull();

    const sends = await liveSendsFor(lead);
    expect(sends).toHaveLength(2);
    expect(sends[1].mailbox_id).toBe(madhavBox);
  });
});

describe("mailbox_senders", () => {
  it("groups both of one human's accounts onto their mailbox", async () => {
    const { data, error } = await madhavLeads.client.rpc("mailbox_senders");
    expect(error).toBeNull();

    const rows = (data ?? []) as { mailbox_id: string; user_id: string }[];
    const forMadhavBox = rows
      .filter((r) => r.mailbox_id === madhavBox)
      .map((r) => r.user_id)
      .sort();

    expect(forMadhavBox).toEqual([madhavMailbox.id, madhavLeads.id].sort());
  });

  it("does not put an unrelated operator on somebody else's mailbox", async () => {
    const { data } = await ojas.client.rpc("mailbox_senders");
    const rows = (data ?? []) as { mailbox_id: string; user_id: string }[];

    expect(
      rows.some((r) => r.mailbox_id === madhavBox && r.user_id === ojas.id),
    ).toBe(false);
    expect(
      rows.some((r) => r.mailbox_id === ojasBox && r.user_id === ojas.id),
    ).toBe(true);
  });

  it("refuses to report on an org the caller is not in", async () => {
    const other = await createTestOrg("mbown-other");
    orgIds.push(other.id);

    const { error } = await ojas.client.rpc("mailbox_senders", { p_org: other.id });
    expect(error).not.toBeNull();
    expect(error?.message).toMatch(/not your org/i);
  });
});

describe("reroute_planned_sends_to_owner", () => {
  it("moves a planned send to its owner and leaves a pinned lead alone", async () => {
    // One of each: a lead of Ojas's mis-routed onto madhav@ (the bug), and one
    // whose thread genuinely started on madhav@ (not the bug).
    const misrouted = await makeClaimedLead(ojas);
    const pinned = await makeClaimedLead(ojas);

    const soon = DateTime.now().plus({ days: 2 });
    const rows = [misrouted, pinned].map((leadId) => ({
      org_id: orgId,
      lead_id: leadId,
      mailbox_id: madhavBox,
      step_number: leadId === pinned ? 2 : 1,
      touch_kind: leadId === pinned ? "followup" : "first",
      status: "planned",
      scheduled_at: soon.toUTC().toISO(),
      scheduled_local: soon.toFormat("yyyy-MM-dd'T'HH:mm:ss"),
      prospect_timezone: "America/Phoenix",
      composed_body: "hand written",
      composed_subject: "hand written",
    }));

    const { error: insertError } = await admin()
      .from("scheduled_sends")
      .insert(rows);
    expect(insertError).toBeNull();

    // What pins the second lead: a touch that already went out from madhav@.
    await admin()
      .from("scheduled_sends")
      .insert({
        org_id: orgId,
        lead_id: pinned,
        mailbox_id: madhavBox,
        step_number: 1,
        touch_kind: "first",
        status: "sent",
        scheduled_at: DateTime.now().minus({ days: 5 }).toUTC().toISO(),
        scheduled_local: DateTime.now()
          .minus({ days: 5 })
          .toFormat("yyyy-MM-dd'T'HH:mm:ss"),
        prospect_timezone: "America/Phoenix",
        sent_at: DateTime.now().minus({ days: 5 }).toUTC().toISO(),
        composed_body: "the first touch",
        composed_subject: "the first touch",
      });

    // Dry run first: it must report without changing anything.
    const { data: dry, error: dryError } = await madhavLeads.client.rpc(
      "reroute_planned_sends_to_owner",
      { p_dry_run: true },
    );
    expect(dryError).toBeNull();

    const dryRows = (dry ?? []) as { lead_id: string; outcome: string }[];
    expect(dryRows.find((r) => r.lead_id === misrouted)?.outcome).toBe("would move");
    expect(dryRows.find((r) => r.lead_id === pinned)?.outcome).toMatch(/pinned/);

    const stillThere = await liveSendsFor(misrouted);
    expect(stillThere[0].mailbox_id).toBe(madhavBox);

    // Then for real.
    const { error: runError } = await madhavLeads.client.rpc(
      "reroute_planned_sends_to_owner",
      { p_dry_run: false },
    );
    expect(runError).toBeNull();

    const moved = await liveSendsFor(misrouted);
    expect(moved[0].mailbox_id).toBe(ojasBox);

    // The pinned lead's planned touch stayed where its thread is.
    const untouched = await liveSendsFor(pinned);
    expect(untouched.find((s) => s.status === "planned")?.mailbox_id).toBe(madhavBox);
  });

  it("needs admin", async () => {
    const { error } = await ojas.client.rpc("reroute_planned_sends_to_owner", {
      p_dry_run: true,
    });

    expect(error).not.toBeNull();
    expect(error?.message).toMatch(/only an admin/i);
  });
});
