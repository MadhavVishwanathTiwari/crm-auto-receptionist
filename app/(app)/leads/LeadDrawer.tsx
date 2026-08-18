"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";

import { suppressLead } from "../suppressions/actions";
// The reasons array and its type come from a plain module, not the "use server"
// actions file — importing the array through a server module hands a client a
// proxy whose .map throws at hydration. See suppressions/reasons.ts.
import { SUPPRESSION_REASONS, type SuppressionReason } from "../suppressions/reasons";
import { IN_FLIGHT } from "@/lib/queue/blockers";
import {
  COLUMN_LABEL,
  dealValue,
  formatMoney,
  isOverdue,
  PIPELINE_STAGES,
  type PipelineStage,
} from "@/lib/pipeline/stages";

import { addNote, setDealValue, setNextAction, setStage } from "../pipeline/actions";
import { BUTTON, BUTTON_QUIET, INPUT, STAGE_TONE, STATUS_TONE } from "../ui";
import {
  closeLead,
  queueWithoutAudit,
  setLeadTimezone,
  type TerminalOutcome,
} from "./actions";

export interface LeadDetail {
  id: string;
  company_name: string | null;
  first_name: string | null;
  last_name: string | null;
  title: string | null;
  work_email: string | null;
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
  stage: string;
  deal_value: number | string | null;
  next_action: string | null;
  next_action_at: string | null;
}

