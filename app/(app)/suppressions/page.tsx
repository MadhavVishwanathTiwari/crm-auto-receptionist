import { requireOrgContext } from "@/lib/org";

import { PAGE, PAGE_HEADER } from "../ui";
import { SuppressionList, type SuppressionRow } from "./SuppressionList";

export const dynamic = "force-dynamic";

export default async function SuppressionsPage() {
  const { supabase, role } = await requireOrgContext();

  const { data, error } = await supabase
    .from("suppressions")
    .select("id, email_norm, domain, phone_e164, reason, notes, created_at")
    .order("created_at", { ascending: false })
    .limit(1000);

  return (
    <div className={PAGE}>
      <header className={PAGE_HEADER}>
        <h1 className="text-[var(--color-ink)]">Suppressions</h1>
        <span className="ml-auto text-[var(--color-ink-3)]">
          Anyone can add. Only an admin can remove.
        </span>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {error ? (
          <p role="alert" className="px-4 py-6 text-[var(--color-danger)]">
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
