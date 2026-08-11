"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";

import {
  suppressLead,
  SUPPRESSION_REASONS,
  type SuppressionReason,
} from "../suppressions/actions";
import { BUTTON, BUTTON_QUIET, INPUT, STATUS_TONE } from "../ui";
import { closeLead, setLeadTimezone, type TerminalOutcome } from "./actions";

export interface LeadDetail {
  id: string;
  company_name: string | null;
  first_name: string | null;
  last_name: string | null;
  title: string | null;
  work_email: string | null;
  email_1: string | null;
  email_2: string | null;
  email_3: string | null;
  likely_email: string | null;
  phone: string | null;
  website: string | null;
  city: string | null;
  state: string | null;
  postal_code: string | null;
  timezone: string | null;
  timezone_source: string | null;
  industry: string | null;
  rating: number | null;
  reviews_count: number | null;
  is_qualified: boolean;
  status: string;
  claimed_by: string | null;
  terminal_outcome: string | null;
  halt_reason: string | null;
}

export interface EventRow {
  id: string;
  type: string;
  occurred_at: string;
}

export interface EvidenceRow {
  id: string;
  angle_type: string;
  audited_at_local: string;
  audit_timezone: string;
  response_delay_seconds: number | null;
  outcome: string | null;
  notes: string | null;
  screenshot_path: string | null;
}

const OUTCOMES: Array<{ value: TerminalOutcome; label: string }> = [
  { value: "closed_won", label: "Won" },
  { value: "closed_lost", label: "Lost" },
  { value: "do_not_contact", label: "Do not contact" },
];

// Intl supplies the full IANA list at runtime, so there is no lookup table to
// maintain and no state-to-zone guessing of the kind the schema forbids.
const ZONES: string[] =
  typeof Intl.supportedValuesOf === "function"
    ? Intl.supportedValuesOf("timeZone")
    : [];

function Field({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex gap-2">
      <span className="w-28 shrink-0 text-[var(--color-ink-3)]">{label}</span>
      <span className="min-w-0 break-words">{value || "—"}</span>
    </div>
  );
}

/**
 * Presentational. Everything it shows is fetched by the server component that
 * renders it, so there is no client-side load and no fetch-in-an-effect.
 * Actions revalidate /leads, which re-renders that server component and
 * refreshes this panel with it.
 */
