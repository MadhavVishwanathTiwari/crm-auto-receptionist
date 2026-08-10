import { requireOrgContext } from "@/lib/org";

import { PAGE, PAGE_HEADER } from "../ui";
import { LeadsGrid, type LeadRow } from "./LeadsGrid";

export const dynamic = "force-dynamic";

// Two operators working a few thousand leads: one fetch, filtered and sorted in
// the browser, is faster than a round trip per keystroke. The virtualizer is
// what makes rendering that many rows free; when the pool outgrows this, the
// filters move into the query and this cap becomes the page size.
const MAX_ROWS = 5000;

export default async function LeadsPage() {
  const { supabase, userId } = await requireOrgContext();

  const { data, error } = await supabase
    .from("leads")
    // Kept as one string literal: supabase-js parses the select list as a
    // template literal type, and concatenating it collapses the result to an
    // error type.
    .select(
      "id, company_name, first_name, last_name, title, work_email, status, claimed_by, city, state, timezone, rating, reviews_count, lead_score, is_qualified, created_at",
    )
    .is("archived_at", null)
    .order("created_at", { ascending: false })
    .limit(MAX_ROWS);

  return (
    <div className={PAGE}>
      <header className={PAGE_HEADER}>
        <h1 className="text-[var(--color-ink)]">Leads</h1>
      </header>

      {error ? (
        <p role="alert" className="px-4 py-6 text-[var(--color-danger)]">
          Could not load leads: {error.message}
        </p>
      ) : (
        <LeadsGrid leads={(data ?? []) as LeadRow[]} currentUserId={userId} />
      )}
    </div>
  );
}
