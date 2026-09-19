import { accountsOf, type OperatorGroup } from "@/lib/dashboard/operators";
import { requireOrgContext } from "@/lib/org";

import { AuditList, type AuditLead } from "./AuditList";

import { Page, PageHeader } from "@/components/ui/PageShell";
import { LoadError } from "@/components/ui/LoadError";

export const dynamic = "force-dynamic";

export default async function AuditPage() {
  const { supabase, userId, orgId } = await requireOrgContext();

  // Mine means either of my accounts: madhav claimed his sheet leads as one and
  // signs in as the other (0048).
  const { data: operatorRows } = await supabase.rpc("org_operators");
  const mine = accountsOf(userId, (operatorRows ?? []) as OperatorGroup[]);

  // The work queue for a human: mine, worth contacting, and placeable on a
  // clock. Leads already past `claimed` have been audited (or further), so
  // filtering on status keeps a row from reappearing after it is done.
  const { data, error } = await supabase
    .from("leads")
    .select(
      "id, company_name, first_name, last_name, work_email, phone, website, city, state, timezone, rating, reviews_count",
    )
    .is("archived_at", null)
    .in("claimed_by", mine)
    .eq("status", "claimed")
    .eq("is_qualified", true)
    .not("timezone", "is", null)
    .order("lead_score", { ascending: false, nullsFirst: false })
    .limit(200);

  const leads = (data ?? []) as AuditLead[];

  return (
    <Page>
      <PageHeader
        title="Audit"
        subtitle={`${leads.length} waiting`}
        note="Times shown are the prospect’s, not yours."
      />

      <div className="min-h-0 flex-1 overflow-y-auto">
        {error ? (
          <LoadError what="the audit queue" message={error.message} />
        ) : (
          <AuditList leads={leads} orgId={orgId} />
        )}
      </div>
    </Page>
  );
}
