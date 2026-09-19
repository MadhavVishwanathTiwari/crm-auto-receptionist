import { Suspense } from "react";

import { requireOrgContext } from "@/lib/org";
import { selectUpTo } from "@/lib/supabase/paginate";

import { PAGE, PAGE_HEADER } from "../ui";
import { LeadDrawerData } from "./LeadDrawerData";
import { LeadsGrid, type LeadRow } from "./LeadsGrid";

export const dynamic = "force-dynamic";

// Two operators working a few thousand leads: one read, filtered and sorted in
// the browser, is faster than a round trip per keystroke. The virtualizer is
// what makes rendering that many rows free; when the pool outgrows this, the
// filters move into the query and this cap becomes the page size. Read in
// pages, because PostgREST returns at most 1000 rows per response however high
// the .limit(): this cap was quietly 1000 until selectUpTo().
const MAX_ROWS = 5000;

/** Matches the real drawer's width and chrome so nothing shifts on arrival. */
function DrawerSkeleton() {
  return (
    <aside
      aria-busy="true"
      className="flex h-full w-[520px] shrink-0 flex-col border-l border-line bg-surface"
    >
      <header className="flex shrink-0 items-center gap-3 border-b border-line px-4 py-2">
        <span className="text-ink-3">Loading lead</span>
      </header>
    </aside>
  );
}

export default async function LeadsPage({
  searchParams,
}: {
  searchParams: Promise<{ lead?: string }>;
}) {
  const { supabase, userId } = await requireOrgContext();
  const { lead: selectedLeadId } = await searchParams;

  const { data, error } = await selectUpTo<LeadRow>(
    () =>
      supabase
        .from("leads")
        // Kept as one string literal: supabase-js parses the select list as a
        // template literal type, and concatenating it collapses the result to
        // an error type.
        .select(
          "id, company_name, first_name, last_name, title, work_email, status, claimed_by, city, state, timezone, rating, reviews_count, lead_score, is_qualified, created_at, stage, terminal_outcome, next_action, next_action_at",
        )
        .is("archived_at", null)
        .order("created_at", { ascending: false })
        // A tiebreak, so a page boundary between two rows imported in the same
        // instant cannot show one twice and the other never.
        .order("id", { ascending: false }),
    MAX_ROWS,
  );

  return (
    <div className={PAGE}>
      <header className={PAGE_HEADER}>
        <h1 className="text-ink">Leads</h1>
      </header>

      {error ? (
        <p role="alert" className="px-4 py-6 text-danger">
          Could not load leads: {error.message}
        </p>
      ) : (
        <div className="flex min-h-0 flex-1">
          <LeadsGrid
            leads={(data ?? []) as LeadRow[]}
            currentUserId={userId}
            selectedLeadId={selectedLeadId ?? null}
          />
          {selectedLeadId && (
            // Streamed, so the grid paints as soon as it is ready instead of
            // waiting on four more queries and a signed-URL call for a panel
            // beside it. The fallback is the same width as the real drawer, so
            // the grid does not reflow when it arrives.
            //
            // Keyed so switching rows remounts the panel rather than carrying
            // one lead's half-filled form over to the next. The key is on the
            // boundary as well, or React reuses the pending Suspense state and
            // the previous lead's drawer stays up while the next one loads.
            <Suspense key={selectedLeadId} fallback={<DrawerSkeleton />}>
              <LeadDrawerData key={selectedLeadId} leadId={selectedLeadId} />
            </Suspense>
          )}
        </div>
      )}
    </div>
  );
}
