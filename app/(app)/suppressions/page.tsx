import { requireOrgContext } from "@/lib/org";
import { selectUpTo } from "@/lib/supabase/paginate";

import { PAGE, PAGE_HEADER } from "../ui";
import { SuppressionList, type SuppressionRow } from "./SuppressionList";

export const dynamic = "force-dynamic";

/** Newest first. Past this the list wants a search box, not a longer page. */
const MAX_ROWS = 5000;

export default async function SuppressionsPage() {
  const { supabase, role } = await requireOrgContext();

  // In pages: PostgREST returns at most 1000 rows per response, so the old
  // .limit(1000) was the ceiling whether or not anybody meant one.
  const { data, error } = await selectUpTo<SuppressionRow>(
    () =>
      supabase
        .from("suppressions")
        .select("id, email_norm, domain, phone_e164, reason, notes, created_at")
        .order("created_at", { ascending: false })
        .order("id", { ascending: false }),
    MAX_ROWS,
  );

  return (
    <div className={PAGE}>
      <header className={PAGE_HEADER}>
        <h1 className="text-ink">Suppressions</h1>
        <span className="ml-auto text-ink-3">
          Anyone can add. Only an admin can remove.
        </span>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {error ? (
          <p role="alert" className="px-4 py-6 text-danger">
            Could not load the list: {error.message}
          </p>
        ) : (
          <SuppressionList
            rows={(data ?? []) as SuppressionRow[]}
            isAdmin={role === "admin"}
          />
        )}
      </div>
    </div>
  );
}
