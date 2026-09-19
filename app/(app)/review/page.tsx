import { requireOrgContext } from "@/lib/org";

import { ReviewList, type ReviewItem } from "./ReviewList";

import { Page, PageHeader } from "@/components/ui/PageShell";
import { LoadError } from "@/components/ui/LoadError";

export const dynamic = "force-dynamic";

export default async function ReviewPage() {
  const { supabase } = await requireOrgContext();

  const { data: reviews, error } = await supabase
    .from("dedupe_reviews")
    .select("id, match_kind, match_value, incoming, existing_lead_id, created_at")
    .eq("decision", "pending")
    .order("created_at", { ascending: false })
    .limit(200);

  // Fetched separately rather than as a PostgREST embed: dedupe_reviews has two
  // FKs to leads (existing_lead_id and created_lead_id), so an embed has to be
  // disambiguated by constraint name and breaks the moment one is renamed.
  const leadIds = [...new Set((reviews ?? []).map((r) => r.existing_lead_id))];
  const { data: leads } = leadIds.length
    ? await supabase
        .from("leads")
        .select(
          "id, company_name, first_name, last_name, work_email, phone, website, city, state, status",
        )
        .in("id", leadIds)
    : { data: [] };

  const leadById = new Map((leads ?? []).map((lead) => [lead.id as string, lead]));

  const items: ReviewItem[] = (reviews ?? []).map((review) => ({
    id: review.id as string,
    match_kind: review.match_kind as string,
    match_value: review.match_value as string,
    created_at: review.created_at as string,
    incoming: (review.incoming ?? {}) as Record<string, unknown>,
    existing: (leadById.get(review.existing_lead_id as string) ??
      null) as ReviewItem["existing"],
  }));

  return (
    <Page>
      <PageHeader
        title="Review"
        subtitle={`${items.length} pending`}
        note="Near-duplicates the import could not decide about."
      />

      <div className="min-h-0 flex-1 overflow-y-auto">
        {error ? (
          <LoadError what="the review queue" message={error.message} />
        ) : (
          <ReviewList items={items} />
        )}
      </div>
    </Page>
  );
}