export function LeadDrawer({
  lead,
  events,
  evidence,
  screenshotUrls,
  currentUserId,
}: {
  lead: LeadDetail;
  events: EventRow[];
  evidence: EvidenceRow[];
  screenshotUrls: Record<string, string>;
  currentUserId: string;
}) {
  const router = useRouter();
  const [zone, setZone] = useState(lead.timezone ?? "");
  const [reason, setReason] = useState<SuppressionReason>("manual_dnc");
  const [outcome, setOutcome] = useState<TerminalOutcome>("closed_lost");
  const [confirmingClose, setConfirmingClose] = useState(false);
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const close = () => router.push("/leads");

  // Listener only, no state, so this is not the effect pattern lint objects to.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") router.push("/leads");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [router]);

  function run(action: () => Promise<{ ok: boolean; error?: string }>) {
    setError(null);
    startTransition(async () => {
      const result = await action();
      if (!result.ok) setError(result.error ?? "That did not work.");
    });
  }

  const mine = lead.claimed_by === currentUserId;
  const editable = lead.claimed_by === null || mine;

  return (
    <aside className="flex h-full w-[520px] shrink-0 flex-col border-l border-[var(--color-line)] bg-[var(--color-surface)]">
      <header className="flex shrink-0 items-center gap-3 border-b border-[var(--color-line)] px-4 py-2">
        <h2 className="truncate text-[var(--color-ink)]">
          {lead.company_name ?? "Lead"}
        </h2>
        <span className={STATUS_TONE[lead.status] ?? ""}>
          {lead.status.replace(/_/g, " ")}
        </span>
        <button type="button" onClick={close} className={BUTTON_QUIET + " ml-auto"}>
          close
        </button>
      </header>

      <div className="min-h-0 flex-1 space-y-5 overflow-y-auto p-4">
        {error && (
          <p role="alert" className="text-[var(--color-danger)]">
            {error}
          </p>
        )}

        <section className="space-y-1">
          <Field
            label="Contact"
            value={[lead.first_name, lead.last_name].filter(Boolean).join(" ")}
          />
          <Field label="Title" value={lead.title} />
          <Field label="Work email" value={lead.work_email} />
          <Field label="Phone" value={lead.phone} />
          <Field label="Website" value={lead.website} />
          <Field
            label="Location"
            value={[lead.city, lead.state, lead.postal_code]
              .filter(Boolean)
              .join(", ")}
          />
          <Field label="Industry" value={lead.industry} />
          <Field
            label="Rating"
            value={
              lead.rating === null
                ? null
                : `${lead.rating}${
                    lead.reviews_count !== null
                      ? ` (${lead.reviews_count} reviews)`
                      : ""
                  }`
            }
          />
          <Field
            label="Qualified"
            value={
              lead.is_qualified ? (
                "yes"
              ) : (
                <span className="text-[var(--color-ink-3)]">
                  no — needs rating 3.5+ and a work email
                </span>
              )
            }
          />
          <Field
            label="Owner"
            value={
              lead.claimed_by === null
                ? "unclaimed"
                : mine
                  ? "you"
                  : "the other operator"
            }
          />
          {lead.halt_reason && (
            <Field
              label="Halted"
              value={
                <span className="text-[var(--color-danger)]">{lead.halt_reason}</span>
              }
            />
          )}
        </section>

        {/* Reference addresses. Never a send target — work_email is the only one
            the scheduler or the Gmail layer will ever read. */}
        {(lead.email_1 ?? lead.email_2 ?? lead.email_3 ?? lead.likely_email) && (
          <section>
            <h3 className="mb-1 text-[var(--color-ink-3)]">
              Other addresses (reference only, never emailed)
            </h3>
            <div className="space-y-0.5 text-[var(--color-ink-2)]">
              {[lead.email_1, lead.email_2, lead.email_3, lead.likely_email]
                .filter(Boolean)
                .map((address) => (
                  <div key={address}>{address}</div>
                ))}
            </div>
          </section>
        )}

        <section>
          <h3 className="mb-2 text-[var(--color-ink-3)]">Timezone</h3>
          <div className="flex flex-wrap items-center gap-2">
            <input
              list="iana-zones"
              value={zone}
              disabled={!editable || pending}
              onChange={(event) => setZone(event.target.value)}
              placeholder="America/Chicago"
              className={INPUT + " w-60"}
            />
            <datalist id="iana-zones">
              {ZONES.map((value) => (
                <option key={value} value={value} />
              ))}
            </datalist>
            <button
              type="button"
              disabled={!editable || pending || zone === (lead.timezone ?? "")}
              onClick={() => run(() => setLeadTimezone(lead.id, zone))}
              className={BUTTON}
            >
              Save
            </button>
            {lead.timezone && (
              <button
                type="button"
                disabled={!editable || pending}
                onClick={() => {
                  setZone("");
                  run(() => setLeadTimezone(lead.id, null));
                }}
                className={BUTTON_QUIET}
              >
                clear
              </button>
            )}
            <span className="text-[var(--color-ink-3)]">
              {lead.timezone_source
                ? `set ${lead.timezone_source}`
                : "unresolved — never scheduled"}
            </span>
          </div>
        </section>

        <section>
          <h3 className="mb-2 text-[var(--color-ink-3)]">
            Audits <span className="tabular">{evidence.length}</span>
          </h3>
          {evidence.length === 0 ? (
            <p className="text-[var(--color-ink-3)]">Not audited yet.</p>
          ) : (
            <div className="space-y-2">
              {evidence.map((row) => (
                <div key={row.id} className="border border-[var(--color-line)] p-2">
                  <div className="flex flex-wrap gap-x-4 text-[var(--color-ink-2)]">
                    <span>{row.angle_type.replace(/_/g, " ")}</span>
                    <span className="tabular">
                      {row.audited_at_local.replace("T", " ").slice(0, 16)}{" "}
                      <span className="text-[var(--color-ink-3)]">
                        {row.audit_timezone}
                      </span>
                    </span>
                    <span>{row.outcome}</span>
                    {row.response_delay_seconds !== null && (
                      <span className="tabular">
                        replied after {Math.round(row.response_delay_seconds / 60)}m
                      </span>
                    )}
                  </div>
                  {row.notes && (
                    <p className="mt-1 text-[var(--color-ink-3)]">{row.notes}</p>
                  )}
                  {row.screenshot_path && screenshotUrls[row.screenshot_path] && (
                    <a
                      href={screenshotUrls[row.screenshot_path]}
                      target="_blank"
                      rel="noreferrer"
                      className="mt-1 inline-block underline"
                    >
                      screenshot
                    </a>
                  )}
                </div>
              ))}
            </div>
          )}
        </section>

        <section>
          <h3 className="mb-2 text-[var(--color-ink-3)]">Timeline</h3>
          {events.length === 0 ? (
            <p className="text-[var(--color-ink-3)]">No events yet.</p>
          ) : (
            <ul className="space-y-0.5">
              {events.map((event) => (
                <li key={event.id} className="flex gap-3">
                  <span className="tabular w-32 shrink-0 text-[var(--color-ink-3)]">
                    {new Date(event.occurred_at).toLocaleString(undefined, {
                      month: "short",
                      day: "numeric",
                      hour: "2-digit",
                      minute: "2-digit",
                    })}
                  </span>
                  <span className={STATUS_TONE[event.type] ?? ""}>
                    {event.type.replace(/_/g, " ")}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="border-t border-[var(--color-line)] pt-4">
          <h3 className="mb-2 text-[var(--color-ink-3)]">Stop contacting</h3>

          <div className="mb-2 flex flex-wrap items-center gap-2">
            <select
              value={reason}
              disabled={pending}
              onChange={(event) =>
                setReason(event.target.value as SuppressionReason)
              }
              className={INPUT}
            >
              {SUPPRESSION_REASONS.map((entry) => (
                <option key={entry.value} value={entry.value}>
                  {entry.label}
                </option>
              ))}
            </select>
            <button
              type="button"
              disabled={pending || !lead.work_email}
              onClick={() => run(() => suppressLead(lead.id, "email", reason, note))}
              className={BUTTON}
            >
              Suppress this address
            </button>
            <button
              type="button"
              disabled={pending || !lead.website}
              onClick={() => run(() => suppressLead(lead.id, "domain", reason, note))}
              className={BUTTON}
            >
              Suppress whole domain
            </button>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <select
              value={outcome}
              disabled={pending}
              onChange={(event) =>
                setOutcome(event.target.value as TerminalOutcome)
              }
              className={INPUT}
            >
              {OUTCOMES.map((entry) => (
                <option key={entry.value} value={entry.value}>
                  {entry.label}
                </option>
              ))}
            </select>
            <input
              value={note}
              disabled={pending}
              onChange={(event) => setNote(event.target.value)}
              placeholder="Note (kept on the event)"
              className={INPUT + " min-w-[160px] flex-1"}
            />
            {confirmingClose ? (
              <>
                <button
                  type="button"
                  disabled={pending}
                  onClick={() => {
                    setConfirmingClose(false);
                    run(() => closeLead(lead.id, outcome, note));
                  }}
                  className={BUTTON + " text-[var(--color-danger)]"}
                >
                  Yes, close it
                </button>
                <button
                  type="button"
                  onClick={() => setConfirmingClose(false)}
                  className={BUTTON_QUIET}
                >
                  cancel
                </button>
              </>
            ) : (
              <button
                type="button"
                disabled={pending || lead.terminal_outcome !== null}
                onClick={() => setConfirmingClose(true)}
                className={BUTTON}
              >
                {lead.terminal_outcome ? "Already closed" : "Close lead"}
              </button>
            )}
          </div>
          <p className="mt-2 text-[var(--color-ink-3)]">
            Closing cannot be undone from the app. A terminal outcome wins over every
            later event, so reopening would need a database change.
          </p>
        </section>
      </div>
    </aside>
  );
}
