"use client";

import { DateTime } from "luxon";
import { useCallback, useMemo, useRef, useState, useTransition } from "react";

// A plain module, never through the "use server" actions file.
import { renderTemplate, type TemplateValues } from "@/lib/templates/render";

import { BUTTON, BUTTON_QUIET, INPUT, PANEL } from "../ui";
import { queueWrittenEmail, reviseWrittenEmail } from "./actions";

export interface StarterTemplate {
  id: string;
  name: string;
  step_number: number;
  angle_type: string | null;
  subject: string;
  body: string;
  requires_demo: boolean;
  is_active: boolean;
}

export interface Draft {
  leadId: string;
  company: string | null;
  contactName: string | null;
  title: string | null;
  workEmail: string;
  website: string | null;
  phone: string | null;
  city: string | null;
  state: string | null;
  industry: string | null;
  rating: number | null;
  reviewsCount: number | null;
  timezone: string;
  status: string;
  angleType: string | null;
  demoUrl: string | null;
  step: number;
  replacesSendId: string | null;
  replacesWasWritten: boolean;
  existingSubject: string | null;
  existingBody: string | null;
  slot: {
    at: string;
    local: string;
    mailbox: string;
    mailboxEmail: string;
    /** Forced onto a colleague's mailbox to keep an existing thread intact. */
    pinned: boolean;
  } | null;
  slotProblem: string | null;
  audit: {
    outcome: string | null;
    notes: string | null;
    localTime: string;
    timezone: string;
    responseDelaySeconds: number | null;
  } | null;
  values: TemplateValues;
}

/**
 * A composed email is dispatched VERBATIM, so a leftover {{variable}} does not
 * get skipped the way a template's would. It goes out with the braces in it.
 * This is the check that stops that, and the action repeats it server-side.
 */
const LEFTOVER_VARIABLE = /\{\{\s*[a-z_]+\s*\}\}/i;

interface Editing {
  subject: string;
  body: string;
  templateId: string | null;
}

function leftovers(text: string): string[] {
  return [...new Set(text.match(/\{\{\s*[a-z_]+\s*\}\}/gi) ?? [])];
}

/** "Tue 19 Aug, 09:42" in whatever zone the reader is standing in. */
function yourTime(iso: string): string {
  return DateTime.fromISO(iso).toFormat("ccc d LLL, HH:mm");
}

/** The same instant as the prospect reads it, from the frozen wall clock. */
function theirTime(local: string): string {
  return DateTime.fromISO(local).toFormat("ccc d LLL, HH:mm");
}

