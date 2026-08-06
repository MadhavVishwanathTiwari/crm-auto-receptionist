import { beforeAll, afterAll, beforeEach, describe, expect, it } from "vitest";

import {
  addMember,
  adminClient,
  anonClient,
  cleanup,
  createTestOrg,
  createTestUser,
  type TestOrg,
  type TestUser,
} from "../setup/stack";

let orgA: TestOrg;
let orgB: TestOrg;
let madhav: TestUser; // admin, org A
let ojas: TestUser; // member, org A
let mallory: TestUser; // member, org B

beforeAll(async () => {
  orgA = await createTestOrg("leads-a");
  orgB = await createTestOrg("leads-b");
  madhav = await createTestUser("madhav");
  ojas = await createTestUser("ojas");
  mallory = await createTestUser("mallory");
  await addMember(orgA.id, madhav.id, "admin");
  await addMember(orgA.id, ojas.id, "member");
  await addMember(orgB.id, mallory.id, "member");
});

afterAll(async () => {
  await cleanup([orgA.id, orgB.id], [madhav.id, ojas.id, mallory.id]);
});

let seq = 0;
async function makeLead(orgId: string, overrides: Record<string, unknown> = {}) {
  seq += 1;
  const { data, error } = await adminClient()
    .from("leads")
    .insert({
      org_id: orgId,
      company_name: `Acme HVAC ${seq}`,
      work_email: `owner${seq}-${Date.now()}@acmehvac${seq}.test`,
      rating: 4.6,
      timezone: "America/Phoenix",
      timezone_source: "import",
      ...overrides,
    })
    .select("*")
    .single();
  if (error) throw new Error(`fixture lead failed: ${error.message}`);
  return data;
}

/** Re-reads a lead bypassing RLS. The only sound way to assert a write failed. */
async function readAsAdmin(id: string) {
  const { data, error } = await adminClient()
    .from("leads")
    .select("*")
    .eq("id", id)
    .single();
  if (error) throw new Error(error.message);
  return data;
}

describe("the shared pool", () => {
  it("shows an unclaimed lead to both members", async () => {
    const lead = await makeLead(orgA.id);

    for (const user of [madhav, ojas]) {
      const { data, error } = await user.client
        .from("leads")
        .select("id, company_name")
        .eq("id", lead.id);

      expect(error).toBeNull();
      expect(data).toHaveLength(1);
    }
  });

  it("lets either member edit an unclaimed lead", async () => {
    const lead = await makeLead(orgA.id);

    const { data, error } = await ojas.client
      .from("leads")
      .update({ notes: "called, no answer" })
      .eq("id", lead.id)
      .select("id, notes");

    expect(error).toBeNull();
    expect(data).toHaveLength(1);
    expect((await readAsAdmin(lead.id)).notes).toBe("called, no answer");
  });

  it("hides a lead from another org entirely", async () => {
    const lead = await makeLead(orgA.id);

    const { data, error } = await mallory.client
      .from("leads")
      .select("id")
      .eq("id", lead.id);

    expect(error).toBeNull();
    expect(data).toEqual([]);
  });

  it("shows nothing to an unauthenticated client", async () => {
    await makeLead(orgA.id);
    const { data } = await anonClient().from("leads").select("id");
    expect(data ?? []).toEqual([]);
  });
});

