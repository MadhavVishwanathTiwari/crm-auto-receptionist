"use client";

import { PenLine, X } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { suppressLead } from "../suppressions/actions";
// The reasons array and its type come from a plain module, not the "use server"
// actions file — importing the array through a server module hands a client a
// proxy whose .map throws at hydration. See suppressions/reasons.ts.
import { SUPPRESSION_REASONS, type SuppressionReason } from "../suppressions/reasons";
import { IN_FLIGHT } from "@/lib/queue/blockers";
import { formatWallClock, formatYours, fromYourInput } from "@/lib/time/format";
import {
  COLUMN_LABEL,
  dealValue,
  formatMoney,
  isOverdue,
  PIPELINE_STAGES,
  type PipelineStage,
} from "@/lib/pipeline/stages";

import { addNote, setDealValue, setNextAction, setStage } from "../pipeline/actions";
import { Badge } from "@/components/ui/Badge";
import { Button, buttonClasses } from "@/components/ui/Button";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { inputClasses } from "@/components/ui/Input";
import { cn } from "@/lib/cn";
import { useAction } from "@/lib/ui/useAction";
import { useEscape } from "@/lib/ui/useEscape";
import { humanise, STAGE_TONE, STATUS_TONE, toneFor } from "@/lib/ui/tones";

import { useViewerZone } from "../ViewerZone";
import { cancelSend } from "../write/actions";
import {
  closeLead,
  queueWithoutAudit,
  resolveStalledSend,
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
  demo_txt_url: string | null;
  demo_ready_at: string | null;
}

export interface EventRow {
  id: string;
  type: string;
  occurred_at: string;
  /** Notes carry their body here, and stage moves their from/to. */
  payload: Record<string, unknown> | null;
  /** Who did it. Null for the machine: the dispatcher, the poller, a trigger. */
  actor_id: string | null;
}

/** An email booked for this lead and not yet gone. */
export interface NextSendRow {
  id: string;
  step_number: number;
  status: string;
  scheduled_at: string;
  /** Prospect-local wall clock, frozen at plan time. No offset. */
  scheduled_local: string;
  prospect_timezone: string;
  outcome_reason: string | null;
  /** Set when a person wrote it. */
  composed_subject: string | null;
  mailbox_email: string | null;
}

/** Where the lead came from, rebuilt from its import rather than an event. */
export interface ImportedInfo {
  at: string;
  filename: string | null;
  by: string | null;
}

