import Link from "next/link";

import { requireOrgContext } from "@/lib/org";
import {
  type Blocker,
  type BlockerLead,
  BLOCKER_ORDER,
  classifyLead,
  IN_FLIGHT,
  suppressionIndex,
} from "@/lib/queue/blockers";

import { PAGE, PAGE_HEADER, PANEL } from "../ui";
import { QueuedSends, type QueuedSend } from "./QueuedSends";

export const dynamic = "force-dynamic";

const BLOCKER_COPY: Record<Blocker, { label: string; hint: string; tone: string }> = {
  ready: {
    label: "Ready to send",
    hint: "Claimed, audited, qualified, has a resolvable timezone, not suppressed.",
    tone: "text-[var(--color-ok)]",
  },
  halted: {
    label: "Halted",
    hint: "A reply, bounce or unsubscribe stopped the remaining sequence.",
    tone: "text-[var(--color-danger)]",
  },
  suppressed: {
    label: "Suppressed",
    hint: "On the do-not-contact list by email or by domain.",
    tone: "text-[var(--color-danger)]",
  },
  no_timezone: {
    label: "No timezone",
    hint: "A lead with no resolvable IANA zone is never scheduled. Assign one on the lead.",
    tone: "text-[var(--color-warn)]",
  },
  not_qualified: {
    label: "Not qualified",
    hint: "Needs a rating of 3.5 or better and a work email.",
    tone: "text-[var(--color-ink-3)]",
  },
  not_claimed: {
    label: "Unclaimed",
    hint: "Sitting in the shared pool. Claim it on the Leads page.",
    tone: "text-[var(--color-ink-2)]",
  },
  not_audited: {
    label: "Waiting on a decision",
    hint: "Three ways out, all fine: audit it so the first touch can quote the callback, open it and send without an audit for the generic copy, or write it yourself on the Write screen. Leaving it here is the only thing that stops it.",
    tone: "text-[var(--color-info)]",
  },
};

interface QueueLead extends BlockerLead {
  id: string;
  company_name: string | null;
  work_email: string | null;
}