describe("claiming", () => {
  it("assigns the lead and logs an event", async () => {
    const lead = await makeLead(orgA.id);

    const { data, error } = await madhav.client.rpc("claim_lead", {
      p_lead_id: lead.id,
    });
    expect(error).toBeNull();
    expect(data.claimed_by).toBe(madhav.id);

    const after = await readAsAdmin(lead.id);
    expect(after.claimed_by).toBe(madhav.id);
    expect(after.status).toBe("claimed"); // derived by the trigger, not written

    const { data: events } = await adminClient()
      .from("lead_events")
      .select("type, actor_id")
      .eq("lead_id", lead.id);
    expect(events!.some((e) => e.type === "claimed")).toBe(true);
  });

  it("makes a claimed lead read-only for the other member", async () => {
    const lead = await makeLead(orgA.id);
    await madhav.client.rpc("claim_lead", { p_lead_id: lead.id });

    // THE TRAP: PostgREST answers an UPDATE whose USING clause matched no rows
    // with 204 and an empty body. There is no error. Asserting `error !== null`
    // here would pass against a completely open policy.
    const { error } = await ojas.client
      .from("leads")
      .update({ notes: "ojas was here" })
      .eq("id", lead.id);
    expect(error).toBeNull();

    // The only sound assertion: re-read privileged and check nothing moved.
    expect((await readAsAdmin(lead.id)).notes).toBeNull();

    // And the client-side signal the app relies on: returning zero rows.
    const { data: returned } = await ojas.client
      .from("leads")
      .update({ notes: "again" })
      .eq("id", lead.id)
      .select("id");
    expect(returned).toEqual([]);
  });

  it("still lets the other member READ a claimed lead", async () => {
    const lead = await makeLead(orgA.id);
    await madhav.client.rpc("claim_lead", { p_lead_id: lead.id });

    const { data } = await ojas.client
      .from("leads")
      .select("id, claimed_by")
      .eq("id", lead.id);
    expect(data).toHaveLength(1);
  });

  it("lets an admin write a lead claimed by someone else", async () => {
    const lead = await makeLead(orgA.id);
    await ojas.client.rpc("claim_lead", { p_lead_id: lead.id });

    const { data, error } = await madhav.client
      .from("leads")
      .update({ notes: "admin override" })
      .eq("id", lead.id)
      .select("id");
    expect(error).toBeNull();
    expect(data).toHaveLength(1);
  });

  it("gives exactly one winner when both members race", async () => {
    const lead = await makeLead(orgA.id);

    const results = await Promise.all([
      madhav.client.rpc("claim_lead", { p_lead_id: lead.id }),
      ojas.client.rpc("claim_lead", { p_lead_id: lead.id }),
    ]);

    const winners = results.filter((r) => r.error === null);
    const losers = results.filter((r) => r.error !== null);
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);

    const after = await readAsAdmin(lead.id);
    expect([madhav.id, ojas.id]).toContain(after.claimed_by);
    expect(after.claim_count).toBe(1); // not 2 — the loser never applied
  });

  it("refuses to claim a lead in another org", async () => {
    const lead = await makeLead(orgA.id);
    const { error } = await mallory.client.rpc("claim_lead", {
      p_lead_id: lead.id,
    });
    expect(error).not.toBeNull();
    expect((await readAsAdmin(lead.id)).claimed_by).toBeNull();
  });

  it("releases back to the pool", async () => {
    const lead = await makeLead(orgA.id);
    await ojas.client.rpc("claim_lead", { p_lead_id: lead.id });
    const { error } = await ojas.client.rpc("release_lead", {
      p_lead_id: lead.id,
    });
    expect(error).toBeNull();
    expect((await readAsAdmin(lead.id)).claimed_by).toBeNull();
  });

  it("will not let a member reassign; an admin may", async () => {
    const lead = await makeLead(orgA.id);
    await ojas.client.rpc("claim_lead", { p_lead_id: lead.id });

    const { error: denied } = await ojas.client.rpc("reassign_lead", {
      p_lead_id: lead.id,
      p_to_user: madhav.id,
    });
    expect(denied).not.toBeNull();
    expect((await readAsAdmin(lead.id)).claimed_by).toBe(ojas.id);

    const { error: allowed } = await madhav.client.rpc("reassign_lead", {
      p_lead_id: lead.id,
      p_to_user: madhav.id,
    });
    expect(allowed).toBeNull();
    expect((await readAsAdmin(lead.id)).claimed_by).toBe(madhav.id);
  });
});

describe("system-managed columns", () => {
  let lead: { id: string };

  beforeEach(async () => {
    lead = await makeLead(orgA.id);
  });

  it("rejects writing status directly", async () => {
    const { error } = await ojas.client
      .from("leads")
      .update({ status: "replied" })
      .eq("id", lead.id);

    // Unlike an RLS filter, the guard trigger RAISES — the caller finds out.
    expect(error).not.toBeNull();
    expect((await readAsAdmin(lead.id)).status).toBe("imported");
  });

  it("rejects writing claimed_by directly", async () => {
    const { error } = await ojas.client
      .from("leads")
      .update({ claimed_by: ojas.id })
      .eq("id", lead.id);

    expect(error).not.toBeNull();
    expect((await readAsAdmin(lead.id)).claimed_by).toBeNull();
  });

  it("rejects writing demo URLs directly", async () => {
    const { error } = await ojas.client
      .from("leads")
      .update({ demo_txt_url: "https://autoreceptionist.io/sandbox/fake" })
      .eq("id", lead.id);

    expect(error).not.toBeNull();
    expect((await readAsAdmin(lead.id)).demo_txt_url).toBeNull();
  });

  it("marks a hand-edited timezone as manual", async () => {
    const { error } = await ojas.client
      .from("leads")
      .update({ timezone: "America/Denver" })
      .eq("id", lead.id);

    expect(error).toBeNull();
    const after = await readAsAdmin(lead.id);
    expect(after.timezone).toBe("America/Denver");
    // So a later automated pass cannot silently overwrite the correction.
    expect(after.timezone_source).toBe("manual");
  });
});

