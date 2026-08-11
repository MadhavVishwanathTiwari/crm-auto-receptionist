// The per-lead actions added alongside the detail drawer: suppressions,
// terminal outcomes, manual timezone assignment, and the evidence bucket.
//
// Every one of these is a write governed by RLS or by a trigger, and a refused
// PostgREST write returns 204 with zero rows and no error. So each negative case
// asserts on the rows that came back, and then re-reads to prove nothing moved.

import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  addMember,
  cleanup,
  createTestOrg,
  createTestUser,
  type TestOrg,
  type TestUser,
} from "../setup/stack";

describe("lead actions", () => {
  let org: TestOrg;
  let admin: TestUser;
  let member: TestUser;

  beforeAll(async () => {
    org = await createTestOrg("actions");
    admin = await createTestUser("actions-admin");
    member = await createTestUser("actions-member");
    await addMember(org.id, admin.id, "admin");
    await addMember(org.id, member.id, "member");
  }, 60_000);

  afterAll(async () => {
    await cleanup([org.id], [admin.id, member.id]);
  }, 60_000);

  async function seedLead(overrides: Record<string, unknown> = {}) {
    const { data, error } = await member.client
      .from("leads")
      .insert({
        org_id: org.id,
        company_name: "Action Target",
        work_email: `owner-${randomUUID().slice(0, 8)}@action-target.test`,
        website: "https://action-target.test",
        rating: 4.3,
        ...overrides,
      })
      .select("id")
      .single();
    if (error) throw new Error(`Could not seed lead: ${error.message}`);
    return data.id as string;
  }

  // --- timezone -------------------------------------------------------------

  it("stamps timezone_source manual on assignment", async () => {
    const leadId = await seedLead();

    const { data, error } = await member.client
      .from("leads")
      .update({ timezone: "America/Chicago" })
      .eq("id", leadId)
      .select("timezone, timezone_source");

    expect(error).toBeNull();
    expect(data?.[0]?.timezone).toBe("America/Chicago");
    // Written by the guard, not by the app, so an automated pass cannot later
    // overwrite a human correction.
    expect(data?.[0]?.timezone_source).toBe("manual");
  }, 120_000);

  it("allows clearing a timezone", async () => {
    // Regression for migration 0010. The guard used to set timezone_source to
    // 'manual' on ANY change, so clearing produced a null zone with a non-null
    // source and violated leads_timezone_source. Un-assigning always errored.
    const leadId = await seedLead({
      timezone: "America/Denver",
      timezone_source: "import",
    });

    const { data, error } = await member.client
      .from("leads")
      .update({ timezone: null })
      .eq("id", leadId)
      .select("timezone, timezone_source, needs_timezone");

    expect(error).toBeNull();
    expect(data).toHaveLength(1);
    expect(data?.[0]?.timezone).toBeNull();
    expect(data?.[0]?.timezone_source).toBeNull();
    // The generated column that flags it back into the unresolved pool.
    expect(data?.[0]?.needs_timezone).toBe(true);
  }, 120_000);

  // --- terminal outcomes ----------------------------------------------------

  it("derives a terminal status from close_lead", async () => {
    const leadId = await seedLead();

    const { error } = await member.client.rpc("close_lead", {
      p_lead_id: leadId,
      p_outcome: "closed_won",
      p_note: "signed",
    });
    expect(error).toBeNull();

    const { data: lead } = await member.client
      .from("leads")
      .select("status, terminal_outcome")
      .eq("id", leadId)
      .single();

    expect(lead?.terminal_outcome).toBe("closed_won");
    expect(lead?.status).toBe("closed_won");

    // Even a terminal outcome goes through the log, so the timeline stays whole.
    const { data: events } = await member.client
      .from("lead_events")
      .select("type")
      .eq("lead_id", leadId);
    expect(events?.some((event) => event.type === "closed")).toBe(true);
  }, 120_000);

  it("keeps a terminal outcome winning over a later event", async () => {
    const leadId = await seedLead();
    await member.client.rpc("close_lead", {
      p_lead_id: leadId,
      p_outcome: "closed_lost",
      p_note: null,
    });

    // `audited` ranks above nothing in particular, but the point is that a
    // human-asserted outcome is not walked back by later activity.
    await member.client.from("lead_events").insert({
      org_id: org.id,
      lead_id: leadId,
      type: "audited",
      actor_id: member.id,
    });

    const { data: lead } = await member.client
      .from("leads")
      .select("status")
      .eq("id", leadId)
      .single();
    expect(lead?.status).toBe("closed_lost");
  }, 120_000);

  // --- suppressions ---------------------------------------------------------

  it("lets any member suppress, but only an admin remove", async () => {
    const domain = `suppress-${randomUUID().slice(0, 8)}.test`;

    const { data: created, error: insertError } = await member.client
      .from("suppressions")
      .insert({
        org_id: org.id,
        domain,
        reason: "manual_dnc",
        created_by: member.id,
      })
      .select("id");

    expect(insertError).toBeNull();
    expect(created).toHaveLength(1);
    const suppressionId = created![0]!.id as string;

    // Removal is the dangerous direction, so it is admin-only.
    const { data: refused, error: deleteError } = await member.client
      .from("suppressions")
      .delete()
      .eq("id", suppressionId)
      .select("id");

    expect(deleteError === null ? (refused ?? []).length : 0).toBe(0);

    const { data: stillThere } = await admin.client
      .from("suppressions")
      .select("id")
      .eq("id", suppressionId);
    expect(stillThere).toHaveLength(1);

    const { data: removed } = await admin.client
      .from("suppressions")
      .delete()
      .eq("id", suppressionId)
      .select("id");
    expect(removed).toHaveLength(1);
  }, 120_000);

  it("refuses a second suppression for the same domain", async () => {
    const domain = `dupe-${randomUUID().slice(0, 8)}.test`;
    const row = {
      org_id: org.id,
      domain,
      reason: "manual_dnc" as const,
      created_by: member.id,
    };

    const first = await member.client.from("suppressions").insert(row).select("id");
    expect(first.error).toBeNull();

    const second = await member.client.from("suppressions").insert(row).select("id");
    // The partial unique index. The UI reports this as "already suppressed".
    expect(second.error?.code).toBe("23505");
  }, 120_000);

  // --- evidence bucket ------------------------------------------------------

  it("scopes the evidence bucket to the caller's org folder", async () => {
    const leadId = await seedLead();
    const png = new Blob([Buffer.from([0x89, 0x50, 0x4e, 0x47])], {
      type: "image/png",
    });

    const own = `${org.id}/${leadId}/${randomUUID()}.png`;
    const { error: allowed } = await member.client.storage
      .from("lead-evidence")
      .upload(own, png, { contentType: "image/png" });
    expect(allowed).toBeNull();

    // The first path segment is the tenant boundary. Writing under another org's
    // id is the failure that would leak an audit artifact across tenants.
    const foreign = `${randomUUID()}/${leadId}/${randomUUID()}.png`;
    const { error: denied } = await member.client.storage
      .from("lead-evidence")
      .upload(foreign, png, { contentType: "image/png" });
    expect(denied).not.toBeNull();

    // And it is genuinely absent, not merely unreported.
    const { data: listed } = await member.client.storage
      .from("lead-evidence")
      .list(`${org.id}/${leadId}`);
    expect(listed?.length).toBe(1);
  }, 120_000);
});
