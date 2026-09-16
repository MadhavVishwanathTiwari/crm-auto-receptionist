import { operatorIndex, type OperatorGroup } from "@/lib/dashboard/operators";
import { requireOrgContext } from "@/lib/org";

import {
  LeadDrawer,
  type EventRow,
  type EvidenceRow,
  type ImportedInfo,
  type LeadDetail,
  type NextSendRow,
  type StalledSendRow,
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

  const [detail, log, artifacts, settings, stalled, upcoming, roster] = await Promise.all([
    supabase
      .from("leads")
      // The import rides along on the lead's own foreign key, named because
      // import_rows joins the same two tables a second way.
      .select(
        "id, company_name, first_name, last_name, title, work_email, phone, website, city, state, postal_code, timezone, timezone_source, industry, rating, reviews_count, is_qualified, status, claimed_by, terminal_outcome, halt_reason, stage, deal_value, next_action, next_action_at, demo_txt_url, demo_ready_at, created_at, imports!leads_import_id_fkey(filename, created_by)",
      )
      .eq("id", leadId)
      .maybeSingle(),
    supabase
      .from("lead_events")
      // payload comes along now: notes carry their body in it, and stage moves
      // their from/to. actor_id says who, which the timeline never did.
      .select("id, type, occurred_at, payload, actor_id")
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
    supabase.from("org_settings").select("default_deal_value").maybeSingle(),
    // Sends whose outcome nobody knows. Since 0040 each one holds the lead, and
    // this drawer is where a person settles it, so it has to know which rows.
    supabase
      .from("scheduled_sends")
      .select("id, step_number, sending_at, error_detail, rendered_subject, composed_subject")
      .eq("lead_id", leadId)
      .eq("status", "failed")
      .eq("error_code", "stalled")
      .order("sending_at", { ascending: false }),
    // The email this lead is waiting on. It used to be visible only from
    // /write or /queue, so the screen a lead is opened on could not say that an
    // email was about to go to it, let alone stop one.
    supabase
      .from("scheduled_sends")
      .select(
        "id, step_number, status, scheduled_at, scheduled_local, prospect_timezone, outcome_reason, composed_subject, mailboxes(email)",
      )
      .eq("lead_id", leadId)
      .in("status", ["planned", "blocked", "claimed", "sending"])
      .order("step_number", { ascending: true }),
    // Who is who, for naming the timeline's actors. madhav's two accounts are
    // one name, resolved in SQL (0048).
    supabase.rpc("org_operators"),
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

  // PostgREST hands an embedded to-one back as an object, or as an array when
  // it cannot prove the relationship is to-one. Normalised once, here.
  const one = <T,>(value: unknown): T | null =>
    ((Array.isArray(value) ? value[0] : value) as T | undefined) ?? null;

  const row = detail.data as LeadDetail & { created_at: string; imports?: unknown };
  const importRow = one<{ filename: string | null; created_by: string | null }>(row.imports);

  // Nothing writes an `imported` event, so the timeline's first line is rebuilt
  // from the lead and the import that made it, which is where the fact lives.
  // A lead that came from no import (the demo seed, the API) has no such line.
  const imported: ImportedInfo | null = importRow
    ? { at: row.created_at, filename: importRow.filename, by: importRow.created_by }
    : null;

  const nextSends: NextSendRow[] = (upcoming.data ?? []).map((send) => ({
    id: send.id as string,
    step_number: send.step_number as number,
    status: send.status as string,
    scheduled_at: send.scheduled_at as string,
    scheduled_local: send.scheduled_local as string,
    prospect_timezone: send.prospect_timezone as string,
    outcome_reason: (send.outcome_reason as string | null) ?? null,
    composed_subject: (send.composed_subject as string | null) ?? null,
    mailbox_email: one<{ email: string }>((send as { mailboxes?: unknown }).mailboxes)?.email ?? null,
  }));

  const actorNames = Object.fromEntries(
    operatorIndex((roster.data ?? []) as OperatorGroup[]),
  );

  return (
    <LeadDrawer
      lead={row}
      events={(log.data ?? []) as EventRow[]}
      evidence={evidence}
      stalledSends={(stalled.data ?? []) as StalledSendRow[]}
      nextSends={nextSends}
      imported={imported}
      actorNames={actorNames}
      screenshotUrls={screenshotUrls}
      currentUserId={userId}
      defaultDealValue={Number(settings.data?.default_deal_value ?? 997)}
    />
  );
}
