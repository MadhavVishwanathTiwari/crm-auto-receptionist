import { requireOrgContext } from "@/lib/org";

import { PAGE, PAGE_HEADER } from "../ui";
import { AuditList, type AuditLead } from "./AuditList";

export const dynamic = "force-dynamic";

export default async function AuditPage() {
  const { supabase, userId, orgId } = await requireOrgContext();

  // The work queue for a human: mine, worth contacting, and placeable on a
  // clock. Leads already past `claimed` have been audited (or further), so
  // filtering on status keeps a row from reappearing after it is done.
  const { data, error } = await supabase
    .from("leads")
    .select(
      "id, company_name, first_name, last_name, work_email, phone, website, city, state, timezone, rating, reviews_count",
    )
    .is("archived_at", null)
    .eq("claimed_by", userId)
    .eq("status", "claimed")
    .eq("is_qualified", true)
    .not("timezone", "is", null)
    .order("lead_score", { ascending: false, nullsFirst: false })
    .limit(200);

  const leads = (data ?? []) as AuditLead[];

  return (
    <div className={PAGE}>
      <header className={PAGE_HEADER}>
        <h1 className="text-[var(--color-ink)]">Audit</h1>
        <span className="tabular text-[var(--color-ink-3)]">
          {leads.length} waiting
        </span>
        <span className="ml-auto text-[var(--color-ink-3)]">
          Times shown are the prospect&apos;s, not yours.
        </span>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {error ? (
          <p role="alert" className="px-4 py-6 text-[var(--color-danger)]">
            Could not load the audit queue: {error.message}
          </p>
        ) : (
          <AuditList leads={leads} orgId={orgId} />
        )}
      </div>
    </div>
  );
}
