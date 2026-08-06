import { beforeAll, afterAll, describe, expect, it } from "vitest";

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

// Org A mirrors production: Madhav (admin) and Ojas (member) in one org.
// Org B exists purely to prove tenant isolation.
let orgA: TestOrg;
let orgB: TestOrg;
let madhav: TestUser;
let ojas: TestUser;
let mallory: TestUser;

beforeAll(async () => {
  orgA = await createTestOrg("org-a");
  orgB = await createTestOrg("org-b");

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

describe("org visibility", () => {
  it("shows a member their own org", async () => {
    const { data, error } = await madhav.client
      .from("orgs")
      .select("id, slug")
      .eq("id", orgA.id);

    expect(error).toBeNull();
    expect(data).toHaveLength(1);
    expect(data![0].id).toBe(orgA.id);
  });

  it("hides another org entirely", async () => {
    const { data, error } = await mallory.client
      .from("orgs")
      .select("id")
      .eq("id", orgA.id);

    // RLS filters rather than rejects: the query succeeds and returns nothing.
    // That is exactly why the negative write tests below cannot assert on
    // `error` — see the comment in "rejects a member writing settings".
    expect(error).toBeNull();
    expect(data).toEqual([]);
  });

  it("hides everything from an unauthenticated client", async () => {
    const anon = anonClient();

    for (const table of ["orgs", "org_members", "org_settings"]) {
      const { data } = await anon.from(table).select("*");
      expect(data ?? []).toEqual([]);
    }
  });
});

describe("membership visibility", () => {
  it("lets both members of an org see each other", async () => {
    for (const user of [madhav, ojas]) {
      const { data, error } = await user.client
        .from("org_members")
        .select("user_id, role");

      expect(error).toBeNull();
      const ids = (data ?? []).map((r) => r.user_id).sort();
      expect(ids).toEqual([madhav.id, ojas.id].sort());
    }
  });

  it("does not leak members across orgs", async () => {
    const { data } = await mallory.client.from("org_members").select("user_id");
    expect((data ?? []).map((r) => r.user_id)).toEqual([mallory.id]);
  });
});

describe("admin-only writes", () => {
  it("rejects a member writing settings", async () => {
    // THE TRAP: PostgREST answers an UPDATE whose USING clause matched no rows
    // with 204 and an empty body. There is no error. A test asserting
    // `error !== null` here passes against a completely open policy.
    //
    // The only sound assertion is to re-read as a privileged client and check
    // the value did not move.
    const { error } = await ojas.client
      .from("org_settings")
      .update({ dry_run: false })
      .eq("org_id", orgA.id);

    expect(error).toBeNull(); // documents the trap rather than relying on it

    const { data } = await adminClient()
      .from("org_settings")
      .select("dry_run")
      .eq("org_id", orgA.id)
      .single();

    expect(data!.dry_run).toBe(true); // unchanged: the write was filtered out
  });

  it("allows an admin to write settings", async () => {
    const { data, error } = await madhav.client
      .from("org_settings")
      .update({ slot_grace_minutes: 25 })
      .eq("org_id", orgA.id)
      .select("slot_grace_minutes");

    expect(error).toBeNull();
    // Returning rows is the client-side signal that a write was actually
    // applied. An empty array here would mean RLS silently dropped it.
    expect(data).toHaveLength(1);
    expect(data![0].slot_grace_minutes).toBe(25);

    await adminClient()
      .from("org_settings")
      .update({ slot_grace_minutes: 20 })
      .eq("org_id", orgA.id);
  });

  it("does not let a member of another org touch settings", async () => {
    await mallory.client
      .from("org_settings")
      .update({ dry_run: false })
      .eq("org_id", orgA.id);

    const { data } = await adminClient()
      .from("org_settings")
      .select("dry_run")
      .eq("org_id", orgA.id)
      .single();

    expect(data!.dry_run).toBe(true);
  });
});

describe("helper functions are not reachable over HTTP", () => {
  it("does not expose app.current_org_id() as an RPC", async () => {
    // PostgREST exposes only the `public` schema. Helpers live in `app`
    // precisely so a browser can never call them.
    const { error } = await madhav.client.rpc("current_org_id");
    expect(error).not.toBeNull();
  });
});
