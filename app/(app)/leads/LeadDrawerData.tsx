import { requireOrgContext } from "@/lib/org";

import {
  LeadDrawer,
  type EventRow,
  type EvidenceRow,
  type LeadDetail,
} from "./LeadDrawer";

/**
 * Fetches everything the drawer shows.
 *
 * A server component driven by the `?lead=` search param rather than a client
 * fetch on open. Three things fall out of that: the queries run under RLS the
 * same way every other page's do, an action's revalidatePath("/leads") refreshes
 * the panel for free, and Queue can deep-link straight to a blocked lead.
 */
export async function LeadDrawerData({ leadId }: { leadId: string }) {
  const { supabase, userId } = await requireOrgContext();

  const [detail, log, artifacts] = await Promise.all([
    supabase
      .from("leads")
      .select(
        "id, company_name, first_name, last_name, title, work_email, email_1, email_2, email_3, likely_email, phone, website, city, state, postal_code, timezone, timezone_source, industry, rating, reviews_count, is_qualified, status, claimed_by, terminal_outcome, halt_reason",
      )
      .eq("id", leadId)
      .maybeSingle(),
    supabase
      .from("lead_events")
      .select("id, type, occurred_at")
      .eq("lead_id", leadId)
      .order("occurred_at", { ascending: false })
      .limit(100),
    supabase
      .from("lead_evidence")
      .select(
        "id, angle_type, audited_at_local, audit_timezone, response_delay_seconds, outcome, notes, screenshot_path",
      )
      .eq("lead_id", leadId)
      .order("created_at", { ascending: false }),
  ]);

  // A lead in another org is invisible under RLS rather than forbidden, so this
  // covers both "deleted" and "not yours".
  if (detail.error || !detail.data) {
    return (
      <aside className="w-[520px] shrink-0 border-l border-[var(--color-line)] bg-[var(--color-surface)] p-4">
        <p className="text-[var(--color-ink-3)]">
          That lead is not available.
          {detail.error ? ` ${detail.error.message}` : ""}
        </p>
      </aside>
    );
  }

  const evidence = (artifacts.data ?? []) as EvidenceRow[];

  // The bucket is private, so a stored path is not a URL.
  const paths = evidence
    .map((row) => row.screenshot_path)
    .filter((path): path is string => Boolean(path));

  const screenshotUrls: Record<string, string> = {};
  if (paths.length > 0) {
    const { data: signed } = await supabase.storage
      .from("lead-evidence")
      .createSignedUrls(paths, 300);
    for (const entry of signed ?? []) {
      if (entry.path && entry.signedUrl) screenshotUrls[entry.path] = entry.signedUrl;
    }
  }

  return (
    <LeadDrawer
      lead={detail.data as LeadDetail}
      events={(log.data ?? []) as EventRow[]}
      evidence={evidence}
      screenshotUrls={screenshotUrls}
      currentUserId={userId}
    />
  );
}
