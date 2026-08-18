import { requireOrgContext } from "@/lib/org";

import { PAGE, PAGE_HEADER } from "../ui";
import { PipelineBoard, type BoardRow } from "./PipelineBoard";

export const dynamic = "force-dynamic";

// Only the leads somebody is actually working get a card. Prospect is every
// lead the outbound machine still owns — thousands of them — and rendering that
// column would cost more than the rest of the page put together while telling
// an operator nothing they cannot get from the grid. It shows as a count.
const MAX_CARDS = 500;

export default async function PipelinePage() {
  const { supabase, userId } = await requireOrgContext();

  const [cards, prospects, settings] = await Promise.all([
    supabase
      .from("leads")
      // One string literal: supabase-js parses the select list as a template
      // literal type, and concatenating it collapses the result to an error type.
      .select(
        "id, company_name, city, state, claimed_by, status, status_updated_at, stage, stage_changed_at, terminal_outcome, deal_value, next_action, next_action_at",
      )
      .is("archived_at", null)
      // Everything past prospect, plus the closed ones whichever stage they
      // died at — columnFor() puts those under their outcome.
      .or("stage.neq.prospect,terminal_outcome.not.is.null")
      .order("status_updated_at", { ascending: false })
      .limit(MAX_CARDS),

    supabase
      .from("leads")
      .select("id", { count: "exact", head: true })
      .is("archived_at", null)
      .is("terminal_outcome", null)
      .eq("stage", "prospect"),

    supabase.from("org_settings").select("default_deal_value").maybeSingle(),
  ]);

  const defaultDealValue = Number(settings.data?.default_deal_value ?? 997);

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
          leads={(cards.data ?? []) as BoardRow[]}
          prospectCount={prospects.count ?? 0}
          defaultDealValue={defaultDealValue}
          currentUserId={userId}
        />
      )}
    </div>
  );
}
