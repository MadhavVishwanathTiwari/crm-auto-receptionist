// close_lead(): who may record a terminal outcome, and that it may only be
// recorded once.
//
// 0038 changed two things about a function that had sat untouched since 0004.
// Both are exercised here, and the alias case is the one worth reading: it is
// deliberately run as a `member`, because running it as an admin is exactly
// what let the bug hide for 34 migrations. app.is_admin() is the third disjunct
// of the ownership check, and both of madhav's accounts are seeded admin, so in
// production the strict comparison in front of it was never reached.
//
// The negative cases re-read as a privileged client. A PostgREST write refused
// by RLS is 204 with zero rows and no error, and asserting on the error alone
// passes vacuously against a policy that is not enforcing anything.

import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  addMember,
  adminClient,
  cleanup,
  createTestOrg,
  createTestUser,
  runSql,
  type TestOrg,
  type TestUser,
} from "../setup/stack";

describe("close_lead", () => {
  let org: TestOrg;
  let admin: TestUser;
  let owner: TestUser;
  let other: TestUser;
  /** The same human as `owner`, at a second address. A member, not an admin. */
  let alias: TestUser;

  beforeAll(async () => {
    org = await createTestOrg("close");
    admin = await createTestUser("close-admin");
    owner = await createTestUser("close-owner");
    other = await createTestUser("close-other");
    alias = await createTestUser("close-alias");
    await addMember(org.id, admin.id, "admin");
    await addMember(org.id, owner.id, "member");
    await addMember(org.id, other.id, "member");
    await addMember(org.id, alias.id, "member");

    // app.operator_aliases has no API path on purpose, so this comes in through
    // the door the migrations use. createTestUser generates lowercase
    // @example.test addresses, which satisfy operator_aliases_email_normalized.
    await runSql(
      `insert into app.operator_aliases (email, operator, note)
       values ($1, $3, 'close-lead test'), ($2, $3, 'close-lead test')
       on conflict (email) do nothing`,
      [owner.email, alias.email, `close-test-${org.slug}`],
    );
  }, 60_000);

  afterAll(async () => {
    // cleanup() drops orgs and users only. Alias rows are keyed by email, so
    // they would be orphaned here, and this suite may have landed on cloud.
    await runSql(`delete from app.operator_aliases where email = any($1)`, [
      [owner.email, alias.email],
    ]);
    await cleanup([org.id], [admin.id, owner.id, other.id, alias.id]);
  }, 60_000);

  async function seedLead(claim = true) {
    const { data, error } = await owner.client
      .from("leads")
      .insert({
        org_id: org.id,
        company_name: "Close Target",
        work_email: `owner-${randomUUID().slice(0, 8)}@close-target.test`,
        timezone: "America/Chicago",
        timezone_source: "import",
      })
      .select("id")
      .single();
    if (error) throw new Error(`Could not seed lead: ${error.message}`);

    const leadId = data.id as string;
    if (claim) {
      const { error: claimError } = await owner.client.rpc("claim_lead", {
        p_lead_id: leadId,
      });
      if (claimError) throw new Error(`Could not claim: ${claimError.message}`);
    }
    return leadId;
  }

  async function readAsAdmin(leadId: string) {
    const { data } = await adminClient()
      .from("leads")
      .select("status, stage, terminal_outcome")
      .eq("id", leadId)
      .single();
    return data as {
      status: string;
      stage: string;
      terminal_outcome: string | null;
    };
  }

  async function closedEvents(leadId: string) {
    const { data } = await adminClient()
      .from("lead_events")
      .select("id, payload")
      .eq("lead_id", leadId)
      .eq("type", "closed");
    return (data ?? []) as { id: string; payload: Record<string, unknown> }[];
  }

  it("lets the owner close their own lead", async () => {
    const leadId = await seedLead();

    const { error } = await owner.client.rpc("close_lead", {
      p_lead_id: leadId,
      p_outcome: "closed_won",
      p_note: "signed",
    });

    expect(error).toBeNull();
    const row = await readAsAdmin(leadId);
    expect(row.terminal_outcome).toBe("closed_won");
    // Derived by the trigger from the `closed` event, not typed.
    expect(row.status).toBe("closed_won");
    expect(await closedEvents(leadId)).toHaveLength(1);
  }, 120_000);

  it("closes an unclaimed lead", async () => {
    const leadId = await seedLead(false);

    const { error } = await other.client.rpc("close_lead", {
      p_lead_id: leadId,
      p_outcome: "do_not_contact",
      p_note: null,
    });

    expect(error).toBeNull();
    expect((await readAsAdmin(leadId)).terminal_outcome).toBe("do_not_contact");
  }, 120_000);

  it("refuses another member, and writes nothing", async () => {
    const leadId = await seedLead();

    const { error } = await other.client.rpc("close_lead", {
      p_lead_id: leadId,
      p_outcome: "closed_lost",
      p_note: null,
    });

    expect(error?.code).toBe("42501");
    // The assertion that matters: the error alone would pass against a function
    // that raised and wrote anyway.
    expect((await readAsAdmin(leadId)).terminal_outcome).toBeNull();
    expect(await closedEvents(leadId)).toHaveLength(0);
  }, 120_000);

  it("lets an admin close somebody else's lead", async () => {
    const leadId = await seedLead();

    const { error } = await admin.client.rpc("close_lead", {
      p_lead_id: leadId,
      p_outcome: "closed_lost",
      p_note: null,
    });

    expect(error).toBeNull();
    expect((await readAsAdmin(leadId)).terminal_outcome).toBe("closed_lost");
  }, 120_000);

  it("lets an operator's second account close their own lead", async () => {
    // This is the test that proves 0038 does anything, and it is run as a
    // MEMBER on purpose. As an admin it passes against the old strict
    // comparison too, which is precisely how the bug survived in production:
    // both of madhav's accounts are admins, so app.is_admin() answered first
    // and the broken check was never reached.
    const leadId = await seedLead();

    const { error } = await alias.client.rpc("close_lead", {
      p_lead_id: leadId,
      p_outcome: "closed_won",
      p_note: "same human, other address",
    });

    expect(error).toBeNull();
    expect((await readAsAdmin(leadId)).terminal_outcome).toBe("closed_won");
  }, 120_000);

  it("refuses a second close and keeps the first outcome", async () => {
    const leadId = await seedLead();
    const first = await owner.client.rpc("close_lead", {
      p_lead_id: leadId,
      p_outcome: "closed_won",
      p_note: "signed",
    });
    expect(first.error).toBeNull();

    const { error } = await owner.client.rpc("close_lead", {
      p_lead_id: leadId,
      p_outcome: "closed_lost",
      p_note: "misdrop",
    });

    // Same errcode set_lead_stage uses for the same situation.
    expect(error?.code).toBe("22023");
    // Before 0038 this silently rewrote the outcome and appended a second
    // `closed` event, leaving a timeline that said both. Won -> Lost is one
    // accidental drag on the board.
    expect((await readAsAdmin(leadId)).terminal_outcome).toBe("closed_won");
    expect(await closedEvents(leadId)).toHaveLength(1);
  }, 120_000);

  it("keeps the stage the lead died at", async () => {
    const leadId = await seedLead();
    await owner.client.rpc("set_lead_stage", {
      p_lead_id: leadId,
      p_stage: "proposal",
    });

    await owner.client.rpc("close_lead", {
      p_lead_id: leadId,
      p_outcome: "closed_lost",
      p_note: null,
    });

    // columnFor() files it under the outcome; the stage is what makes "how far
    // did this get before we lost it" answerable.
    const row = await readAsAdmin(leadId);
    expect(row.stage).toBe("proposal");
    expect(row.terminal_outcome).toBe("closed_lost");
  }, 120_000);
});
