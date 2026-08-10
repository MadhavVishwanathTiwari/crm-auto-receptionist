// The audit step: evidence in, status out.
//
// recordAudit() itself resolves its own session, so it cannot be called from
// here. What this covers is the part that can actually fail silently — the two
// RLS-governed writes it makes, and the trigger that turns the second one into
// a status change. A policy that refuses these returns 204 and zero rows rather
// than an error, so every assertion re-reads.

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  addMember,
  cleanup,
  createTestOrg,
  createTestUser,
  type TestOrg,
  type TestUser,
} from "../setup/stack";

const TZ = "America/Chicago";

describe("audit", () => {
  let org: TestOrg;
  let owner: TestUser;
  let other: TestUser;
  let leadId: string;

  beforeAll(async () => {
    org = await createTestOrg("audit");
    owner = await createTestUser("auditor");
    other = await createTestUser("bystander");
    await addMember(org.id, owner.id, "member");
    await addMember(org.id, other.id, "member");

    const { data, error } = await owner.client
      .from("leads")
      .insert({
        org_id: org.id,
        company_name: "Audit Target",
        work_email: "owner@audit-target.test",
        phone: "+1 312 555 0142",
        rating: 4.4,
        timezone: TZ,
        timezone_source: "manual",
      })
      .select("id")
      .single();
    if (error) throw new Error(`Could not seed the lead: ${error.message}`);
    leadId = data.id as string;
  }, 60_000);

  afterAll(async () => {
    await cleanup([org.id], [owner.id, other.id]);
  }, 60_000);

  it("refuses evidence on a lead claimed by someone else", async () => {
    const { error: claimError } = await owner.client.rpc("claim_lead", {
      p_lead_id: leadId,
    });
    expect(claimError).toBeNull();

    const { data, error } = await other.client
      .from("lead_evidence")
      .insert({
        org_id: org.id,
        lead_id: leadId,
        angle_type: "soft_text_audit",
        audited_at: new Date().toISOString(),
        audited_at_local: "2026-08-10T03:00:00",
        audit_timezone: TZ,
        outcome: "no response",
        created_by: other.id,
      })
      .select("id");

    // Either shape counts as a denial. Asserting only on `error` would pass
    // vacuously against a policy that let the row through.
    expect(error === null ? (data ?? []).length : 0).toBe(0);

    const { count } = await owner.client
      .from("lead_evidence")
      .select("id", { count: "exact", head: true })
      .eq("lead_id", leadId);
    expect(count).toBe(0);
  }, 120_000);

  it("records the audit and derives the status from the event", async () => {
    const auditedAt = new Date().toISOString();

    const { data: evidence, error: evidenceError } = await owner.client
      .from("lead_evidence")
      .insert({
        org_id: org.id,
        lead_id: leadId,
        angle_type: "soft_text_audit",
        audited_at: auditedAt,
        // A wall-clock reading, frozen at capture. Stored without an offset.
        audited_at_local: "2026-08-10T03:00:00",
        audit_timezone: TZ,
        response_delay_seconds: null,
        outcome: "no response",
        notes: "Texted the main line at 3am local.",
        created_by: owner.id,
      })
      .select("id, audited_at_local, audit_timezone");

    expect(evidenceError).toBeNull();
    expect(evidence).toHaveLength(1);
    // The frozen local reading must survive the round trip unshifted — if the
    // column were timestamptz this would come back converted.
    expect(evidence?.[0]?.audited_at_local).toContain("03:00:00");
    expect(evidence?.[0]?.audit_timezone).toBe(TZ);

    // Status is still `claimed`: evidence alone does not move it.
    const { data: midway } = await owner.client
      .from("leads")
      .select("status")
      .eq("id", leadId)
      .single();
    expect(midway?.status).toBe("claimed");

    const { data: event, error: eventError } = await owner.client
      .from("lead_events")
      .insert({
        org_id: org.id,
        lead_id: leadId,
        type: "audited",
        actor_id: owner.id,
        occurred_at: auditedAt,
        payload: { outcome: "no response", angle_type: "soft_text_audit" },
      })
      .select("id");

    expect(eventError).toBeNull();
    expect(event).toHaveLength(1);

    const { data: after } = await owner.client
      .from("leads")
      .select("status")
      .eq("id", leadId)
      .single();
    expect(after?.status).toBe("audited");
  }, 120_000);

  it("will not let a member forge a machine event", async () => {
    // `sent` is inserted by the dispatcher or the service role. A browser
    // claiming a lead was emailed would corrupt the pipeline silently.
    const { data, error } = await owner.client
      .from("lead_events")
      .insert({
        org_id: org.id,
        lead_id: leadId,
        type: "sent",
        actor_id: owner.id,
      })
      .select("id");

    expect(error === null ? (data ?? []).length : 0).toBe(0);

    const { data: after } = await owner.client
      .from("leads")
      .select("status")
      .eq("id", leadId)
      .single();
    expect(after?.status).toBe("audited");
  }, 120_000);
});