describe("the event log is append-only", () => {
  it("rejects UPDATE and DELETE even for the service role", async () => {
    const lead = await makeLead(orgA.id);
    await madhav.client.rpc("claim_lead", { p_lead_id: lead.id });

    const { data: events } = await adminClient()
      .from("lead_events")
      .select("id")
      .eq("lead_id", lead.id)
      .limit(1);
    const eventId = events![0].id;

    // The guard is a trigger rather than a withheld policy precisely so it
    // binds service_role too.
    const { error: updateError } = await adminClient()
      .from("lead_events")
      .update({ payload: { tampered: true } })
      .eq("id", eventId);
    expect(updateError).not.toBeNull();

    const { error: deleteError } = await adminClient()
      .from("lead_events")
      .delete()
      .eq("id", eventId);
    expect(deleteError).not.toBeNull();

    const { data: still } = await adminClient()
      .from("lead_events")
      .select("id")
      .eq("id", eventId);
    expect(still).toHaveLength(1);
  });

  it("lets a member author only human event types", async () => {
    const lead = await makeLead(orgA.id);

    const { error: ok } = await ojas.client.from("lead_events").insert({
      org_id: orgA.id,
      lead_id: lead.id,
      type: "audited",
      actor_id: ojas.id,
    });
    expect(ok).toBeNull();

    // A browser must not be able to fabricate a pipeline state.
    const { error: denied } = await ojas.client.from("lead_events").insert({
      org_id: orgA.id,
      lead_id: lead.id,
      type: "sent",
      actor_id: ojas.id,
    });
    expect(denied).not.toBeNull();

    expect((await readAsAdmin(lead.id)).status).toBe("audited");
  });
});

describe("status derivation", () => {
  it("advances to the highest-ranked event, ignoring arrival order", async () => {
    const lead = await makeLead(orgA.id);
    const admin = adminClient();

    await admin.from("lead_events").insert([
      { org_id: orgA.id, lead_id: lead.id, type: "qualified" },
      { org_id: orgA.id, lead_id: lead.id, type: "sent" },
    ]);
    expect((await readAsAdmin(lead.id)).status).toBe("sent");

    // A late `delivered` webhook after a `replied` must not walk status back.
    await admin
      .from("lead_events")
      .insert({ org_id: orgA.id, lead_id: lead.id, type: "replied" });
    await admin
      .from("lead_events")
      .insert({ org_id: orgA.id, lead_id: lead.id, type: "delivered" });

    const after = await readAsAdmin(lead.id);
    expect(after.status).toBe("replied");
    expect(after.halted_at).not.toBeNull();
    expect(after.halt_reason).toBe("replied");
  });

  it("does not let demo_ready move the pipeline backwards", async () => {
    const lead = await makeLead(orgA.id);
    const admin = adminClient();

    await admin
      .from("lead_events")
      .insert({ org_id: orgA.id, lead_id: lead.id, type: "sent" });
    await admin
      .from("lead_events")
      .insert({ org_id: orgA.id, lead_id: lead.id, type: "demo_ready" });

    // demo_ready is a capability, not a stage.
    expect((await readAsAdmin(lead.id)).status).toBe("sent");
  });

  it("lets close_lead set a terminal outcome that outranks later events", async () => {
    const lead = await makeLead(orgA.id);
    await madhav.client.rpc("claim_lead", { p_lead_id: lead.id });

    const { error } = await madhav.client.rpc("close_lead", {
      p_lead_id: lead.id,
      p_outcome: "closed_won",
      p_note: "signed",
    });
    expect(error).toBeNull();

    expect((await readAsAdmin(lead.id)).status).toBe("closed_won");

    // A stray provider webhook afterwards must not undo it.
    await adminClient()
      .from("lead_events")
      .insert({ org_id: orgA.id, lead_id: lead.id, type: "delivered" });
    expect((await readAsAdmin(lead.id)).status).toBe("closed_won");
  });
});

describe("org-wide dedupe", () => {
  it("rejects a second lead with the same normalized work_email", async () => {
    const email = `dupe-${Date.now()}@acmehvac.test`;
    await makeLead(orgA.id, { work_email: email });

    // Same mailbox, different spelling. The generated column collapses them.
    const { error } = await adminClient().from("leads").insert({
      org_id: orgA.id,
      company_name: "Acme HVAC (dupe)",
      work_email: email.toUpperCase(),
    });

    expect(error).not.toBeNull();
    expect(error!.code).toBe("23505");
  });

  it("allows the same email in a different org", async () => {
    const email = `shared-${Date.now()}@acmehvac.test`;
    await makeLead(orgA.id, { work_email: email });

    const { error } = await adminClient().from("leads").insert({
      org_id: orgB.id,
      company_name: "Acme HVAC (other org)",
      work_email: email,
    });
    expect(error).toBeNull();
  });

  it("does not collapse leads that merely share a domain or phone", async () => {
    const stamp = Date.now();
    await makeLead(orgA.id, {
      work_email: `a-${stamp}@sharedco.test`,
      website: "https://www.sharedco.test",
      phone: "(602) 555-0142",
    });

    // Near-duplicates belong in the review queue, not rejected at the door.
    const { error } = await adminClient().from("leads").insert({
      org_id: orgA.id,
      company_name: "Shared Co (second contact)",
      work_email: `b-${stamp}@sharedco.test`,
      website: "http://sharedco.test/contact",
      phone: "602-555-0142",
    });
    expect(error).toBeNull();
  });
});
