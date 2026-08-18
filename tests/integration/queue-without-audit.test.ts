// "Send without an audit", which shipped in 0022 and never once worked.
//
// The leads screen inserted a `queued` event through the cookie-bound RLS
// client, but lead_events_insert permits only ('audited', 'note',
// 'manual_override'). PostgREST refused every row, a refusal is 204 with zero
// rows rather than an error, and the action reported "That lead is not yours to
// queue." for every lead including the caller's own.
//
// 0036 moves it to a definer RPC. Every test below fails against 0035.

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

describe("queue without an audit", () => {
  let org: TestOrg;
  let owner: TestUser;
  let other: TestUser;

  beforeAll(async () => {
    org = await createTestOrg("queue-noaudit");
    owner = await createTestUser("queue-noaudit-owner");
    other = await createTestUser("queue-noaudit-other");
    await addMember(org.id, owner.id, "member");
    await addMember(org.id, other.id, "member");
  }, 60_000);

  afterAll(async () => {
    await cleanup([org.id], [owner.id, other.id]);
  }, 60_000);

  async function seedClaimedLead() {
    const { data, error } = await owner.client
      .from("leads")
      .insert({
        org_id: org.id,
        company_name: "Not Worth An Audit",
        work_email: `owner-${randomUUID().slice(0, 8)}@no-audit.test`,
        rating: 4.1,
        timezone: "America/Chicago",
        timezone_source: "import",
      })
      .select("id")
      .single();
    if (error) throw new Error(`Could not seed lead: ${error.message}`);

    const leadId = data.id as string;
    const claim = await owner.client.rpc("claim_lead", { p_lead_id: leadId });
    if (claim.error) throw new Error(`Could not claim: ${claim.error.message}`);
    return leadId;
  }

  async function readStatus(leadId: string) {
    const { data } = await adminClient()
      .from("leads")
      .select("status")
      .eq("id", leadId)
      .single();
    return (data as { status: string }).status;
  }

  it("marks the lead queued", async () => {
    const leadId = await seedClaimedLead();
    expect(await readStatus(leadId)).toBe("claimed");

    const { error } = await owner.client.rpc("queue_lead_without_audit", {
      p_lead_id: leadId,
    });

    expect(error).toBeNull();
    // `queued` outranks `audited` in app.lead_status_from_events, which is what
    // opens the planner's gate without anybody auditing the lead.
    expect(await readStatus(leadId)).toBe("queued");
  }, 120_000);

  it("is idempotent", async () => {
    const leadId = await seedClaimedLead();

    await owner.client.rpc("queue_lead_without_audit", { p_lead_id: leadId });
    const second = await owner.client.rpc("queue_lead_without_audit", {
      p_lead_id: leadId,
    });

    expect(second.error).toBeNull();

    // The fixed dedupe_token against unique (lead_id, type, dedupe_token) is
    // what makes the second press a no-op instead of a second event.
    const { data: events } = await adminClient()
      .from("lead_events")
      .select("id")
      .eq("lead_id", leadId)
      .eq("type", "queued");

    expect(events).toHaveLength(1);
  }, 120_000);

  it("refuses another operator's lead", async () => {
    const leadId = await seedClaimedLead();

    const { error } = await other.client.rpc("queue_lead_without_audit", {
      p_lead_id: leadId,
    });

    expect(error?.code).toBe("42501");
    expect(await readStatus(leadId)).toBe("claimed");
  }, 120_000);

  it("still refuses a direct insert of a queued event", async () => {
    // The policy stayed narrow on purpose: it checks org_id and nothing else,
    // so widening it would have let either operator queue the other's leads.
    const leadId = await seedClaimedLead();

    const { error } = await owner.client
      .from("lead_events")
      .insert({
        org_id: org.id,
        lead_id: leadId,
        type: "queued",
        actor_id: owner.id,
        payload: {},
      })
      .select("id");

    // A `with check` violation on INSERT raises 42501 outright. It is NOT the
    // silent 204-with-zero-rows case — that one belongs to UPDATE and DELETE,
    // where a `using` clause filters the row out before there is anything to
    // violate. Which is exactly why the old code's zero-row branch never ran.
    expect(error?.code).toBe("42501");
    expect(await readStatus(leadId)).toBe("claimed");
  }, 120_000);
});
