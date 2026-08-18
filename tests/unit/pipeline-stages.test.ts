import { describe, expect, it } from "vitest";

import {
  BOARD_COLUMNS,
  type BoardLead,
  columnFor,
  countsTowardPipeline,
  dealValue,
  formatMoney,
  isOverdue,
  pipelineValue,
  weightedValue,
  wonValue,
} from "@/lib/pipeline/stages";

const DEFAULT_VALUE = 997;

function lead(overrides: Partial<BoardLead> = {}): BoardLead {
  return {
    stage: "engaged",
    terminal_outcome: null,
    deal_value: null,
    next_action_at: null,
    ...overrides,
  };
}

describe("columnFor", () => {
  it("uses the stage for an open lead", () => {
    expect(columnFor(lead({ stage: "meeting" }))).toBe("meeting");
  });

  it("prefers terminal_outcome over the stage", () => {
    // A closed lead keeps the stage it died at, so the stage alone would file it
    // back among the live deals.
    expect(
      columnFor(lead({ stage: "proposal", terminal_outcome: "closed_won" })),
    ).toBe("closed_won");
  });

  it("has a column for every outcome close_lead can write", () => {
    for (const outcome of ["closed_won", "closed_lost", "do_not_contact"]) {
      expect(BOARD_COLUMNS).toContain(columnFor(lead({ terminal_outcome: outcome })));
    }
  });
});

describe("dealValue", () => {
  it("falls back to the org default", () => {
    expect(dealValue({ deal_value: null }, DEFAULT_VALUE)).toBe(997);
  });

  it("uses an override", () => {
    expect(dealValue({ deal_value: 2491 }, DEFAULT_VALUE)).toBe(2491);
  });

  it("accepts numeric quoted as a string", () => {
    // PostgREST sends numeric as a bare JSON number at these magnitudes and
    // quotes it only when a double would lose precision. Covered so the board
    // cannot render NaN if one ever arrives that way.
    expect(dealValue({ deal_value: "2491.00" }, DEFAULT_VALUE)).toBe(2491);
  });

  it("falls back rather than producing NaN on junk", () => {
    expect(dealValue({ deal_value: "not a number" }, DEFAULT_VALUE)).toBe(997);
  });
});

describe("pipeline value", () => {
  it("excludes prospect", () => {
    // The reason this rule exists: thousands of unworked leads at the default
    // value is a headline number nobody believes.
    expect(countsTowardPipeline(lead({ stage: "prospect" }))).toBe(false);
    expect(pipelineValue([lead({ stage: "prospect" })], DEFAULT_VALUE)).toBe(0);
  });

  it("excludes closed leads, won or lost", () => {
    expect(
      countsTowardPipeline(lead({ stage: "proposal", terminal_outcome: "closed_won" })),
    ).toBe(false);
    expect(
      pipelineValue(
        [lead({ stage: "proposal", terminal_outcome: "closed_lost" })],
        DEFAULT_VALUE,
      ),
    ).toBe(0);
  });

  it("sums the open stages", () => {
    const rows = [
      lead({ stage: "engaged" }),
      lead({ stage: "meeting" }),
      lead({ stage: "proposal", deal_value: 2491 }),
      lead({ stage: "nurture" }),
      lead({ stage: "prospect" }),
    ];
    expect(pipelineValue(rows, DEFAULT_VALUE)).toBe(997 * 3 + 2491);
  });

  it("discounts by stage on the weighted figure", () => {
    const rows = [lead({ stage: "meeting" })];
    expect(weightedValue(rows, DEFAULT_VALUE)).toBeCloseTo(997 * 0.3, 5);
  });

  it("counts only won leads as won", () => {
    const rows = [
      lead({ stage: "proposal", terminal_outcome: "closed_won" }),
      lead({ stage: "proposal", terminal_outcome: "closed_lost" }),
      lead({ stage: "meeting" }),
    ];
    expect(wonValue(rows, DEFAULT_VALUE)).toBe(997);
  });
});

describe("isOverdue", () => {
  const now = new Date("2026-08-18T12:00:00Z");

  it("is false with no follow-up set", () => {
    expect(isOverdue({ next_action_at: null }, now)).toBe(false);
  });

  it("is true once the moment has passed", () => {
    expect(isOverdue({ next_action_at: "2026-08-16T12:00:00Z" }, now)).toBe(true);
  });

  it("is false for one still ahead", () => {
    expect(isOverdue({ next_action_at: "2026-08-20T12:00:00Z" }, now)).toBe(false);
  });
});

describe("formatMoney", () => {
  it("rounds to whole dollars", () => {
    // Cents on a pipeline total are noise.
    expect(formatMoney(2491.4)).toBe("$2,491");
  });
});