/** "by madhav", or "by the app" when no person did it. */
function whoDid(actorId: string | null, names: Record<string, string>): string {
  if (!actorId) return "by the app";
  return `by ${names[actorId] ?? "a former member"}`;
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
function toLocalInput(iso: string | null, zone: string | null): string {
  return formatYours(iso, zone, "input");
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
  if (event.type === "demo_ready") return String(payload.slug ?? "");
  if (event.type === "demo_failed") return String(payload.reason ?? "");
  return "";
}

function Field({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex gap-3 py-0.5">
      <span className="w-28 shrink-0 text-ink-3">{label}</span>
      <span className="min-w-0 break-words text-ink-2">{value || "—"}</span>
    </div>
  );
}

/**
 * The demo, or why there is none.
 *
 * The builder in the Auto-Receptionist repo posts a refusal as a `demo_failed`
 * event, and until that existed "no demo" and "the builder has given up on this
 * site" looked identical from here. The events are already loaded for the
 * timeline, newest first, so this costs no query.
 */
function DemoState({
  lead,
  events,
  zone,
}: {
  lead: LeadDetail;
  events: EventRow[];
  zone: string | null;
}) {
  if (lead.demo_txt_url) {
    return (
      <span>
        <a
          href={lead.demo_txt_url}
          target="_blank"
          rel="noreferrer"
          className="underline decoration-line-strong underline-offset-2"
        >
          {lead.demo_txt_url.replace(/^https?:\/\//, "")}
        </a>
        {lead.demo_ready_at && (
          <span className="text-ink-3"> · {formatYours(lead.demo_ready_at, zone)}</span>
        )}
      </span>
    );
  }

  const failure = events.find((event) => event.type === "demo_failed");
  if (failure) {
    return (
      <span className="text-warn">
        Could not build: {String(failure.payload?.reason ?? "no reason given")}
        <span className="text-ink-3"> · {formatYours(failure.occurred_at, zone)}</span>
      </span>
    );
  }

  return <span className="text-ink-3">not built yet</span>;
}

/** A send that reached Gmail and was never recorded. See 0040. */
export interface StalledSendRow {
  id: string;
  step_number: number;
  sending_at: string | null;
  error_detail: string | null;
  rendered_subject: string | null;
  composed_subject: string | null;
}

/** How many stalled attempts to list before summarising the rest. */
const STALLED_SHOWN = 3;

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
  stalledSends,
  nextSends,
  imported,
  actorNames,
  screenshotUrls,
  currentUserId,
  defaultDealValue,
}: {
  lead: LeadDetail;
  events: EventRow[];
  evidence: EvidenceRow[];
  /** Newest first. Each one holds the lead until somebody settles it. */
  stalledSends: StalledSendRow[];
  /** Booked, blocked or on its way. Lowest step first. */
  nextSends: NextSendRow[];
  imported: ImportedInfo | null;
  /** user id -> operator name, both of madhav's accounts included. */
  actorNames: Record<string, string>;
  screenshotUrls: Record<string, string>;
  currentUserId: string;
  defaultDealValue: number;
}) {
  const router = useRouter();
  // The reader's zone, for every "when" on this panel. `zone` below is the
  // PROSPECT's, which the timezone field edits.
  const { zone: viewerZone } = useViewerZone();
  const [zone, setZone] = useState(lead.timezone ?? "");
  const [reason, setReason] = useState<SuppressionReason>("manual_dnc");
  const [outcome, setOutcome] = useState<TerminalOutcome>("closed_lost");
  const [confirmingClose, setConfirmingClose] = useState(false);
  const [note, setNote] = useState("");
  const [action, setAction] = useState(lead.next_action ?? "");
  const [actionAt, setActionAt] = useState(toLocalInput(lead.next_action_at, viewerZone));
  const [value, setValue] = useState(
    lead.deal_value === null ? "" : String(lead.deal_value),
  );
  const [noteBody, setNoteBody] = useState("");
  /** The booked send the operator is asking to cancel, if any. */
  const [cancelling, setCancelling] = useState<string | null>(null);

  const { run, pending, error } = useAction();

  const close = () => router.push("/leads");

  // Shared, so an Escape that a dialog or the command palette already consumed
  // does not also navigate this drawer away behind it.
  useEscape(close);

  const mine = lead.claimed_by === currentUserId;
  const editable = lead.claimed_by === null || mine;

  return (
    <aside className="flex h-full w-(--drawer-w) shrink-0 flex-col border-l border-line bg-surface">
      <header className="flex shrink-0 items-start gap-3 border-b border-line px-4 py-3">
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-xl font-semibold text-ink">
            {lead.company_name ?? "Lead"}
          </h2>
          <div className="mt-1 flex items-center gap-2">
            <Badge tone={toneFor(STATUS_TONE, lead.status)}>
              {humanise(lead.status)}
            </Badge>
            <Badge tone={toneFor(STAGE_TONE, lead.stage)} variant="outline">
              {humanise(lead.stage)}
            </Badge>
          </div>
        </div>

        {/* Always offered while the lead is open. /write says in words why a
            lead is not on your list, which beats a link that is not there. */}
        {!lead.terminal_outcome && !lead.halt_reason && (
          <Link
            href={`/write?lead=${lead.id}`}
            className={buttonClasses("primary", "sm")}
          >
            <PenLine size={13} />
            Write
          </Link>
        )}
        <Button
          variant="ghost"
          size="sm"
          onClick={close}
          aria-label="Close lead"
          icon={<X size={14} />}
          className="-mr-1.5"
        />
      </header>

      <div className="min-h-0 flex-1 space-y-5 overflow-y-auto p-4 text-lg">
        {error && (
          <p role="alert" className="rounded-md bg-danger-soft px-3 py-2 text-danger">
            {error}
          </p>
        )}

        {/* A send whose outcome nobody knows holds this lead (0040): the planner
            books nothing and /write refuses it until a person says what
            happened. Not gated on `editable`; resolve_stalled_send() checks
            ownership with app.same_operator, the same as set_lead_stage(). */}
        {stalledSends.length > 0 && (
          <section className="space-y-2 rounded-lg border border-warn bg-warn-soft p-3">
            <h3 className="text-warn">
              {stalledSends.length === 1
                ? "An email may have gone out without being recorded"
                : `${stalledSends.length} emails may have gone out without being recorded`}
            </h3>
            <p className="text-ink-3">
              Nothing more is sent to this lead until each one is settled. Check the
              sending mailbox&apos;s Sent folder, then say what happened.
              {stalledSends.length > STALLED_SHOWN &&
                " With this many, the repair on Import settles them all at once."}
            </p>
            <ul className="space-y-2">
              {stalledSends.slice(0, STALLED_SHOWN).map((send) => {
                const subject = send.rendered_subject ?? send.composed_subject;
                return (
                  <li key={send.id} className="space-y-1">
                    <div className="text-ink-2">
                      <span className="tabular">T{send.step_number}</span> reached Gmail{" "}
                      <span className="tabular">
                        {formatYours(send.sending_at, viewerZone)}
                      </span>
                      {subject ? ` — "${subject}"` : ""}
                    </div>
                    {send.error_detail && (
                      <div className="break-words text-ink-3">
                        {send.error_detail}
                      </div>
                    )}
                    <div className="flex flex-wrap gap-2">
                      <button
                        type="button"
                        disabled={pending}
                        onClick={() => run(() => resolveStalledSend(send.id, true))}
                        className={buttonClasses("secondary", "md")}
                      >
                        It went out
                      </button>
                      <button
                        type="button"
                        disabled={pending}
                        onClick={() => run(() => resolveStalledSend(send.id, false))}
                        className={buttonClasses("secondary", "md")}
                      >
                        It did not go out
                      </button>
                    </div>
                  </li>
                );
              })}
            </ul>
            {stalledSends.length > STALLED_SHOWN && (
              <p className="text-ink-3">
                and {stalledSends.length - STALLED_SHOWN} more
              </p>
            )}
          </section>
        )}

        {nextSends.length > 0 && (
          <section className="space-y-2 rounded-lg border border-line-2 bg-surface-2 p-3">
            <h3 className="text-xs font-medium tracking-wide text-ink-3 uppercase">Next email</h3>
            {nextSends.map((send) => {
              const editable = send.status === "planned" || send.status === "blocked";
              return (
                <div key={send.id} className="space-y-1">
                  <div className="text-ink-2">
                    <span className="tabular">T{send.step_number}</span>{" "}
                    {send.status === "blocked" ? (
                      <span className="text-warn">
                        blocked: {send.outcome_reason ?? "no capacity"}
                      </span>
                    ) : send.status === "planned" ? (
                      <span className="tabular">
                        leaves {formatWallClock(send.scheduled_local)} their time (
                        {formatYours(send.scheduled_at, viewerZone)} yours)
                      </span>
                    ) : (
                      <span className="text-info">on its way out now</span>
                    )}
                  </div>
                  <div className="break-words text-ink-3">
                    {send.composed_subject ? (
                      <>
                        <span className="text-info">written</span> &ldquo;
                        {send.composed_subject}&rdquo;
                      </>
                    ) : (
                      "from a template"
                    )}
                    {send.mailbox_email ? ` · from ${send.mailbox_email}` : ""}
                  </div>
                  {editable && (
                    <div className="flex flex-wrap gap-2">
                      <Link href={`/write?lead=${lead.id}`} className={buttonClasses("secondary", "md")}>
                        {send.composed_subject ? "Edit on Write" : "Write it instead"}
                      </Link>
                      <Button
                        variant="danger"
                        size="sm"
                        disabled={pending}
                        onClick={() => setCancelling(send.id)}
                      >
                        Cancel it
                      </Button>
                    </div>
                  )}
                </div>
              );
            })}
          </section>
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
          <Field label="Demo" value={<DemoState lead={lead} events={events} zone={viewerZone} />} />
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
                <span className="text-ink-3">
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
                <span className="text-danger">{lead.halt_reason}</span>
              }
            />
          )}
        </section>

        <section>
          <h3 className="mb-2 text-xs font-medium tracking-wide text-ink-3 uppercase">Timezone</h3>
          <div className="flex flex-wrap items-center gap-2">
            <input
              list="iana-zones"
              value={zone}
              disabled={!editable || pending}
              onChange={(event) => setZone(event.target.value)}
              placeholder="America/Chicago"
              className={inputClasses("w-60")}
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
              className={buttonClasses("secondary", "md")}
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
                className={buttonClasses("ghost", "sm")}
              >
                clear
              </button>
            )}
            <span className="text-ink-3">
              {lead.timezone_source
                ? `set ${lead.timezone_source}`
                : "unresolved — never scheduled"}
            </span>
          </div>
        </section>

        <section>
          <h3 className="mb-2 text-xs font-medium tracking-wide text-ink-3 uppercase">Deal</h3>

          <div className="space-y-2">
            <div className="flex flex-wrap items-center gap-2">
              <span className="w-28 shrink-0 text-ink-3">Stage</span>
              {lead.terminal_outcome ? (
                <span className={STAGE_TONE[lead.terminal_outcome] ?? ""}>
                  {COLUMN_LABEL[
                    lead.terminal_outcome as keyof typeof COLUMN_LABEL
                  ] ?? lead.terminal_outcome}{" "}
                  <span className="text-ink-3">
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
                    className={inputClasses()}
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
              <span className="w-28 shrink-0 text-ink-3">Value</span>
              <input
                inputMode="decimal"
                value={value}
                disabled={!editable || pending}
                onChange={(event) => setValue(event.target.value)}
                placeholder={String(defaultDealValue)}
                className={inputClasses("w-28")}
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
                className={buttonClasses("secondary", "md")}
              >
                Save
              </button>
              <span className="text-ink-3">
                {lead.deal_value === null
                  ? `on the org default, ${formatMoney(defaultDealValue)}`
                  : `overridden — ${formatMoney(dealValue(lead, defaultDealValue))}`}
              </span>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <span className="w-28 shrink-0 text-ink-3">
                Next action
              </span>
              <input
                value={action}
                disabled={!editable || pending}
                onChange={(event) => setAction(event.target.value)}
                placeholder="call back about the Thursday quote"
                className={inputClasses("w-60")}
              />
              <input
                type="datetime-local"
                value={actionAt}
                disabled={!editable || pending}
                onChange={(event) => setActionAt(event.target.value)}
                className={inputClasses()}
              />
              <button
                type="button"
                disabled={!editable || pending}
                onClick={() =>
                  run(() =>
                    setNextAction(
                      lead.id,
                      action,
                      fromYourInput(actionAt, viewerZone),
                    ),
                  )
                }
                className={buttonClasses("secondary", "md")}
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
                  className={buttonClasses("ghost", "sm")}
                >
                  done
                </button>
              )}
              {isOverdue(lead) && (
                <span className="text-danger">overdue</span>
              )}
            </div>
          </div>
        </section>

        <section>
          <h3 className="mb-2 text-xs font-medium tracking-wide text-ink-3 uppercase">
            Audits <span className="tabular">{evidence.length}</span>
          </h3>
          {evidence.length === 0 ? (
            <div className="space-y-2">
              <p className="text-ink-3">Not audited yet.</p>

              {/* An audit is the default, not a requirement. Auditing a lead
                  costs a text message and a stopwatch, which is worth it for a
                  business worth winning and not worth it for the long tail of
                  a scraped import. Queueing without one sends the generic copy,
                  which quotes no audit and therefore cannot contradict itself. */}
              {lead.status === "queued" ? (
                <p className="text-ink-2">
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
                      className={buttonClasses("secondary", "md")}
                    >
                      Send without an audit
                    </button>
                    <span className="text-ink-3">
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
                <div key={row.id} className="border border-line p-2">
                  <div className="flex flex-wrap gap-x-4 text-ink-2">
                    <span>{row.angle_type.replace(/_/g, " ")}</span>
                    <span className="tabular">
                      {row.audited_at_local.replace("T", " ").slice(0, 16)}{" "}
                      <span className="text-ink-3">
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
                    <p className="mt-1 text-ink-3">{row.notes}</p>
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
          <h3 className="mb-2 text-xs font-medium tracking-wide text-ink-3 uppercase">Timeline</h3>

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
              className={inputClasses("w-80")}
            />
            <button
              type="button"
              disabled={pending || noteBody.trim() === ""}
              onClick={() => {
                const body = noteBody;
                setNoteBody("");
                run(() => addNote(lead.id, body));
              }}
              className={buttonClasses("secondary", "md")}
            >
              Add note
            </button>
          </div>

          {events.length === 0 && !imported ? (
            <p className="text-ink-3">No events yet.</p>
          ) : (
            <ul className="space-y-0.5">
              {events.map((event) => (
                <li key={event.id} className="flex gap-3">
                  <span className="tabular w-32 shrink-0 text-ink-3">
                    {formatYours(event.occurred_at, viewerZone)}
                  </span>
                  <span className={STATUS_TONE[event.type] ?? ""}>
                    {event.type.replace(/_/g, " ")}
                  </span>
                  <span className="min-w-0 flex-1 break-words text-ink-2">
                    {eventDetail(event)}
                  </span>
                  <span className="shrink-0 text-ink-3">
                    {whoDid(event.actor_id, actorNames)}
                  </span>
                </li>
              ))}
              {/* The first line of every lead's story, and the one nothing
                  wrote down: rebuilt from the lead and its import. */}
              {imported && !events.some((event) => event.type === "imported") && (
                <li className="flex gap-3">
                  <span className="tabular w-32 shrink-0 text-ink-3">
                    {formatYours(imported.at, viewerZone)}
                  </span>
                  <span>imported</span>
                  <span className="min-w-0 flex-1 break-words text-ink-2">
                    {imported.filename ? `from ${imported.filename}` : ""}
                  </span>
                  <span className="shrink-0 text-ink-3">
                    {whoDid(imported.by, actorNames)}
                  </span>
                </li>
              )}
            </ul>
          )}
        </section>

        <section className="border-t border-line pt-4">
          <h3 className="mb-2 text-xs font-medium tracking-wide text-ink-3 uppercase">Stop contacting</h3>

          <div className="mb-2 flex flex-wrap items-center gap-2">
            <select
              value={reason}
              disabled={pending}
              onChange={(event) =>
                setReason(event.target.value as SuppressionReason)
              }
              className={inputClasses()}
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
              className={buttonClasses("secondary", "md")}
            >
              Suppress this address
            </button>
            <button
              type="button"
              disabled={pending || !lead.website}
              onClick={() => run(() => suppressLead(lead.id, "domain", reason, note))}
              className={buttonClasses("secondary", "md")}
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
              className={inputClasses()}
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
              className={inputClasses("min-w-[160px] flex-1")}
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
                  className={buttonClasses("secondary", "md", "text-danger")}
                >
                  Yes, close it
                </button>
                <button
                  type="button"
                  onClick={() => setConfirmingClose(false)}
                  className={buttonClasses("ghost", "sm")}
                >
                  cancel
                </button>
              </>
            ) : (
              <button
                type="button"
                disabled={pending || lead.terminal_outcome !== null}
                onClick={() => setConfirmingClose(true)}
                className={buttonClasses("secondary", "md")}
              >
                {lead.terminal_outcome ? "Already closed" : "Close lead"}
              </button>
            )}
          </div>
          <p className="mt-2 text-ink-3">
            Closing cannot be undone from the app. A terminal outcome wins over every
            later event, so reopening would need a database change.
          </p>
        </section>
      </div>

      {/* window.confirm() used to ask this. It cannot be styled, it cannot say
          which send it means beyond a sentence, and on a screen that is itself
          dismissed by Escape it was the only overlay the operator could not
          tell apart from the drawer behind it. */}
      <ConfirmDialog
        open={cancelling !== null}
        onCancel={() => setCancelling(null)}
        onConfirm={() => {
          const id = cancelling;
          setCancelling(null);
          if (id) {
            run(() => cancelSend(id), { success: "Booked send cancelled" });
          }
        }}
        destructive
        pending={pending}
        title="Cancel this booked send?"
        description={`The planner may book a template send to ${lead.company_name ?? "this lead"} in its place.`}
        confirmLabel="Cancel the send"
        cancelLabel="Leave it booked"
      />
    </aside>
  );
}
