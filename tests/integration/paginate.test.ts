import { randomUUID } from "node:crypto";

import { afterAll, describe, expect, it } from "vitest";

import { PAGE_SIZE, selectAll, selectUpTo } from "@/lib/supabase/paginate";

import { adminClient, cleanup, createTestOrg } from "../setup/stack";

// PostgREST answers at most max_rows (1000) rows per response, and a larger
// .limit() is clamped without an error. The planner, the reply poller, /write
// and four screens asked for more and would have got 1000. These prove the
// helpers read past it, against the real PostgREST, and that the trap is real.

const orgIds: string[] = [];

afterAll(async () => {
  await cleanup(orgIds, []);
}, 120_000);

describe("reading past PostgREST's row cap", () => {
  it("selectAll returns every row where a plain .limit() stops at the cap", async () => {
    const admin = adminClient();
    const org = await createTestOrg("paginate");
    orgIds.push(org.id);

    const total = PAGE_SIZE + 250;
    const rows = Array.from({ length: total }, (_, i) => ({
      org_id: org.id,
      email_norm: `blocked-${i}-${randomUUID().slice(0, 6)}@prospect.test`,
      reason: "manual_dnc",
    }));
    for (let i = 0; i < rows.length; i += 500) {
      const { error } = await admin.from("suppressions").insert(rows.slice(i, i + 500));
      expect(error).toBeNull();
    }

    // The trap: no error, just a short answer.
    const { data: clamped, error: clampError } = await admin
      .from("suppressions")
      .select("id")
      .eq("org_id", org.id)
      .limit(5000);
    expect(clampError).toBeNull();
    expect(clamped).toHaveLength(PAGE_SIZE);

    const all = await selectAll<{ id: string }>(() =>
      admin.from("suppressions").select("id").eq("org_id", org.id),
    );
    expect(all.error).toBeNull();
    expect(all.data).toHaveLength(total);
    expect(new Set(all.data.map((row) => row.id)).size).toBe(total);

    const newest = await selectUpTo<{ id: string }>(
      () => admin.from("suppressions").select("id").eq("org_id", org.id).order("id"),
      PAGE_SIZE + 100,
    );
    expect(newest.error).toBeNull();
    expect(newest.data).toHaveLength(PAGE_SIZE + 100);
    expect(new Set(newest.data.map((row) => row.id)).size).toBe(PAGE_SIZE + 100);
  }, 180_000);
});
