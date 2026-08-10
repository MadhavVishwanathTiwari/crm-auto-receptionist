// The golden path, end to end against a real database: a CSV goes in, and the
// four outcomes come out as leads, an import report, and a review queue.
//
// The partitioning rules themselves are covered by tests/unit/dedupe.test.ts.
// What can only be checked here is the half that talks to Postgres: that the
// generated dedupe columns (work_email_norm, website_domain) match what the
// TypeScript normalizers produced, that RLS actually permits every write the
// importer makes as an ordinary member, and that the counts on `imports` agree
// with the rows that landed.

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { commitImport } from "@/lib/csv/commit";
import type { OrgContext } from "@/lib/org";

import {
  addMember,
  cleanup,
  createTestOrg,
  createTestUser,
  type TestOrg,
  type TestUser,
} from "../setup/stack";

// One header row, then four rows chosen to land one in each outcome bucket.
const CSV = [
  "company_name,work_email,phone,website,rating",
  // New business, nothing like it in the org yet.
  "Fresh Co,hi@fresh.test,+1 415 555 0100,https://fresh.test,4.5",
  // Same work_email as the seeded lead: a hard duplicate, silently skipped.
  "Acme Again,OWNER@acme.com,,https://acme.com,4.1",
  // Different person at the same domain: a near-duplicate, needs a human.
  "Acme Sales,other@acme.com,,https://www.acme.com/contact,4.1",
  // No send target at all, so it can never be outreached.
  "No Email Inc,,+1 415 555 0199,https://no-email.test,3.9",
].join("\n");

describe("import commit", () => {
  let org: TestOrg;
  let user: TestUser;
  let context: OrgContext;
  let seededLeadId: string;

  beforeAll(async () => {
    org = await createTestOrg("import");
    user = await createTestUser("importer");
    await addMember(org.id, user.id, "member");

    // commitImport only ever reads these three fields. The cast stands in for
    // the cookie-bound client a request would carry; the token is a real one,
    // so RLS applies exactly as it would in the app.
    context = {
      supabase: user.client,
      orgId: org.id,
      userId: user.id,
    } as unknown as OrgContext;

    const { data, error } = await user.client
      .from("leads")
      .insert({
        org_id: org.id,
        company_name: "Acme",
        work_email: "owner@acme.com",
        website: "https://acme.com",
        rating: 4.2,
      })
      .select("id")
      .single();
    if (error) throw new Error(`Could not seed the existing lead: ${error.message}`);
    seededLeadId = data.id as string;
  }, 60_000);

  afterAll(async () => {
    await cleanup([org.id], [user.id]);
  }, 60_000);

  it("partitions the upload into the four outcomes", async () => {
    const result = await commitImport(context, {
      filename: "golden-path.csv",
      text: CSV,
    });

    expect(result.totalRows).toBe(4);
    expect(result.counts).toEqual({
      inserted: 1,
      skipped_duplicate: 1,
      flagged_review: 1,
      failed_validation: 1,
    });

    // --- the import record ---------------------------------------------------
    const { data: record } = await user.client
      .from("imports")
      .select("status, total_rows, counts, error, completed_at")
      .eq("id", result.importId)
      .single();

    expect(record?.status).toBe("completed");
    expect(record?.error).toBeNull();
    expect(record?.completed_at).not.toBeNull();
    expect(record?.counts).toEqual(result.counts);

    // --- the lead that was actually created ---------------------------------
    const { data: fresh } = await user.client
      .from("leads")
      .select("id, company_name, work_email_norm, website_domain, phone_e164, is_qualified, import_id, source")
      .eq("work_email_norm", "hi@fresh.test")
      .single();

    expect(fresh?.company_name).toBe("Fresh Co");
    expect(fresh?.website_domain).toBe("fresh.test");
    expect(fresh?.phone_e164).toBe("+14155550100");
    expect(fresh?.is_qualified).toBe(true);
    expect(fresh?.import_id).toBe(result.importId);
    // No Clay- or legacy-only columns in this file, so the shape is custom.
    expect(fresh?.source).toBe("csv");

    // Only the seeded lead and the one new one. Neither the duplicate nor the
    // flagged row may have quietly become a lead.
    const { count } = await user.client
      .from("leads")
      .select("id", { count: "exact", head: true });
    expect(count).toBe(2);

    // --- the per-row report -------------------------------------------------
    const { data: rows } = await user.client
      .from("import_rows")
      .select("id, row_index, outcome, lead_id, matched_lead_id, match_kind, error_detail")
      .eq("import_id", result.importId)
      .order("row_index");

    expect(rows).toHaveLength(4);
    expect(rows?.map((row) => row.outcome)).toEqual([
      "inserted",
      "skipped_duplicate",
      "flagged_review",
      "failed_validation",
    ]);

    // The inserted row is wired to the lead it created, which is what makes the
    // report navigable rather than just a tally.
    expect(rows?.[0]?.lead_id).toBe(fresh?.id);
    expect(rows?.[1]?.matched_lead_id).toBe(seededLeadId);
    expect(rows?.[1]?.match_kind).toBe("work_email");
    expect(rows?.[2]?.matched_lead_id).toBe(seededLeadId);
    expect(rows?.[2]?.match_kind).toBe("website_domain");
    expect(rows?.[3]?.error_detail).toContain("work_email");

    // --- the review queue ---------------------------------------------------
    const { data: reviews } = await user.client
      .from("dedupe_reviews")
      .select("existing_lead_id, match_kind, match_value, decision, incoming, import_row_id")
      .eq("import_id", result.importId);

    expect(reviews).toHaveLength(1);
    expect(reviews?.[0]?.existing_lead_id).toBe(seededLeadId);
    expect(reviews?.[0]?.match_kind).toBe("website_domain");
    expect(reviews?.[0]?.match_value).toBe("acme.com");
    expect(reviews?.[0]?.decision).toBe("pending");
    // The candidate is kept in full so the decision outlives the import.
    expect(
      (reviews?.[0]?.incoming as Record<string, unknown>)?.work_email,
    ).toBe("other@acme.com");
    // It points back at the row that produced it.
    expect(reviews?.[0]?.import_row_id).toBe(rows?.[2]?.id);
  }, 120_000);

  it("skips the whole file on a re-import, creating no new leads", async () => {
    const result = await commitImport(context, {
      filename: "golden-path.csv",
      text: CSV,
    });

    // The lead the first run created now owns hi@fresh.test, so that row is a
    // hard duplicate too. The acme.com row still only ever flags.
    expect(result.counts.inserted).toBe(0);
    expect(result.counts.skipped_duplicate).toBe(2);
    expect(result.counts.failed_validation).toBe(1);

    const { count } = await user.client
      .from("leads")
      .select("id", { count: "exact", head: true });
    expect(count).toBe(2);
  }, 120_000);

  it("does not leak the import to a member of another org", async () => {
    const otherOrg = await createTestOrg("import-other");
    const otherUser = await createTestUser("outsider");
    await addMember(otherOrg.id, otherUser.id, "member");

    try {
      const { data: imports } = await otherUser.client.from("imports").select("id");
      const { data: rows } = await otherUser.client.from("import_rows").select("id");
      const { data: reviews } = await otherUser.client.from("dedupe_reviews").select("id");

      expect(imports).toEqual([]);
      expect(rows).toEqual([]);
      expect(reviews).toEqual([]);
    } finally {
      await cleanup([otherOrg.id], [otherUser.id]);
    }
  }, 120_000);
});
