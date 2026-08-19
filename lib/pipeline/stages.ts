// Where a lead sits on the board, and what it is worth.
//
// One definition, because three screens ask the same questions: the board
// groups by it, the grid shows a column of it, and the drawer moves it. A
// second copy would let the board and the grid disagree about which column a
// closed lead belongs in, which is the kind of disagreement nobody notices
// until a number is wrong in front of a client.
//
// This is the READ side. The gate is public.set_lead_stage() plus the guard on
// leads.stage; this exists so the UI can render the same answer the database
// would give.

export type PipelineStage =
  | "prospect"
  | "engaged"
  | "meeting"
  | "proposal"
  | "nurture";

/** The five stages, in board order. Matches the pipeline_stage enum in 0035. */
export const PIPELINE_STAGES: PipelineStage[] = [
  "prospect",
  "engaged",
  "meeting",
  "proposal",
  "nurture",
];

export type TerminalColumn = "closed_won" | "closed_lost" | "do_not_contact";

export type BoardColumn = PipelineStage | TerminalColumn;

/**
 * Every column on the board, left to right.
 *
 * The last three are terminal_outcome, not stages. close_lead() stays the one
 * answer to "did we win", and a stage that duplicated it could contradict it.
 */
export const BOARD_COLUMNS: BoardColumn[] = [
  ...PIPELINE_STAGES,
  "closed_won",
  "closed_lost",
  "do_not_contact",
];

export const COLUMN_LABEL: Record<BoardColumn, string> = {
  prospect: "Prospect",
  engaged: "Engaged",
  meeting: "Meeting",
  proposal: "Proposal",
  nurture: "Nurture",
  closed_won: "Won",
  closed_lost: "Lost",
  do_not_contact: "Do not contact",
};

export interface BoardLead {
  stage: string;
  terminal_outcome: string | null;
  deal_value: number | string | null;
  next_action_at: string | null;
}

/**
 * Which column this lead renders in.
 *
 * terminal_outcome wins, exactly as it does in app.lead_status_from_events. A
 * closed lead keeps whatever stage it died at — that is what makes "how far did
 * this get before we lost it" answerable — so the stage alone would put it back
 * among the live deals.
 */
export function columnFor(lead: {
  stage: string;
  terminal_outcome: string | null;
}): BoardColumn {
  if (lead.terminal_outcome) return lead.terminal_outcome as TerminalColumn;
  return lead.stage as PipelineStage;
}

/**
 * The stages whose leads count toward pipeline value.
 *
 * `prospect` is excluded, and that is the important part. Thousands of unworked
 * leads multiplied by the default deal value is a headline number nobody
 * believes, and a total nobody believes is worth less than no total. Value here
 * means a deal somebody is actually working.
 */
export const VALUED_STAGES: PipelineStage[] = [
  "engaged",
  "meeting",
  "proposal",
  "nurture",
];

export function countsTowardPipeline(lead: {
  stage: string;
  terminal_outcome: string | null;
}): boolean {
  if (lead.terminal_outcome) return false;
  return VALUED_STAGES.includes(lead.stage as PipelineStage);
}

/**
 * A starting point, not a measurement.
 *
 * Nobody has closed enough deals through this pipeline to have real conversion
 * rates yet. These are here so the weighted figure means something directionally
 * and so there is one place to correct them once the data exists.
 */
export const STAGE_WEIGHT: Record<PipelineStage, number> = {
  prospect: 0,
  engaged: 0.1,
  meeting: 0.3,
  proposal: 0.6,
  nurture: 0.05,
};

/**
 * What this deal is worth.
 *
 * leads.deal_value is null on almost every lead and null means "the org
 * default" — which is what keeps the total honest without anyone typing the
 * same number onto every row.
 *
 * The string branch is defensive rather than decorative: PostgREST serialises
 * numeric as a bare JSON number at these magnitudes, but emits it quoted once
 * the value would not survive a double. A deal value should never get near
 * that, and a board that silently renders NaN if one did would be worse than
 * four extra lines here.
 */
