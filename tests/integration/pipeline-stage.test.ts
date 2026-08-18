// leads.stage: derived from the event log, guarded against direct writes, and
// — unlike leads.status — free to move backwards.
//
// The negative cases matter most here. A refused PostgREST write is 204 with
// zero rows and no error, and a trigger that raises is an error with no write,
// so each one asserts what came back AND re-reads as a privileged client to
// prove the column did not move.

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

describe("pipeline stage", () => {
  let org: TestOrg;
  let admin: TestUser;
  let owner: TestUser;
  let other: TestUser;

  beforeAll(async () => {
    org = await createTestOrg("stage");
    admin = await createTestUser("stage-admin");
    owner = await createTestUser("stage-owner");
    other = await createTestUser("stage-other");
    await addMember(org.id, admin.id, "admin");
    await addMember(org.id, owner.id, "member");
    await addMember(org.id, other.id, "member");
  }, 60_000);

  afterAll(async () => {
    await cleanup([org.id], [admin.id, owner.id, other.id]);
  }, 60_000);

  /** A lead owned by `owner`, claimed through the RPC as the app does it. */
  async function seedClaimedLead(overrides: Record<string, unknown> = {}) {
    const { data, error } = await owner.client
      .from("leads")
      .insert({
        org_id: org.id,
        company_name: "Stage Target",
        work_email: `owner-${randomUUID().slice(0, 8)}@stage-target.test`,
        rating: 4.4,
        timezone: "America/Chicago",
        timezone_source: "import",
        ...overrides,
      })
      .select("id")
      .single();
    if (error) throw new Error(`Could not seed lead: ${error.message}`);

    const leadId = data.id as string;
    const claim = await owner.client.rpc("claim_lead", { p_lead_id: leadId });
    if (claim.error) throw new Error(`Could not claim: ${claim.error.message}`);
    return leadId;
  }

  async function readStage(leadId: string) {
    const { data } = await adminClient()
      .from("leads")
      .select("stage, stage_changed_at, status, terminal_outcome")
      .eq("id", leadId)
      .single();
    return data as {
      stage: string;
      stage_changed_at: string | null;
      status: string;
      terminal_outcome: string | null;
    };
  }

  /** Inserts an event the browser is not allowed to write, as the machine does. */
  async function seedEvent(leadId: string, type: string, occurredAt?: string) {
    const { error } = await adminClient()
      .from("lead_events")
      .insert({
        org_id: org.id,
        lead_id: leadId,
        type,
        actor_id: null,
        ...(occurredAt ? { occurred_at: occurredAt } : {}),
      });
    if (error) throw new Error(`Could not seed ${type}: ${error.message}`);
  }

  // --- derivation -----------------------------------------------------------

  it("starts at prospect with no stage events", async () => {
    const leadId = await seedClaimedLead();
    expect((await readStage(leadId)).stage).toBe("prospect");
  }, 120_000);

  it("derives engaged from a reply, with nobody moving it", async () => {
    // The board populating itself is the whole point of this fallback: an
    // operator should not have to do bookkeeping the reply already implies.
    const leadId = await seedClaimedLead();
    await seedEvent(leadId, "replied");

    const row = await readStage(leadId);
    expect(row.stage).toBe("engaged");
    expect(row.status).toBe("replied");
    // Derived rather than asserted, so there is no explicit move to timestamp.
    expect(row.stage_changed_at).toBeNull();
  }, 120_000);

  it("moves on set_lead_stage and stamps stage_changed_at", async () => {
    const leadId = await seedClaimedLead();

    const { error } = await owner.client.rpc("set_lead_stage", {
      p_lead_id: leadId,
      p_stage: "meeting",
      p_note: "call booked",
    });
    expect(error).toBeNull();

    const row = await readStage(leadId);
    expect(row.stage).toBe("meeting");
    expect(row.stage_changed_at).not.toBeNull();

    const { data: events } = await adminClient()
      .from("lead_events")
      .select("type, payload")
      .eq("lead_id", leadId)
      .eq("type", "stage_changed");

    expect(events).toHaveLength(1);
    expect(events?.[0]?.payload).toMatchObject({
      from: "prospect",
      to: "meeting",
      note: "call booked",
    });
  }, 120_000);

  it("moves backwards, which lead_status can never do", async () => {
    const leadId = await seedClaimedLead();

    await owner.client.rpc("set_lead_stage", { p_lead_id: leadId, p_stage: "meeting" });
    expect((await readStage(leadId)).stage).toBe("meeting");

    // The no-show. Ranked derivation would refuse this; last-write-wins is why
    // stage is a second column instead of more lead_status values.
    const { error } = await owner.client.rpc("set_lead_stage", {
      p_lead_id: leadId,
      p_stage: "engaged",
    });
    expect(error).toBeNull();
    expect((await readStage(leadId)).stage).toBe("engaged");
  }, 120_000);

  it("keeps an explicit park through a later reply", async () => {
    // A lead deliberately put in nurture must not be yanked back to engaged by
    // the next reply. The reply raises an alert; the human decides.
    const leadId = await seedClaimedLead();

    await owner.client.rpc("set_lead_stage", { p_lead_id: leadId, p_stage: "nurture" });
    await seedEvent(leadId, "replied");

    const row = await readStage(leadId);
    expect(row.stage).toBe("nurture");
    expect(row.status).toBe("replied");
  }, 120_000);

  it("writes no event when the stage is already what you asked for", async () => {
    const leadId = await seedClaimedLead();

    await owner.client.rpc("set_lead_stage", { p_lead_id: leadId, p_stage: "meeting" });
    await owner.client.rpc("set_lead_stage", { p_lead_id: leadId, p_stage: "meeting" });

    const { data: events } = await adminClient()
      .from("lead_events")
      .select("id")
      .eq("lead_id", leadId)
      .eq("type", "stage_changed");

    expect(events).toHaveLength(1);
  }, 120_000);

  // --- the guard ------------------------------------------------------------

  it("refuses a direct write to stage", async () => {
    const leadId = await seedClaimedLead();

    const { error } = await owner.client
      .from("leads")
      .update({ stage: "proposal" })
      .eq("id", leadId)
      .select("id");

    // A trigger raising is an error rather than a silent 204, because RLS let
    // the statement through first — this lead really is the caller's.
    expect(error?.code).toBe("42501");

    // Asserting on the error alone would pass vacuously against a guard that
    // raised and wrote anyway, so prove the column did not move.
    expect((await readStage(leadId)).stage).toBe("prospect");
  }, 120_000);

  it("refuses a direct write to stage_changed_at", async () => {
    const leadId = await seedClaimedLead();

    const { error } = await owner.client
      .from("leads")
      .update({ stage_changed_at: new Date().toISOString() })
      .eq("id", leadId)
      .select("id");

    expect(error?.code).toBe("42501");
    expect((await readStage(leadId)).stage_changed_at).toBeNull();
  }, 120_000);

  // --- who may move it ------------------------------------------------------

  it("refuses another operator's lead", async () => {
    const leadId = await seedClaimedLead();

    const { error } = await other.client.rpc("set_lead_stage", {
      p_lead_id: leadId,
      p_stage: "meeting",
    });

    expect(error?.code).toBe("42501");
    expect((await readStage(leadId)).stage).toBe("prospect");
  }, 120_000);

  it("lets an admin move somebody else's lead", async () => {
    const leadId = await seedClaimedLead();

    const { error } = await admin.client.rpc("set_lead_stage", {
      p_lead_id: leadId,
      p_stage: "proposal",
    });

    expect(error).toBeNull();
    expect((await readStage(leadId)).stage).toBe("proposal");
  }, 120_000);

  it("refuses a closed lead", async () => {
    const leadId = await seedClaimedLead();
    await owner.client.rpc("set_lead_stage", { p_lead_id: leadId, p_stage: "proposal" });

    const closed = await owner.client.rpc("close_lead", {
      p_lead_id: leadId,
      p_outcome: "closed_lost",
      p_note: "went with somebody else",
    });
    expect(closed.error).toBeNull();

    const { error } = await owner.client.rpc("set_lead_stage", {
      p_lead_id: leadId,
      p_stage: "meeting",
    });
    expect(error?.code).toBe("22023");

    // The stage it died at survives the close, which is what makes "how far did
    // this get" answerable afterwards.
    const row = await readStage(leadId);
    expect(row.stage).toBe("proposal");
    expect(row.terminal_outcome).toBe("closed_lost");
  }, 120_000);

  // --- notes ----------------------------------------------------------------

  it("accepts a note and does not let it move status", async () => {
    const leadId = await seedClaimedLead();
    const before = (await readStage(leadId)).status;

    const { data, error } = await owner.client
      .from("lead_events")
      .insert({
        org_id: org.id,
        lead_id: leadId,
        type: "note",
        actor_id: owner.id,
        payload: { body: "left a voicemail, try again Tuesday" },
      })
      .select("id");

    expect(error).toBeNull();
    expect(data).toHaveLength(1);
    // rank 0 in app.lead_status_from_events: commentary is not progress.
    expect((await readStage(leadId)).status).toBe(before);
  }, 120_000);
});
