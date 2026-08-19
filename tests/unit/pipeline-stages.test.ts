import { describe, expect, it } from "vitest";

import {
  BOARD_COLUMNS,
  type BoardLead,
  columnFor,
  countsTowardPipeline,
  dealValue,
  formatMoney,
  isOverdue,
  isTerminalColumn,
  isWorked,
  moveFor,
  PIPELINE_STAGES,
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

describe("isTerminalColumn", () => {
  it("is true for the three outcomes and false for the five stages", () => {
    for (const column of ["closed_won", "closed_lost", "do_not_contact"] as const) {
      expect(isTerminalColumn(column)).toBe(true);
    }
    for (const stage of PIPELINE_STAGES) {
      expect(isTerminalColumn(stage)).toBe(false);
    }
  });
});

describe("isWorked", () => {
  it("is false only for an open prospect", () => {
    expect(isWorked({ stage: "prospect", terminal_outcome: null })).toBe(false);
    expect(isWorked({ stage: "engaged", terminal_outcome: null })).toBe(true);
    // A closed prospect keeps stage='prospect' and files under its outcome, so
    // it is worked even though its stage never moved.
    expect(isWorked({ stage: "prospect", terminal_outcome: "closed_lost" })).toBe(true);
  });
});

describe("moveFor", () => {
  it("routes a drop on a terminal column to close_lead", () => {
    // set_lead_stage takes the five-value enum and structurally cannot carry
    // this, which is why the board needs two write paths rather than one.
    expect(moveFor(lead({ stage: "prospect" }), "closed_won")).toEqual({
      kind: "close",
      outcome: "closed_won",
    });
  });

  it("routes a drop on a stage to set_lead_stage", () => {
    expect(moveFor(lead({ stage: "prospect" }), "meeting")).toEqual({
      kind: "stage",
      stage: "meeting",
    });
  });

  it("does nothing when the card is dropped where it already is", () => {
    expect(moveFor(lead({ stage: "meeting" }), "meeting")).toEqual({
      kind: "none",
      reason: "same_column",
    });
  });

  it("refuses every column once the lead is closed", () => {
    // There is no reopen, and Won -> Lost is a second close rather than a move.
    const closed = lead({ stage: "proposal", terminal_outcome: "closed_won" });
    for (const column of BOARD_COLUMNS) {
      expect(moveFor(closed, column)).toEqual({
        kind: "none",
        reason: "already_closed",
      });
    }
  });
});

describe("prospect cards do not reach the money figures", () => {
  // The regression this guards: the board used to filter prospects out of its
  // query entirely, so nothing in liveLeads could be one. It now seeds the
  // Prospect column with real cards, and the day countsTowardPipeline stops
  // excluding them is the day the headline number silently multiplies by a
  // thousand unworked leads.
  const worked = [
    lead({ stage: "engaged" }),
    lead({ stage: "meeting", deal_value: 2000 }),
    lead({ stage: "proposal" }),
  ];
  const withProspects = [
    ...worked,
    ...Array.from({ length: 50 }, () => lead({ stage: "prospect" })),
  ];

  it("leaves pipelineValue unchanged", () => {
    expect(pipelineValue(withProspects, DEFAULT_VALUE)).toBe(
      pipelineValue(worked, DEFAULT_VALUE),
    );
  });

  it("leaves weightedValue unchanged", () => {
    expect(weightedValue(withProspects, DEFAULT_VALUE)).toBe(
      weightedValue(worked, DEFAULT_VALUE),
    );
  });
});
