import { describe, expect, it } from "vitest";

import { collectLookupKeys, partitionRows, type ExistingKeys } from "@/lib/csv/dedupe";
import type { MappedLead } from "@/lib/csv/mapping";

function row(values: Record<string, unknown>, errors: string[] = []): MappedLead {
  return { values, cleanedFields: [], errors };
}

const NO_EXISTING: ExistingKeys[] = [];

describe("partitionRows", () => {
  it("inserts a clean new lead", () => {
    const result = partitionRows(
      [row({ work_email: "gabe@experthvac.com", company_name: "Expert HVAC" })],
      NO_EXISTING,
    );

    expect(result.counts).toEqual({
      inserted: 1,
      skipped_duplicate: 0,
      flagged_review: 0,
      failed_validation: 0,
    });
  });

  it("skips a lead already in the database, matching on the normalized email", () => {
    const existing: ExistingKeys[] = [
      {
        id: "lead-1",
        work_email_norm: "gabe@experthvac.com",
        place_id: null,
        website_domain: null,
        phone_e164: null,
      },
    ];

    // Different spelling, same mailbox.
    const result = partitionRows(
      [row({ work_email: "Gabe@ExpertHVAC.com" })],
      existing,
    );

    expect(result.counts.skipped_duplicate).toBe(1);
    expect(result.decisions[0]).toMatchObject({
      outcome: "skipped_duplicate",
      matchedLeadId: "lead-1",
    });
  });

  it("collapses duplicates inside one file", () => {
    // Otherwise the second row hits a unique violation at insert time and the
    // whole chunk fails for a reason the report cannot explain.
    const result = partitionRows(
      [
        row({ work_email: "first.last@gmail.com" }),
        row({ work_email: "firstlast+leads@googlemail.com" }),
      ],
      NO_EXISTING,
    );

    expect(result.counts.inserted).toBe(1);
    expect(result.counts.skipped_duplicate).toBe(1);
    expect(result.decisions[1]).toMatchObject({
      outcome: "skipped_duplicate",
      matchedLeadId: null,
    });
  });

  it("flags a near-duplicate rather than inserting or dropping it", () => {
    const existing: ExistingKeys[] = [
      {
        id: "lead-1",
        work_email_norm: "owner@sharedco.test",
        place_id: null,
        website_domain: "sharedco.test",
        phone_e164: null,
      },
    ];

    const result = partitionRows(
      [row({ work_email: "manager@sharedco.test", website: "https://www.sharedco.test/contact" })],
      existing,
    );

    // Not inserted (a human decides) and not dropped (it might be a real second
    // contact at the same company).
    expect(result.counts).toMatchObject({ inserted: 0, flagged_review: 1 });
    expect(result.decisions[0]).toMatchObject({
      outcome: "flagged_review",
      matchedLeadId: "lead-1",
      matchKind: "website_domain",
      matchValue: "sharedco.test",
    });
  });

  it("prefers place_id over domain over phone when several match", () => {
    const existing: ExistingKeys[] = [
      {
        id: "lead-1",
        work_email_norm: "a@x.test",
        place_id: "ChIJabc",
        website_domain: "x.test",
        phone_e164: "+16025550142",
      },
    ];

    const result = partitionRows(
      [
        row({
          work_email: "b@x.test",
          place_id: "ChIJabc",
          website: "x.test",
          phone: "602-555-0142",
        }),
      ],
      existing,
    );

    expect(result.decisions[0]).toMatchObject({ matchKind: "place_id" });
  });

  it("inserts both when two NEW rows share a business", () => {
    // A review row must point at an existing lead, and neither of these has
    // been inserted yet, so there is nothing to point at. Both are real
    // contacts at that company; the org-wide unique on work_email still stops
    // an actual duplicate, and the next import touching this business will
    // flag against whichever of these landed.
    const result = partitionRows(
      [
        row({ work_email: "a@newco.test", place_id: "ChIJnew" }),
        row({ work_email: "b@newco.test", place_id: "ChIJnew" }),
      ],
      NO_EXISTING,
    );

    expect(result.counts).toMatchObject({ inserted: 2, flagged_review: 0 });
  });

  it("fails a row with no usable work_email", () => {
    const result = partitionRows(
      [
        row({ work_email: null }, ["no usable work_email"]),
        row({ work_email: "Response" }),
      ],
      NO_EXISTING,
    );

    expect(result.counts.failed_validation).toBe(2);
  });

  it("makes every row land in exactly one bucket", () => {
    const rows = [
      row({ work_email: "new@a.test" }),
      row({ work_email: "dupe@b.test" }),
      row({ work_email: "near@c.test", website: "c.test" }),
      row({}, ["no company_name"]),
    ];
    const existing: ExistingKeys[] = [
      { id: "l1", work_email_norm: "dupe@b.test", place_id: null, website_domain: null, phone_e164: null },
      { id: "l2", work_email_norm: "other@c.test", place_id: null, website_domain: "c.test", phone_e164: null },
    ];

    const result = partitionRows(rows, existing);
    const total = Object.values(result.counts).reduce((a, b) => a + b, 0);

    // This is what makes the import report add up.
    expect(total).toBe(rows.length);
    expect(result.counts).toEqual({
      inserted: 1,
      skipped_duplicate: 1,
      flagged_review: 1,
      failed_validation: 1,
    });
  });

  it("does not treat leads with no phone or domain as sharing one", () => {
    const existing: ExistingKeys[] = [
      { id: "l1", work_email_norm: "a@a.test", place_id: null, website_domain: null, phone_e164: null },
    ];
    const result = partitionRows([row({ work_email: "b@b.test" })], existing);
    expect(result.counts.inserted).toBe(1);
  });
});

describe("collectLookupKeys", () => {
  it("returns the distinct normalized keys an upload needs to look up", () => {
    const keys = collectLookupKeys([
      row({ work_email: "A@X.com", website: "https://www.x.com", phone: "(602) 555-0142" }),
      row({ work_email: "a@x.com", website: "http://x.com/about", phone: "602-555-0142" }),
      row({ work_email: "b@y.com", place_id: "ChIJ1" }),
    ]);

    expect(keys.emails.sort()).toEqual(["a@x.com", "b@y.com"]);
    expect(keys.domains).toEqual(["x.com"]);
    expect(keys.phones).toEqual(["+16025550142"]);
    expect(keys.placeIds).toEqual(["ChIJ1"]);
  });
});
