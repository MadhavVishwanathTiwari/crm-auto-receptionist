import { requireOrgContext } from "@/lib/org";
import { selectUpTo } from "@/lib/supabase/paginate";

import { SuppressionList, type SuppressionRow } from "./SuppressionList";

import { Page, PageHeader } from "@/components/ui/PageShell";
import { LoadError } from "@/components/ui/LoadError";

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
    <Page>
      <PageHeader
        title="Suppressions"
        note="Anyone can add. Only an admin can remove."
      />

      <div className="min-h-0 flex-1 overflow-y-auto">
        {error ? (
          <LoadError what="the list" message={error.message} />
        ) : (
          <SuppressionList
            rows={(data ?? []) as SuppressionRow[]}
            isAdmin={role === "admin"}
          />
        )}
      </div>
    </Page>
  );
}
