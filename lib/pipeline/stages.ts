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
