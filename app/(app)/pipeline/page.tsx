import { requireOrgContext } from "@/lib/org";

import { PAGE, PAGE_HEADER } from "../ui";
import { PipelineBoard, type BoardRow } from "./PipelineBoard";

export const dynamic = "force-dynamic";

// The worked leads: everything past prospect, plus the closed ones whichever
// stage they died at.
const MAX_CARDS = 500;

// The Prospect column used to be prose over a count, because thousands of cards
// is not a column. It is now the top slice of that count, and the header says
// which slice. Without cards there was physically nothing to drag, so "move a
// prospect to closed" was not an action the board could express.
//
// Fifty is what fits a scrolled column without becoming a second Leads grid.
const PROSPECT_CARDS = 50;

// Hoisted rather than repeated: a const bound to a string literal keeps its
// literal type, so supabase-js still parses the select list. The failure the
// other pages' comments warn about is CONCATENATION, which widens it to
// `string` and collapses the result to an error type. Both queries must ask for
// the same columns because both fill the same BoardRow.
const BOARD_SELECT =
  "id, company_name, city, state, claimed_by, status, status_updated_at, stage, stage_changed_at, terminal_outcome, deal_value, next_action, next_action_at";

export default async function PipelinePage() {
  const { supabase, userId } = await requireOrgContext();

  const [cards, prospectCards, prospects, settings] = await Promise.all([
    supabase
      .from("leads")
      .select(BOARD_SELECT)
      .is("archived_at", null)
      // Everything past prospect, plus the closed ones whichever stage they
      // died at -- columnFor() puts those under their outcome.
      .or("stage.neq.prospect,terminal_outcome.not.is.null")
      .order("status_updated_at", { ascending: false })
      .limit(MAX_CARDS),

    supabase
      .from("leads")
      .select(BOARD_SELECT)
      .is("archived_at", null)
      // Both filters, and the second one matters: a closed prospect keeps
      // stage='prospect' and files under its outcome, so without it the same
      // lead would arrive in this query and the one above and show twice.
      .is("terminal_outcome", null)
      .eq("stage", "prospect")
      // Same key as the cards query, so the board's two halves answer one
      // question. lead_score would be the other candidate and is worse: it is
      // nullable and mostly null, and PostgREST inherits Postgres's NULLS FIRST
      // on a DESC order, so the slice would be fifty leads with no score at all.
      .order("status_updated_at", { ascending: false })
      .limit(PROSPECT_CARDS),

    supabase
      .from("leads")
      .select("id", { count: "exact", head: true })
      .is("archived_at", null)
      .is("terminal_outcome", null)
      .eq("stage", "prospect"),

    supabase.from("org_settings").select("default_deal_value").maybeSingle(),
  ]);

  const defaultDealValue = Number(settings.data?.default_deal_value ?? 997);

  // The two card queries are separate snapshots inside one Promise.all, so a
  // lead that moved between them can land in both. Deduped by id; the opposite
  // case -- in neither -- self-heals on the next Realtime push or revalidate.
  const merged = new Map<string, BoardRow>();
  for (const row of (cards.data ?? []) as BoardRow[]) merged.set(row.id, row);
  for (const row of (prospectCards.data ?? []) as BoardRow[]) merged.set(row.id, row);

  return (
    <div className={PAGE}>
      <header className={PAGE_HEADER}>
        <h1 className="text-[var(--color-ink)]">Pipeline</h1>
      </header>

      {cards.error ? (
        <p role="alert" className="px-4 py-6 text-[var(--color-danger)]">
          Could not load the pipeline: {cards.error.message}
        </p>
      ) : (
        <PipelineBoard
          leads={[...merged.values()]}
          prospectCount={prospects.count ?? 0}
          defaultDealValue={defaultDealValue}
          currentUserId={userId}
        />
      )}
    </div>
  );
}
