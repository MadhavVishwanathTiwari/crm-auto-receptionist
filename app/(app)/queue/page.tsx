import { DateTime } from "luxon";
import Link from "next/link";

import { requireOrgContext } from "@/lib/org";

import { PAGE, PAGE_HEADER, PANEL } from "../ui";

export const dynamic = "force-dynamic";

// Statuses that mean the first touch has already gone out. Those leads are not
// waiting on anything, so they are counted but not listed as work.
const IN_FLIGHT = new Set([
  "sent",
  "delivered",
  "opened",
  "replied",
  "bounced",
  "unsubscribed",
  "closed_won",
  "closed_lost",
  "do_not_contact",
]);

type Blocker =
  | "ready"
  | "halted"
  | "suppressed"
  | "no_timezone"
  | "not_qualified"
  | "not_claimed"
  | "not_audited";

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
    label: "Not audited",
    hint: "The first touch quotes the audit back, so it cannot be written yet.",
    tone: "text-[var(--color-info)]",
  },
};

const ORDER: Blocker[] = [
  "ready",
  "not_audited",
  "not_claimed",
  "no_timezone",
  "not_qualified",
  "suppressed",
  "halted",
];

interface QueueLead {
  id: string;
  company_name: string | null;
  work_email: string | null;
  work_email_norm: string | null;
  website_domain: string | null;
  status: string;
  claimed_by: string | null;
  timezone: string | null;
  is_qualified: boolean;
  halted_at: string | null;
  terminal_outcome: string | null;
}

interface ScheduledSend {
  id: string;
  step_number: number;
  status: string;
  scheduled_at: string;
  /** Prospect-local wall clock, frozen at plan time. No offset. */
  scheduled_local: string;
  prospect_timezone: string;
  outcome_reason: string | null;
  lead: { company_name: string | null; work_email: string | null } | null;
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
          "id, step_number, status, scheduled_at, scheduled_local, prospect_timezone, outcome_reason, leads(company_name, work_email)",
        )
        .in("status", ["planned", "blocked"])
        .order("scheduled_at", { ascending: true })
        .limit(200),
    ]);

  const leads = (leadRows ?? []) as QueueLead[];

  // PostgREST returns an embedded to-one relation as an object, but returns an
  // array when it cannot prove the relationship is to-one. Normalising here
  // rather than at the call site keeps that ambiguity out of the markup.
  const scheduled: ScheduledSend[] = (scheduledRows ?? []).map((row) => {
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
      lead: lead ?? null,
    };
  });

  const suppressedEmails = new Set(
    (suppressionRows ?? []).map((s) => s.email_norm).filter(Boolean) as string[],
  );
  const suppressedDomains = new Set(
    (suppressionRows ?? []).map((s) => s.domain).filter(Boolean) as string[],
  );

  function classify(lead: QueueLead): Blocker {
    // Most severe first: a halted or suppressed lead must never read as "ready"
    // just because it also happens to be claimed and audited.
    if (lead.halted_at || lead.terminal_outcome) return "halted";
    if (
      (lead.work_email_norm && suppressedEmails.has(lead.work_email_norm)) ||
      (lead.website_domain && suppressedDomains.has(lead.website_domain))
    ) {
      return "suppressed";
    }
    if (!lead.timezone) return "no_timezone";
    if (!lead.is_qualified) return "not_qualified";
    if (!lead.claimed_by) return "not_claimed";
    if (lead.status !== "audited" && lead.status !== "queued") return "not_audited";
    return "ready";
  }

  const inFlight = leads.filter((lead) => IN_FLIGHT.has(lead.status));
  const pending = leads.filter((lead) => !IN_FLIGHT.has(lead.status));

  const buckets = new Map<Blocker, QueueLead[]>();
  for (const lead of pending) {
    const blocker = classify(lead);
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
                here reads UTC.
              </p>

              <table className="w-full border-collapse">
                <thead>
                  <tr className="text-left text-[var(--color-ink-3)]">
                    <th className="py-1 font-normal">Company</th>
                    <th className="py-1 font-normal">Step</th>
                    <th className="py-1 font-normal">Your time</th>
                    <th className="py-1 font-normal">Their time</th>
                    <th className="py-1 font-normal">State</th>
                  </tr>
                </thead>
                <tbody>
                  {scheduled.map((send) => {
                    const at = DateTime.fromISO(send.scheduled_at);
                    const local = DateTime.fromISO(send.scheduled_local);
                    return (
                      <tr
                        key={send.id}
                        className="border-t border-[var(--color-line)]"
                      >
                        <td className="max-w-[280px] truncate py-1">
                          {send.lead?.company_name ?? "—"}
                        </td>
                        <td className="tabular py-1">T{send.step_number}</td>
                        <td className="tabular py-1 text-[var(--color-ink-2)]">
                          {send.status === "blocked"
                            ? "—"
                            : at.toFormat("ccc d LLL, HH:mm")}
                        </td>
                        <td className="tabular py-1 text-[var(--color-ink-2)]">
                          {send.status === "blocked"
                            ? "—"
                            : `${local.toFormat("HH:mm")} ${send.prospect_timezone}`}
                        </td>
                        <td className="py-1">
                          {send.status === "blocked" ? (
                            <span className="text-[var(--color-warn)]">
                              blocked: {send.outcome_reason ?? "no capacity"}
                            </span>
                          ) : (
                            <span className="text-[var(--color-ink-3)]">
                              planned
                            </span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
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

          {ORDER.map((blocker) => {
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