export interface EventRow {
  id: string;
  type: string;
  occurred_at: string;
  /** Notes carry their body here, and stage moves their from/to. */
  payload: Record<string, unknown> | null;
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

/**
 * An instant, rendered for a `datetime-local` input in the operator's own zone.
 *
 * Deliberately not prospect-local. A follow-up is a reminder for the person
 * reading this screen, so it belongs in their day; the prospect-local rule
 * governs when an email leaves, which is bookSlot's business, not this one's.
 */
function toLocalInput(iso: string | null): string {
  if (!iso) return "";
  const at = new Date(iso);
  const pad = (value: number) => String(value).padStart(2, "0");
  return (
    `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}` +
    `T${pad(at.getHours())}:${pad(at.getMinutes())}`
  );
}

/**
 * The part of an event worth reading, for the three types that carry one.
 *
 * Every other entry in the log is a state change whose name says all there is
 * to say, which is how the timeline got away with rendering only the type until
 * notes existed.
 */
function eventDetail(event: EventRow): string {
  const payload = event.payload ?? {};
  const note = payload.note ? ` — ${String(payload.note)}` : "";

  if (event.type === "note") return String(payload.body ?? "");
  if (event.type === "closed") return `${String(payload.outcome ?? "")}${note}`;
  if (event.type === "stage_changed") {
    const from = payload.from ? `${String(payload.from)} → ` : "";
    return `${from}${String(payload.to ?? "")}${note}`;
  }
  return "";
}

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
  defaultDealValue,
}: {
  lead: LeadDetail;
  events: EventRow[];
  evidence: EvidenceRow[];
  screenshotUrls: Record<string, string>;
  currentUserId: string;
  defaultDealValue: number;
}) {
  const router = useRouter();
  const [zone, setZone] = useState(lead.timezone ?? "");
  const [reason, setReason] = useState<SuppressionReason>("manual_dnc");
  const [outcome, setOutcome] = useState<TerminalOutcome>("closed_lost");
  const [confirmingClose, setConfirmingClose] = useState(false);
  const [note, setNote] = useState("");
  const [action, setAction] = useState(lead.next_action ?? "");
  const [actionAt, setActionAt] = useState(toLocalInput(lead.next_action_at));
  const [value, setValue] = useState(
    lead.deal_value === null ? "" : String(lead.deal_value),
  );
  const [noteBody, setNoteBody] = useState("");
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
                  no — needs a work email
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
          <h3 className="mb-2 text-[var(--color-ink-3)]">Deal</h3>

          <div className="space-y-2">
            <div className="flex flex-wrap items-center gap-2">
              <span className="w-28 shrink-0 text-[var(--color-ink-3)]">Stage</span>
              {lead.terminal_outcome ? (
                <span className={STAGE_TONE[lead.terminal_outcome] ?? ""}>
                  {COLUMN_LABEL[
                    lead.terminal_outcome as keyof typeof COLUMN_LABEL
                  ] ?? lead.terminal_outcome}{" "}
                  <span className="text-[var(--color-ink-3)]">
                    — closed, so the stage is final
                  </span>
                </span>
              ) : (
                <>
                  {/* Not gated on `editable`, unlike the two fields below.
                      set_lead_stage() checks ownership with app.same_operator,
                      which resolves an operator's second address; a strict
                      claimed_by === currentUserId here would grey the control
                      out on every lead madhav owns. The RPC arbitrates. */}
                  <select
                    value={lead.stage}
                    disabled={pending}
                    onChange={(event) =>
                      run(() =>
                        setStage(lead.id, event.target.value as PipelineStage),
                      )
                    }
                    className={INPUT}
                  >
                    {PIPELINE_STAGES.map((stage) => (
                      <option key={stage} value={stage}>
                        {COLUMN_LABEL[stage]}
                      </option>
                    ))}
                  </select>
                  <span className={STAGE_TONE[lead.stage] ?? ""}>
                    {lead.stage === "prospect"
                      ? "the sequence still owns this one"
                      : ""}
                  </span>
                </>
              )}
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <span className="w-28 shrink-0 text-[var(--color-ink-3)]">Value</span>
              <input
                inputMode="decimal"
                value={value}
                disabled={!editable || pending}
                onChange={(event) => setValue(event.target.value)}
                placeholder={String(defaultDealValue)}
                className={INPUT + " w-28"}
              />
              <button
                type="button"
                disabled={!editable || pending}
                onClick={() =>
                  run(() =>
                    setDealValue(
                      lead.id,
                      value.trim() === "" ? null : Number(value),
                    ),
                  )
                }
                className={BUTTON}
              >
                Save
              </button>
              <span className="text-[var(--color-ink-3)]">
                {lead.deal_value === null
                  ? `on the org default, ${formatMoney(defaultDealValue)}`
                  : `overridden — ${formatMoney(dealValue(lead, defaultDealValue))}`}
              </span>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <span className="w-28 shrink-0 text-[var(--color-ink-3)]">
                Next action
              </span>
              <input
                value={action}
                disabled={!editable || pending}
                onChange={(event) => setAction(event.target.value)}
                placeholder="call back about the Thursday quote"
                className={INPUT + " w-60"}
              />
              <input
                type="datetime-local"
                value={actionAt}
                disabled={!editable || pending}
                onChange={(event) => setActionAt(event.target.value)}
                className={INPUT}
              />
              <button
                type="button"
                disabled={!editable || pending}
                onClick={() =>
                  run(() =>
                    setNextAction(
                      lead.id,
                      action,
                      actionAt ? new Date(actionAt).toISOString() : null,
                    ),
                  )
                }
                className={BUTTON}
              >
                Save
              </button>
              {lead.next_action && (
                <button
                  type="button"
                  disabled={!editable || pending}
                  onClick={() => {
                    setAction("");
                    setActionAt("");
                    run(() => setNextAction(lead.id, "", null));
                  }}
                  className={BUTTON_QUIET}
                >
                  done
                </button>
              )}
              {isOverdue(lead) && (
                <span className="text-[var(--color-danger)]">overdue</span>
              )}
            </div>
          </div>
        </section>

        <section>
          <h3 className="mb-2 text-[var(--color-ink-3)]">
            Audits <span className="tabular">{evidence.length}</span>
          </h3>
          {evidence.length === 0 ? (
            <div className="space-y-2">
              <p className="text-[var(--color-ink-3)]">Not audited yet.</p>

              {/* An audit is the default, not a requirement. Auditing a lead
                  costs a text message and a stopwatch, which is worth it for a
                  business worth winning and not worth it for the long tail of
                  a scraped import. Queueing without one sends the generic copy,
                  which quotes no audit and therefore cannot contradict itself. */}
              {lead.status === "queued" ? (
                <p className="text-[var(--color-ink-2)]">
                  Queued without an audit, so it gets the generic first touch
                  rather than the one that quotes a callback.
                </p>
              ) : (
                !IN_FLIGHT.has(lead.status) && (
                  <div className="flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      disabled={!editable || pending}
                      onClick={() => run(() => queueWithoutAudit(lead.id))}
                      className={BUTTON}
                    >
                      Send without an audit
                    </button>
                    <span className="text-[var(--color-ink-3)]">
                      Generic copy, no callback quoted. Use it on leads not worth
                      auditing.
                    </span>
                  </div>
                )
              )}
            </div>
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

          {/* `note` has been in the event enum since 0001 and permitted to
              authenticated users since 0005, and nothing has ever written one.
              It ranks 0 in app.lead_status_from_events, so writing one cannot
              move status — which is exactly what commentary should do. */}
          <div className="mb-2 flex flex-wrap items-center gap-2">
            <input
              value={noteBody}
              disabled={pending}
              onChange={(event) => setNoteBody(event.target.value)}
              placeholder="what happened on the call"
              className={INPUT + " w-80"}
            />
            <button
              type="button"
              disabled={pending || noteBody.trim() === ""}
              onClick={() => {
                const body = noteBody;
                setNoteBody("");
                run(() => addNote(lead.id, body));
              }}
              className={BUTTON}
            >
              Add note
            </button>
          </div>

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
                  <span className="min-w-0 break-words text-[var(--color-ink-2)]">
                    {eventDetail(event)}
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