export default async function QueuePage() {
  const { supabase } = await requireOrgContext();

  const [
    { data: leadRows, error },
    { data: suppressionRows },
    { data: settings },
    { data: scheduledRows },
  ] = await Promise.all([
      supabase
        .from("leads")
        // One string literal on purpose; see the note in leads/page.tsx.
        .select(
          "id, company_name, work_email, work_email_norm, website_domain, status, claimed_by, timezone, is_qualified, halted_at, terminal_outcome",
        )
        .is("archived_at", null)
        .limit(5000),
      supabase.from("suppressions").select("email_norm, domain"),
      supabase
        .from("org_settings")
        .select(
          "dry_run, morning_start_hour, morning_end_hour, afternoon_start_hour, afternoon_end_hour",
        )
        .maybeSingle(),
      supabase
        .from("scheduled_sends")
        .select(
          "id, step_number, status, scheduled_at, scheduled_local, prospect_timezone, outcome_reason, composed_subject, leads(company_name, work_email)",
        )
        .in("status", ["planned", "blocked"])
        .order("scheduled_at", { ascending: true })
        .limit(200),
    ]);

  const leads = (leadRows ?? []) as QueueLead[];

  // PostgREST returns an embedded to-one relation as an object, but returns an
  // array when it cannot prove the relationship is to-one. Normalising here
  // rather than at the call site keeps that ambiguity out of the markup.
  const scheduled: QueuedSend[] = (scheduledRows ?? []).map((row) => {
    const embedded = (row as { leads?: unknown }).leads;
    const lead = (Array.isArray(embedded) ? embedded[0] : embedded) as
      | { company_name: string | null; work_email: string | null }
      | undefined;

    return {
      id: row.id as string,
      step_number: row.step_number as number,
      status: row.status as string,
      scheduled_at: row.scheduled_at as string,
      scheduled_local: row.scheduled_local as string,
      prospect_timezone: row.prospect_timezone as string,
      outcome_reason: row.outcome_reason as string | null,
      composed_subject: (row.composed_subject as string | null) ?? null,
      company: lead?.company_name ?? null,
    };
  });

  const suppressions = suppressionIndex(suppressionRows);

  const inFlight = leads.filter((lead) => IN_FLIGHT.has(lead.status));
  const pending = leads.filter((lead) => !IN_FLIGHT.has(lead.status));

  const buckets = new Map<Blocker, QueueLead[]>();
  for (const lead of pending) {
    const blocker = classifyLead(lead, suppressions);
    const bucket = buckets.get(blocker);
    if (bucket) bucket.push(lead);
    else buckets.set(blocker, [lead]);
  }

  return (
    <div className={PAGE}>
      <header className={PAGE_HEADER}>
        <h1 className="text-[var(--color-ink)]">Queue</h1>
        <span className="tabular text-[var(--color-ink-3)]">
          {buckets.get("ready")?.length ?? 0} ready · {inFlight.length} already
          out
        </span>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        <div className="max-w-[1100px] space-y-4">
          {scheduled.length > 0 && (
            <div className={PANEL}>
              <div className="mb-1 flex items-baseline gap-3">
                <h2 className="text-[var(--color-ink)]">Booked</h2>
                <span className="tabular text-[var(--color-ink-2)]">
                  {scheduled.length}
                </span>
              </div>
              <p className="mb-3 text-[var(--color-ink-3)]">
                Your local time first, the prospect&rsquo;s alongside. Nobody
                here reads UTC. Emails marked <em>written</em> are the ones
                somebody typed on the{" "}
                <Link href="/write" className="underline">
                  Write
                </Link>{" "}
                screen; the rest were built from a template by the planner.
              </p>

              <QueuedSends sends={scheduled} />
            </div>
          )}

          <div className={PANEL}>
            <p className="text-[var(--color-ink-2)]">
              What the planner has to work with: which leads are eligible for a
              first touch and what is holding the rest back. A lead only becomes
              ready once it is claimed, audited, qualified, has a resolvable
              timezone and is not suppressed.
            </p>
            {settings && (
              <p className="mt-2 text-[var(--color-ink-3)]">
                Send window, prospect-local: {settings.morning_start_hour}:00–
                {settings.morning_end_hour}:00 and {settings.afternoon_start_hour}
                :00–{settings.afternoon_end_hour}:00, Mon–Fri.{" "}
                {settings.dry_run ? (
                  <span className="text-[var(--color-warn)]">
                    Dry run is on, so nothing can send.
                  </span>
                ) : (
                  <span className="text-[var(--color-ok)]">Dry run is off.</span>
                )}
              </p>
            )}
          </div>

          {error && (
            <p role="alert" className={PANEL + " text-[var(--color-danger)]"}>
              Could not load the queue: {error.message}
            </p>
          )}

          {BLOCKER_ORDER.map((blocker) => {
            const bucket = buckets.get(blocker);
            if (!bucket || bucket.length === 0) return null;
            const copy = BLOCKER_COPY[blocker];

            return (
              <div key={blocker} className={PANEL}>
                <div className="mb-1 flex items-baseline gap-3">
                  <h2 className={copy.tone}>{copy.label}</h2>
                  <span className="tabular text-[var(--color-ink-2)]">
                    {bucket.length}
                  </span>
                </div>
                <p className="mb-3 text-[var(--color-ink-3)]">{copy.hint}</p>

                <ul className="space-y-0.5">
                  {bucket.slice(0, 50).map((lead) => (
                    <li key={lead.id}>
                      {/* Straight into the drawer, which is where every one of
                          these blockers is actually resolved. */}
                      <Link
                        href={`/leads?lead=${lead.id}`}
                        className="flex gap-3 hover:bg-[var(--color-surface-2)]"
                      >
                        <span className="w-64 truncate">
                          {lead.company_name ?? "—"}
                        </span>
                        <span className="w-64 truncate text-[var(--color-ink-2)]">
                          {lead.work_email ?? "—"}
                        </span>
                        <span className="text-[var(--color-ink-3)]">
                          {lead.status.replace(/_/g, " ")}
                        </span>
                      </Link>
                    </li>
                  ))}
                </ul>
                {bucket.length > 50 && (
                  <p className="mt-2 text-[var(--color-ink-3)]">
                    and {bucket.length - 50} more
                  </p>
                )}
              </div>
            );
          })}

          {pending.length === 0 && !error && (
            <p className="text-[var(--color-ink-3)]">
              Nothing pending. Import some leads to get started.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