export function dealValue(
  lead: { deal_value: number | string | null },
  orgDefault: number,
): number {
  if (lead.deal_value === null || lead.deal_value === undefined) return orgDefault;
  const value =
    typeof lead.deal_value === "number"
      ? lead.deal_value
      : Number.parseFloat(lead.deal_value);
  return Number.isFinite(value) ? value : orgDefault;
}

/** Open pipeline value: the deals somebody is working, at face value. */
export function pipelineValue(leads: BoardLead[], orgDefault: number): number {
  return leads
    .filter(countsTowardPipeline)
    .reduce((total, lead) => total + dealValue(lead, orgDefault), 0);
}

/** The same deals, discounted by STAGE_WEIGHT. */
export function weightedValue(leads: BoardLead[], orgDefault: number): number {
  return leads
    .filter(countsTowardPipeline)
    .reduce(
      (total, lead) =>
        total + dealValue(lead, orgDefault) * STAGE_WEIGHT[lead.stage as PipelineStage],
      0,
    );
}

export function wonValue(leads: BoardLead[], orgDefault: number): number {
  return leads
    .filter((lead) => lead.terminal_outcome === "closed_won")
    .reduce((total, lead) => total + dealValue(lead, orgDefault), 0);
}

/** A follow-up whose moment has passed. The only thing on a card in red. */
export function isOverdue(
  lead: { next_action_at: string | null },
  now: Date = new Date(),
): boolean {
  if (!lead.next_action_at) return false;
  return new Date(lead.next_action_at).getTime() < now.getTime();
}

const MONEY = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 0,
});

/** Whole dollars everywhere. Cents on a pipeline total are noise. */
export function formatMoney(value: number): string {
  return MONEY.format(Math.round(value));
}

/** The three columns that are a terminal_outcome rather than a stage. */
export function isTerminalColumn(column: BoardColumn): column is TerminalColumn {
  return (
    column === "closed_won" || column === "closed_lost" || column === "do_not_contact"
  );
}

/**
 * A lead that has left the sequence: somebody moved it, or it is closed.
 *
 * This used to live in PipelineBoard as `qualifies()` and it answered a wider
 * question than it does now. The board seeds the Prospect column from a bounded
 * query -- the fifty most recently touched of however many thousand -- so this
 * no longer decides whether a lead HAS a card. It decides whether a row the
 * board has never seen deserves one. A prospect does not: it belongs to the
 * unshown tail, and inserting one per Realtime push would grow that column all
 * through a dispatch run. A row already on the board is never evicted on stage;
 * that rule lives in the handler, where the "already on the board" fact is.
 */
export function isWorked(lead: {
  stage: string;
  terminal_outcome: string | null;
}): boolean {
  return lead.stage !== "prospect" || lead.terminal_outcome !== null;
}

export type BoardMove =
  | { kind: "stage"; stage: PipelineStage }
  | { kind: "close"; outcome: TerminalColumn }
  | { kind: "none"; reason: "same_column" | "already_closed" };

/**
 * What putting this lead in this column means.
 *
 * The board has one gesture and two write paths. A drop on one of the five
 * stages is set_lead_stage(); a drop on one of the three terminals is
 * close_lead(), which is a different RPC and not an oversight -- set_lead_stage
 * takes the five-value pipeline_stage enum from 0035 and structurally cannot
 * carry `closed_won`.
 *
 * A closed lead has no legal move at all. There is no reopen: terminal_outcome
 * is guarded against every change including clearing it, set_lead_stage raises
 * 22023 on a closed lead, and 0038 refuses a second close. Won -> Lost is not
 * "moving out", it is a second close_lead, and it used to succeed silently.
 *
 * Pure, and shared by the drag handler and the <select>, so the mouse path and
 * the keyboard path cannot come to different conclusions about the same drop.
 */
export function moveFor(
  lead: { stage: string; terminal_outcome: string | null },
  column: BoardColumn,
): BoardMove {
  if (lead.terminal_outcome !== null) {
    return { kind: "none", reason: "already_closed" };
  }
  if (columnFor(lead) === column) return { kind: "none", reason: "same_column" };
  if (isTerminalColumn(column)) return { kind: "close", outcome: column };
  return { kind: "stage", stage: column };
}
