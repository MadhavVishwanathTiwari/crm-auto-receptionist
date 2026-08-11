// The two guards vs the foreign keys that clean up after them.
//
// Both of these failed in production before migration 0011, and neither was
// caught by anything: the harness's own cleanup() deletes an org and ignores
// the result, so twenty orgs and several hundred leads accumulated in the
// shared project without a single test going red.

import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  addMember,
  adminClient,
  cleanup,
  createTestOrg,
  createTestUser,
  type TestOrg,
  type TestUser,
} from "../setup/stack";

describe("cascade cleanup", () => {
  const strayOrgs: string[] = [];
  const strayUsers: string[] = [];

  let org: TestOrg;
  let owner: TestUser;

  beforeAll(async () => {
    org = await createTestOrg("cascade");
    owner = await createTestUser("cascade-owner");
    await addMember(org.id, owner.id, "member");
  }, 60_000);

  afterAll(async () => {
    await cleanup([org.id, ...strayOrgs], [owner.id, ...strayUsers]);
  }, 60_000);

  async function seedLead(orgId: string, client = owner.client) {
    const { data, error } = await client
      .from("leads")
      .insert({
        org_id: orgId,
        company_name: "Cascade Target",
        work_email: `owner-${randomUUID().slice(0, 8)}@cascade.test`,
        rating: 4.0,
      })
      .select("id")
      .single();
    if (error) throw new Error(`Could not seed lead: ${error.message}`);
    return data.id as string;
  }

  it("deletes an org that has leads and events", async () => {
    const doomed = await createTestOrg("cascade-doomed");
    const member = await createTestUser("cascade-doomed-user");
    strayUsers.push(member.id);
    await addMember(doomed.id, member.id, "member");

    const leadId = await seedLead(doomed.id, member.client);
    // Claiming writes a `claimed` event, so the org now has history — which is
    // exactly what used to make it undeletable.
    await member.client.rpc("claim_lead", { p_lead_id: leadId });

    const admin = adminClient();
    const { count: before } = await admin
      .from("lead_events")
      .select("id", { count: "exact", head: true })
      .eq("lead_id", leadId);
    expect(before).toBeGreaterThan(0);

    const { error } = await admin.from("orgs").delete().eq("id", doomed.id);
    expect(error).toBeNull();

    // Gone, and its children with it.
    const { data: orgs } = await admin.from("orgs").select("id").eq("id", doomed.id);
    expect(orgs).toEqual([]);
    const { count: after } = await admin
      .from("lead_events")
      .select("id", { count: "exact", head: true })
      .eq("lead_id", leadId);
    expect(after).toBe(0);
  }, 120_000);

  it("still refuses a direct delete of an event whose lead exists", async () => {
    const leadId = await seedLead(org.id);
    await owner.client.rpc("claim_lead", { p_lead_id: leadId });

    const admin = adminClient();
    const { data: events } = await admin
      .from("lead_events")
      .select("id")
      .eq("lead_id", leadId)
      .limit(1);
    const eventId = events?.[0]?.id as string;

    // Service role, so RLS is not what is being tested here — the trigger is.
    const { error } = await admin.from("lead_events").delete().eq("id", eventId);
    expect(error?.code).toBe("0A000");

    const { data: survived } = await admin
      .from("lead_events")
      .select("id")
      .eq("id", eventId);
    expect(survived).toHaveLength(1);
  }, 120_000);

  it("deletes a user who holds a claimed lead, returning it to the pool", async () => {
    const leaver = await createTestUser("cascade-leaver");
    await addMember(org.id, leaver.id, "member");

    const leadId = await seedLead(org.id, leaver.client);
    await leaver.client.rpc("claim_lead", { p_lead_id: leadId });

    const admin = adminClient();
    const { data: claimed } = await admin
      .from("leads")
      .select("claimed_by, claimed_at, claim_count")
      .eq("id", leadId)
      .single();
    expect(claimed?.claimed_by).toBe(leaver.id);
    const claimCount = claimed?.claim_count as number;

    const { error } = await admin.auth.admin.deleteUser(leaver.id);
    expect(error).toBeNull();

    const { data: released } = await admin
      .from("leads")
      .select("claimed_by, claimed_at, released_at, claim_count")
      .eq("id", leadId)
      .single();

    expect(released?.claimed_by).toBeNull();
    // The FK only nulls claimed_by; the guard tidies the rest so the lead does
    // not sit unclaimed while still carrying a claim timestamp.
    expect(released?.claimed_at).toBeNull();
    expect(released?.released_at).not.toBeNull();
    // Not a re-claim, so the counter must not have moved.
    expect(released?.claim_count).toBe(claimCount);
  }, 120_000);

  it("still refuses a hand-written ownership change", async () => {
    const leadId = await seedLead(org.id);

    const { error } = await owner.client
      .from("leads")
      .update({ claimed_by: owner.id })
      .eq("id", leadId)
      .select("id");

    expect(error?.code).toBe("42501");

    const admin = adminClient();
    const { data: unchanged } = await admin
      .from("leads")
      .select("claimed_by")
      .eq("id", leadId)
      .single();
    expect(unchanged?.claimed_by).toBeNull();
  }, 120_000);
});
