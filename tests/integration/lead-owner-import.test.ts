// Ownership surviving the trip out of the Google Sheet.
//
// The sheet names an operator per row in `lead_owner`. That has to become
// leads.claimed_by plus a `claimed` event whose actor is that operator — not
// the person running the import — and it has to happen without going around
// leads_guard_protected_columns, which is the thing that makes ownership
// trustworthy in the first place.
//
// Everything here needs a real database: the guard is a trigger, the resolution
// of an address to an auth user reads auth.users through a SECURITY DEFINER
// function, and the status recompute is a statement-level trigger on
// lead_events. None of that exists in a unit test.

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { commitImport } from "@/lib/csv/commit";
import type { OrgContext } from "@/lib/org";

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

describe("lead owner import", () => {
  let org: TestOrg;
  let owner: TestUser; // admin, runs the import
  let mate: TestUser; // the other operator, named in the sheet
  let context: OrgContext;

  // `lead_owner` is what makes detectShape call this a legacy sheet, which is
  // also what the real file looks like.
  const csv = () =>
    [
      "company_name,work_email,website,lead_owner",
      `Mine Co,a@mine.test,https://mine.test,${owner.email}`,
      `Theirs Co,b@theirs.test,https://theirs.test,${mate.email}`,
      `Upper Co,c@upper.test,https://upper.test,${mate.email.toUpperCase()}`,
      "Nobody Co,d@nobody.test,https://nobody.test,",
      "Stranger Co,e@stranger.test,https://stranger.test,ghost@example.test",
    ].join("\n");

  beforeAll(async () => {
    org = await createTestOrg("owner-import");
    owner = await createTestUser("owner");
    mate = await createTestUser("mate");
    // Handing a lead to somebody else is an admin action, same as reassign_lead.
    await addMember(org.id, owner.id, "admin");
    await addMember(org.id, mate.id, "member");

    context = {
      supabase: owner.client,
      orgId: org.id,
      userId: owner.id,
    } as unknown as OrgContext;
  }, 60_000);

  afterAll(async () => {
    await cleanup([org.id], [owner.id, mate.id]);
  }, 60_000);

  it("claims each imported lead for the operator the sheet names", async () => {
    const result = await commitImport(context, {
      filename: "legacy.csv",
      text: csv(),
    });

    expect(result.counts.inserted).toBe(5);
    expect(result.ownershipError).toBeUndefined();
    expect(result.ownership).toEqual({ assigned: 3, unknown_owner: 1 });

    const { data: leads } = await owner.client
      .from("leads")
      .select("company_name, claimed_by, claimed_at, claim_count, status, raw")
      .order("company_name");

    const by = new Map(leads?.map((l) => [l.company_name as string, l]));

    // Assigned to whoever the row named, not to whoever ran the import.
    expect(by.get("Mine Co")?.claimed_by).toBe(owner.id);
    expect(by.get("Theirs Co")?.claimed_by).toBe(mate.id);
    // Addresses are compared lowercased, so the sheet's casing does not matter.
    expect(by.get("Upper Co")?.claimed_by).toBe(mate.id);

    // A blank owner and an address belonging to nobody both leave the lead in
    // the pool. Neither is allowed to cost us the lead itself.
    expect(by.get("Nobody Co")?.claimed_by).toBeNull();
    expect(by.get("Stranger Co")?.claimed_by).toBeNull();

    // Status is derived from the event, not written by the importer.
    expect(by.get("Theirs Co")?.status).toBe("claimed");
    expect(by.get("Nobody Co")?.status).toBe("imported");

    expect(by.get("Theirs Co")?.claimed_at).not.toBeNull();
    expect(by.get("Theirs Co")?.claim_count).toBe(1);

    // The original row is kept verbatim, which is what makes the backfill below
    // possible for leads imported before any of this existed.
    expect((by.get("Theirs Co")?.raw as Record<string, string>)?.lead_owner).toBe(
      mate.email,
    );

    // --- the event ----------------------------------------------------------
    const theirs = by.get("Theirs Co") as { claimed_by: string } | undefined;
    expect(theirs).toBeDefined();

    const { data: events } = await owner.client
      .from("lead_events")
      .select("type, actor_id, payload, lead_id")
      .eq("type", "claimed");

    const forTheirs = events?.find(
      (e) => (e.payload as Record<string, string>)?.owner_email === mate.email,
    );
    // The actor is the operator who owns it. A timeline that credited the
    // migration runner would be a lie about who worked the lead.
    expect(forTheirs?.actor_id).toBe(mate.id);
    expect((forTheirs?.payload as Record<string, string>)?.source).toBe(
      "sheet_import",
    );
    expect((forTheirs?.payload as Record<string, string>)?.assigned_by).toBe(
      owner.id,
    );
  }, 120_000);

  it("re-applies ownership from leads.raw without a re-import", async () => {
    const admin = adminClient();

    // A lead as it looked after the import that dropped lead_owner: the column
    // is sitting in `raw`, and nobody holds the lead.
    const { data: seeded, error } = await admin
      .from("leads")
      .insert({
        org_id: org.id,
        company_name: "Stranded Co",
        work_email: "f@stranded.test",
        raw: { company_name: "Stranded Co", lead_owner: mate.email },
      })
      .select("id")
      .single();
    if (error) throw new Error(`Could not seed: ${error.message}`);

    // --- dry run writes nothing ---------------------------------------------
    const { data: preview, error: previewError } = await owner.client.rpc(
      "backfill_lead_owners",
      { p_raw_key: "lead_owner", p_dry_run: true },
    );
    expect(previewError).toBeNull();

    const previewed = (preview ?? []) as Array<{ lead_id: string; outcome: string }>;
    expect(previewed.find((r) => r.lead_id === seeded.id)?.outcome).toBe("assigned");

    const { data: untouched } = await admin
      .from("leads")
      .select("claimed_by")
      .eq("id", seeded.id)
      .single();
    expect(untouched?.claimed_by).toBeNull();

    // --- and then it does ----------------------------------------------------
    const { data: applied, error: applyError } = await owner.client.rpc(
      "backfill_lead_owners",
      { p_raw_key: "lead_owner", p_dry_run: false },
    );
    expect(applyError).toBeNull();
    expect(
      ((applied ?? []) as Array<{ lead_id: string; outcome: string }>).find(
        (r) => r.lead_id === seeded.id,
      )?.outcome,
    ).toBe("assigned");

    const { data: claimed } = await admin
      .from("leads")
      .select("claimed_by, status")
      .eq("id", seeded.id)
      .single();
    expect(claimed?.claimed_by).toBe(mate.id);
    expect(claimed?.status).toBe("claimed");

    // Running it again finds nothing left to do: the pass only looks at
    // unclaimed leads, so it is safe to press twice.
    const { data: second } = await owner.client.rpc("backfill_lead_owners", {
      p_raw_key: "lead_owner",
      p_dry_run: false,
    });
    expect(
      ((second ?? []) as Array<{ lead_id: string }>).some(
        (r) => r.lead_id === seeded.id,
      ),
    ).toBe(false);
  }, 120_000);

  it("never takes a lead away from whoever holds it now", async () => {
    const admin = adminClient();

    const { data: seeded, error } = await admin
      .from("leads")
      .insert({
        org_id: org.id,
        company_name: "Held Co",
        work_email: "g@held.test",
        raw: { lead_owner: mate.email },
      })
      .select("id")
      .single();
    if (error) throw new Error(`Could not seed: ${error.message}`);

    // The admin claims it first — the sheet is a snapshot, the database is now.
    const { error: claimError } = await owner.client.rpc("claim_lead", {
      p_lead_id: seeded.id,
    });
    expect(claimError).toBeNull();

    const { data: rows } = await owner.client.rpc("backfill_lead_owners", {
      p_raw_key: "lead_owner",
      p_dry_run: false,
    });
    // Already claimed, so the pass does not even consider it.
    expect(
      ((rows ?? []) as Array<{ lead_id: string }>).some((r) => r.lead_id === seeded.id),
    ).toBe(false);

    const { data: still } = await admin
      .from("leads")
      .select("claimed_by")
      .eq("id", seeded.id)
      .single();
    expect(still?.claimed_by).toBe(owner.id);
  }, 120_000);

  it("refuses to let a member hand leads to anyone but themselves", async () => {
    const admin = adminClient();

    const { data: seeded, error } = await admin
      .from("leads")
      .insert({
        org_id: org.id,
        company_name: "Members Co",
        work_email: "h@members.test",
        raw: { lead_owner: owner.email },
      })
      .select("id")
      .single();
    if (error) throw new Error(`Could not seed: ${error.message}`);

    // mate is a plain member, and this row names the admin.
    const { error: refused } = await mate.client.rpc("assign_lead_owners", {
      p_assignments: [{ lead_id: seeded.id, owner_email: owner.email }],
    });
    expect(refused).not.toBeNull();
    expect(refused?.message).toContain("admin");

    // A denial has to be a denial. Re-read privileged, because a PostgREST
    // write refused by RLS comes back 204 with no error at all.
    const { data: after } = await admin
      .from("leads")
      .select("claimed_by")
      .eq("id", seeded.id)
      .single();
    expect(after?.claimed_by).toBeNull();

    // Claiming for themselves is not a privileged act, so it still works.
    const { data: allowed, error: allowedError } = await mate.client.rpc(
      "assign_lead_owners",
      { p_assignments: [{ lead_id: seeded.id, owner_email: mate.email }] },
    );
    expect(allowedError).toBeNull();
    expect((allowed as Array<{ outcome: string }>)[0]?.outcome).toBe("assigned");
  }, 120_000);

  // The real project has both of madhav's addresses signed in, both in the org,
  // both in alias group 'madhav'. Group-only resolution made every assignment
  // ambiguous. An account at exactly the address the sheet names outranks the
  // group, which is what 0026 added.
  it("prefers the account at the exact address over its alias group", async () => {
    const admin = adminClient();

    // Two accounts, one human, exactly like madhav's pair.
    const primary = await createTestUser("twin-primary");
    const secondary = await createTestUser("twin-secondary");
    await addMember(org.id, primary.id, "member");
    await addMember(org.id, secondary.id, "member");

    // app.operator_aliases is not exposed over PostgREST, by design.
    await runSql(
      `insert into app.operator_aliases (email, operator)
       values ($1, 'twin'), ($2, 'twin')`,
      [primary.email, secondary.email],
    );

    try {
      const { data: seeded } = await admin
        .from("leads")
        .insert({
          org_id: org.id,
          company_name: "Twin Co",
          work_email: "j@twin.test",
        })
        .select("id")
        .single();

      const { data, error } = await owner.client.rpc("assign_lead_owners", {
        p_assignments: [{ lead_id: seeded!.id, owner_email: secondary.email }],
      });

      expect(error).toBeNull();
      expect((data as Array<{ outcome: string }>)[0]?.outcome).toBe("assigned");

      // The address named, not the other member of its group.
      const { data: after } = await admin
        .from("leads")
        .select("claimed_by")
        .eq("id", seeded!.id)
        .single();
      expect(after?.claimed_by).toBe(secondary.id);
    } finally {
      await runSql(`delete from app.operator_aliases where email = any($1)`, [
        [primary.email, secondary.email],
      ]);
      await cleanup([], [primary.id, secondary.id]);
    }
  }, 120_000);

  it("does not resolve an operator from another org", async () => {
    const otherOrg = await createTestOrg("owner-import-other");
    const outsider = await createTestUser("outsider");
    await addMember(otherOrg.id, outsider.id, "member");

    try {
      const admin = adminClient();
      const { data: seeded } = await admin
        .from("leads")
        .insert({
          org_id: org.id,
          company_name: "Outsider Co",
          work_email: "i@outsider.test",
        })
        .select("id")
        .single();

      const { data } = await owner.client.rpc("assign_lead_owners", {
        p_assignments: [{ lead_id: seeded!.id, owner_email: outsider.email }],
      });

      // A real account, but not in this org, so it is not an operator here.
      expect((data as Array<{ outcome: string }>)[0]?.outcome).toBe("unknown_owner");
    } finally {
      await cleanup([otherOrg.id], [outsider.id]);
    }
  }, 120_000);
});