function delayLabel(seconds: number | null): string {
  if (seconds === null) return "never replied";
  if (seconds < 90) return `${seconds}s later`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 90) return `${minutes} min later`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h later`;
  return `${Math.round(hours / 24)}d later`;
}

export function WriteClient({
  drafts: initialDrafts,
  templates,
  dryRun,
  mailboxCount,
  myMailboxEmail,
  senderName,
  loadError,
}: {
  drafts: Draft[];
  templates: StarterTemplate[];
  dryRun: boolean;
  /** How many mailboxes YOU can send from. Zero is a blocking state. */
  mailboxCount: number;
  /** The address your emails leave from, for the header line. */
  myMailboxEmail: string | null;
  senderName: string | null;
  loadError: string | null;
}) {
  const [drafts, setDrafts] = useState(initialDrafts);
  const [index, setIndex] = useState(0);

  // Keyed by lead, so flicking between two businesses to compare them does not
  // throw away either half-written email.
  const [edits, setEdits] = useState<Record<string, Editing>>(() => {
    const seeded: Record<string, Editing> = {};
    for (const draft of initialDrafts) {
      if (draft.existingSubject && draft.existingBody) {
        seeded[draft.leadId] = {
          subject: draft.existingSubject,
          body: draft.existingBody,
          templateId: null,
        };
      }
    }
    return seeded;
  });

  const [error, setError] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const bodyRef = useRef<HTMLTextAreaElement>(null);

  const draft = drafts[index] ?? null;
  const editing: Editing = draft
    ? (edits[draft.leadId] ?? { subject: "", body: "", templateId: null })
    : { subject: "", body: "", templateId: null };

  const holes = useMemo(
    () => [...new Set([...leftovers(editing.subject), ...leftovers(editing.body)])],
    [editing.subject, editing.body],
  );

  const setEditing = useCallback(
    (leadId: string, patch: Partial<Editing>) => {
      setEdits((current) => {
        const base: Editing = current[leadId] ?? {
          subject: "",
          body: "",
          templateId: null,
        };
        return { ...current, [leadId]: { ...base, ...patch } };
      });
    },
    [],
  );

  /** Fills the editor with a template already resolved against this lead. */
  function startFrom(template: StarterTemplate) {
    if (!draft) return;
    setError(null);
    setEditing(draft.leadId, {
      subject: renderTemplate(template.subject, draft.values).text,
      body: renderTemplate(template.body, draft.values).text,
      templateId: template.id,
    });
    bodyRef.current?.focus();
  }

  function select(next: number) {
    setError(null);
    setFlash(null);
    setIndex(Math.max(0, Math.min(next, drafts.length - 1)));
  }

  function send() {
    if (!draft || pending) return;
    setError(null);
    setFlash(null);

    if (!editing.subject.trim() || !editing.body.trim()) {
      setError("Write a subject and a body first.");
      return;
    }
    if (LEFTOVER_VARIABLE.test(editing.subject) || LEFTOVER_VARIABLE.test(editing.body)) {
      setError(
        `This still has ${holes.join(", ")} in it. A written email is sent exactly as typed, so that would go out with the braces showing.`,
      );
      return;
    }
    if (!draft.slot && !draft.replacesWasWritten) {
      setError(draft.slotProblem ?? "There is no slot available for this one.");
      return;
    }

    const leadId = draft.leadId;
    const company = draft.company ?? "that lead";
    const revising = draft.replacesWasWritten && draft.replacesSendId;

    startTransition(async () => {
      // Two different calls on purpose. Revising keeps the slot the operator was
      // already shown; queueing chooses one. Collapsing them into "cancel and
      // re-queue" would silently move a send that somebody only wanted to fix a
      // typo in.
      if (revising) {
        const result = await reviseWrittenEmail(
          draft.replacesSendId!,
          editing.subject,
          editing.body,
        );
        if (!result.ok) {
          setError(result.error ?? "That did not go through.");
          return;
        }
        setFlash(
          `Updated the email queued for ${company}. Its send time did not move.`,
        );
      } else {
        const result = await queueWrittenEmail({
          leadId,
          subject: editing.subject,
          body: editing.body,
          templateId: editing.templateId,
        });
        if (!result.ok) {
          setError(result.error ?? "That did not go through.");
          return;
        }
        const booked = result.booked;
        setFlash(
          booked
            ? `Queued for ${company}: leaves ${theirTime(booked.local)} their time (${yourTime(booked.at)} yours), from ${booked.mailbox}.`
            : `Queued for ${company}.`,
        );
      }

      // Off the list and on to the next one. The whole loop is meant to be
      // write, send, write, send, without a decision in between. Removing the
      // lead at `index` means the next one slides into the same position, so
      // the selection only has to move when the list ran out underneath it.
      const remaining = drafts.filter((d) => d.leadId !== leadId);
      setDrafts(remaining);
      setEdits((current) => {
        const next = { ...current };
        delete next[leadId];
        return next;
      });
      setIndex(Math.min(index, Math.max(0, remaining.length - 1)));
    });
  }

  function onBodyKeyDown(event: React.KeyboardEvent) {
    if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
      event.preventDefault();
      send();
    }
  }

  // The starters worth showing for this touch: the ones written for this step,
  // matching the lead's angle, and never one that needs a demo the lead has
  // not had built.
  const starters = useMemo(() => {
    if (!draft) return [];
    return templates.filter(
      (t) =>
        t.step_number === draft.step &&
        (t.angle_type === null || t.angle_type === draft.angleType) &&
        (!t.requires_demo || draft.demoUrl !== null),
    );
  }, [templates, draft]);

  return (
    <div className="flex h-full min-h-0">
      {/* ------------------------------------------------ the worklist */}
      <aside className="flex w-[280px] shrink-0 flex-col border-r border-[var(--color-line)] bg-[var(--color-surface)]">
        <div className="shrink-0 border-b border-[var(--color-line)] px-3 py-2">
          <div className="flex items-baseline gap-2">
            <h1 className="text-[var(--color-ink)]">Write</h1>
            <span className="tabular text-[var(--color-ink-3)]">
              {drafts.length} to go
            </span>
          </div>
          <p className="mt-0.5 text-[var(--color-ink-3)]">
            You write it. The app picks the hour.
          </p>
          {/* Whose outbox this session is. Standing context, so it does not
              have to be re-read per lead. */}
          <p className="mt-0.5 truncate text-[var(--color-ink-3)]">
            {myMailboxEmail ? (
              <>sending as {myMailboxEmail}</>
            ) : (
              <span className="text-[var(--color-warn)]">no mailbox of yours</span>
            )}
          </p>
        </div>

        <ul className="min-h-0 flex-1 overflow-y-auto">
          {drafts.map((item, position) => {
            const started = Boolean(edits[item.leadId]?.body?.trim());
            return (
              <li key={item.leadId}>
                <button
                  type="button"
                  onClick={() => select(position)}
                  className={
                    "block w-full border-b border-[var(--color-line)] px-3 py-2 text-left " +
                    (position === index
                      ? "bg-[var(--color-surface-3)]"
                      : "hover:bg-[var(--color-surface-2)]")
                  }
                >
                  <div className="flex items-baseline gap-2">
                    <span className="min-w-0 flex-1 truncate text-[var(--color-ink)]">
                      {item.company ?? item.workEmail}
                    </span>
                    <span className="tabular shrink-0 text-[var(--color-ink-3)]">
                      T{item.step}
                    </span>
                  </div>
                  <div className="truncate text-[var(--color-ink-3)]">
                    {item.city ?? "—"}
                    {item.state ? `, ${item.state}` : ""}
                  </div>
                  <div className="tabular truncate text-[var(--color-ink-2)]">
                    {item.slot
                      ? `${theirTime(item.slot.local)} their time`
                      : (item.slotProblem ?? "no slot")}
                  </div>
                  {(started || item.replacesWasWritten) && (
                    <div className="text-[var(--color-info)]">
                      {item.replacesWasWritten ? "already queued" : "draft started"}
                    </div>
                  )}
                </button>
              </li>
            );
          })}

          {drafts.length === 0 && (
            <li className="px-3 py-4 text-[var(--color-ink-3)]">
              Nothing left to write. Claim more leads on the Leads screen.
            </li>
          )}
        </ul>
      </aside>

      {/* ------------------------------------------------ the composer */}
      <section className="flex min-w-0 flex-1 flex-col">
        {loadError && (
          <p role="alert" className="border-b border-[var(--color-line)] px-4 py-2 text-[var(--color-danger)]">
            Could not load the worklist: {loadError}
          </p>
        )}

        {!draft ? (
          <div className="p-4">
            <div className={PANEL}>
              <p className="text-[var(--color-ink-2)]">
                Nothing to write. This list holds leads you have claimed that are
                qualified, have a work email and a timezone, and are not
                suppressed or halted.
              </p>
            </div>
          </div>
        ) : (
          <>
            <header className="shrink-0 border-b border-[var(--color-line)] px-4 py-2">
              <div className="flex items-baseline gap-3">
                <h2 className="truncate text-[var(--color-ink)]">
                  {draft.company ?? draft.workEmail}
                </h2>
                <span className="tabular text-[var(--color-ink-3)]">
                  touch {draft.step} of 4
                </span>
                {draft.replacesSendId && !draft.replacesWasWritten && (
                  <span className="text-[var(--color-warn)]">
                    replaces the template email already queued for this step
                  </span>
                )}
                {draft.replacesWasWritten && (
                  <span className="text-[var(--color-info)]">
                    editing the email you already queued
                  </span>
                )}
              </div>
              <div className="tabular text-[var(--color-ink-2)]">
                To: {draft.contactName ? `${draft.contactName}, ` : ""}
                {draft.workEmail}
              </div>
            </header>

            {starters.length > 0 && (
              <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-[var(--color-line)] px-4 py-2">
                <span className="text-[var(--color-ink-3)]">Start from:</span>
                {starters.map((template) => (
                  <button
                    key={template.id}
                    type="button"
                    className={BUTTON_QUIET}
                    onClick={() => startFrom(template)}
                  >
                    {template.name}
                    {!template.is_active && (
                      <span className="ml-1 text-[var(--color-ink-3)]">draft</span>
                    )}
                  </button>
                ))}
                <span className="text-[var(--color-ink-3)]">
                  filled in with this lead&rsquo;s details, then yours to rewrite
                </span>
              </div>
            )}

            <div className="flex min-h-0 flex-1 flex-col gap-2 p-4">
              <input
                className={INPUT + " w-full"}
                placeholder="Subject"
                value={editing.subject}
                onChange={(event) =>
                  setEditing(draft.leadId, { subject: event.target.value })
                }
                onKeyDown={onBodyKeyDown}
              />
              <textarea
                ref={bodyRef}
                className={INPUT + " min-h-0 w-full flex-1 resize-none leading-relaxed"}
                placeholder={`Write to ${draft.company ?? "them"}. Whatever you type is exactly what they get.`}
                value={editing.body}
                onChange={(event) =>
                  setEditing(draft.leadId, { body: event.target.value })
                }
                onKeyDown={onBodyKeyDown}
              />
            </div>

            {/* ---------------------------------------------- the footer */}
            <footer className="shrink-0 border-t border-[var(--color-line)] px-4 py-2">
              {error && (
                <p role="alert" className="mb-1 text-[var(--color-danger)]">
                  {error}
                </p>
              )}
              {flash && !error && (
                <p className="mb-1 text-[var(--color-ok)]">{flash}</p>
              )}
              {holes.length > 0 && !error && (
                <p className="mb-1 text-[var(--color-warn)]">
                  Still to fill in: {holes.join(", ")}
                </p>
              )}

              <div className="flex items-center gap-3">
                <button
                  type="button"
                  className={BUTTON}
                  onClick={send}
                  disabled={pending || (!draft.slot && !draft.replacesWasWritten)}
                >
                  {draft.replacesWasWritten ? "Update it" : "Send it"}
                </button>

                <span className="tabular text-[var(--color-ink-2)]">
                  {draft.replacesWasWritten ? (
                    "keeps the time it already has"
                  ) : draft.slot ? (
                    <>
                      leaves {theirTime(draft.slot.local)} in {draft.timezone}, which
                      is {yourTime(draft.slot.at)} for you
                    </>
                  ) : (
                    <span className="text-[var(--color-warn)]">
                      {draft.slotProblem}
                    </span>
                  )}
                </span>

                <span className="ml-auto text-[var(--color-ink-3)]">
                  Ctrl+Enter sends and opens the next one
                </span>
              </div>

              {/*
                Which account it leaves from, BEFORE it leaves. This was
                computed and passed down for months and never rendered, so the
                first anyone learned of the sending address was the confirmation
                line after pressing Ctrl+Enter -- which is how an operator sent
                three emails from a colleague's mailbox without noticing.
              */}
              {draft.slot && !draft.replacesWasWritten && (
                <p className="mt-1 text-[var(--color-ink-2)]">
                  from {draft.slot.mailboxEmail}
                  {draft.slot.pinned ? (
                    <span className="text-[var(--color-ink-3)]">
                      {" "}
                      to stay on the thread this lead already has
                    </span>
                  ) : null}
                </p>
              )}

              {(dryRun || mailboxCount === 0 || !senderName) && (
                <p className="mt-1 text-[var(--color-warn)]">
                  {mailboxCount === 0
                    ? "You have no connected mailbox, so nothing you write can go out. Connect one on Mailboxes."
                    : !senderName
                      ? "Your mailbox has no display name yet, so nothing can go out. Set one on Mailboxes."
                      : "Dry run is on, so queued emails will sit here rather than send. Turn it off on Settings."}
                </p>
              )}
            </footer>
          </>
        )}
      </section>

      {/* ------------------------------------------------ what to say it about */}
      {draft && (
        <aside className="w-[300px] shrink-0 space-y-3 overflow-y-auto border-l border-[var(--color-line)] bg-[var(--color-surface)] p-3">
          <div>
            <h3 className="text-[var(--color-ink-3)]">The business</h3>
            <dl className="mt-1 space-y-0.5">
              <Fact label="Where" value={[draft.city, draft.state].filter(Boolean).join(", ") || null} />
              <Fact label="Trade" value={draft.industry} />
              <Fact
                label="Reviews"
                value={
                  draft.rating !== null
                    ? `${draft.rating} from ${draft.reviewsCount ?? 0}`
                    : null
                }
              />
              <Fact label="Phone" value={draft.phone} />
              <Fact label="Contact" value={draft.contactName} />
              <Fact label="Role" value={draft.title} />
              <Fact label="Their clock" value={draft.timezone} />
            </dl>
            {draft.website && (
              <a
                href={draft.website}
                target="_blank"
                rel="noreferrer noopener"
                className="mt-1 block truncate text-[var(--color-info)] underline"
              >
                {draft.website}
              </a>
            )}
          </div>

          {draft.demoUrl && (
            <div>
              <h3 className="text-[var(--color-ink-3)]">Their demo</h3>
              <a
                href={draft.demoUrl}
                target="_blank"
                rel="noreferrer noopener"
                className="block truncate text-[var(--color-info)] underline"
              >
                {draft.demoUrl}
              </a>
            </div>
          )}

          {draft.audit ? (
            <div>
              <h3 className="text-[var(--color-ink-3)]">What happened when we called</h3>
              <p className="text-[var(--color-ink)]">
                {DateTime.fromISO(draft.audit.localTime).toFormat("cccc h:mma").toLowerCase()},{" "}
                {delayLabel(draft.audit.responseDelaySeconds)}
              </p>
              {draft.audit.outcome && (
                <p className="text-[var(--color-ink-2)]">{draft.audit.outcome}</p>
              )}
              {draft.audit.notes && (
                <p className="text-[var(--color-ink-3)]">{draft.audit.notes}</p>
              )}
            </div>
          ) : (
            <p className="text-[var(--color-ink-3)]">
              Nobody audited this one, so there is no callback to quote. Write it
              from what you can see about the business.
            </p>
          )}

          <div>
            <h3 className="text-[var(--color-ink-3)]">House rules</h3>
            <ul className="mt-1 space-y-0.5 text-[var(--color-ink-2)]">
              <li>No em dashes.</li>
              <li>Say what they are losing, not what we sell.</li>
              <li>One question, and it offers two answers.</li>
              <li>Sign off as {senderName ?? "your mailbox display name"}.</li>
            </ul>
            <p className="mt-1 text-[var(--color-ink-3)]">
              These are the rules the templates are held to. Yours are not
              checked against them, because a person writing to one business can
              see things a rule cannot.
            </p>
          </div>
        </aside>
      )}
    </div>
  );
}

function Fact({ label, value }: { label: string; value: string | null }) {
  if (!value) return null;
  return (
    <div className="flex gap-2">
      <dt className="w-20 shrink-0 text-[var(--color-ink-3)]">{label}</dt>
      <dd className="min-w-0 flex-1 break-words text-[var(--color-ink-2)]">{value}</dd>
    </div>
  );
}
