"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { DateTime } from "luxon";
import { useEffect, useState, useTransition } from "react";

import {
  displayName,
  socialLinks,
  telHref,
  websiteHref,
} from "@/lib/contacts/links";
import {
  COLUMN_LABEL,
  columnFor,
  PIPELINE_STAGES,
  type PipelineStage,
} from "@/lib/pipeline/stages";

import { claimLead, releaseLead } from "../leads/actions";
import { addNote, setNextAction, setStage } from "../pipeline/actions";
import { BUTTON, BUTTON_QUIET, INPUT, STAGE_TONE, STATUS_TONE } from "../ui";

export interface ContactDetail {
  id: string;
  company_name: string | null;
  first_name: string | null;
  middle_name: string | null;
  last_name: string | null;
  name_suffix: string | null;
  title: string | null;
  work_email: string | null;
  phone: string | null;
  phone_e164: string | null;
  website: string | null;
  city: string | null;
  state: string | null;
  postal_code: string | null;
  country_code: string | null;
  personal_linkedin: string | null;
  personal_instagram: string | null;
  personal_facebook: string | null;
  personal_twitter: string | null;
  company_linkedin: string | null;
  company_instagram: string | null;
  company_facebook: string | null;
  company_twitter: string | null;
  claimed_by: string | null;
  status: string;
  status_updated_at: string;
  stage: string;
  terminal_outcome: string | null;
  next_action: string | null;
  next_action_at: string | null;
}

export interface NoteRow {
  id: string;
  occurred_at: string;
  payload: Record<string, unknown> | null;
}

/** A datetime-local value from an ISO instant, in the operator's own zone. */
function toLocalInput(iso: string | null): string {
  if (!iso) return "";
  return DateTime.fromISO(iso).toFormat("yyyy-LL-dd'T'HH:mm");
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex gap-2">
      <span className="w-[92px] shrink-0 text-[var(--color-ink-3)]">{label}</span>
      <span className="min-w-0 flex-1 break-words text-[var(--color-ink)]">
        {children}
      </span>
    </div>
  );
}

export function ContactCard({
  contact,
  notes,
  currentUserId,
}: {
  contact: ContactDetail;
  notes: NoteRow[];
  currentUserId: string;
}) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const [action, setAction] = useState(contact.next_action ?? "");
  const [actionAt, setActionAt] = useState(toLocalInput(contact.next_action_at));
  const [note, setNote] = useState("");

  // Listener only, no state set in the effect body.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") router.push("/contacts");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [router]);

  function run(work: () => Promise<{ ok: boolean; error?: string }>) {
    setError(null);
    startTransition(async () => {
      const result = await work();
      if (!result.ok) setError(result.error ?? "That did not work.");
    });
  }

  const mine = contact.claimed_by === currentUserId;
  // next_action is a plain UPDATE and leads_update compares claimed_by strictly,
  // so the control has to match or it offers something the database refuses.
  const editable = contact.claimed_by === null || mine;
  const closed = contact.terminal_outcome !== null;

  const name = displayName(contact);
  const socials = socialLinks(contact);
  const site = websiteHref(contact.website);
  const tel = telHref(contact);
  const place = [contact.city, contact.state, contact.postal_code, contact.country_code]
    .map((part) => (part ?? "").trim())
    .filter((part) => part !== "")
    .join(", ");

  return (
    <section className="flex h-full min-w-0 flex-1 flex-col overflow-hidden border-l border-[var(--color-line)] bg-[var(--color-surface)]">
      <header className="flex shrink-0 items-baseline gap-3 border-b border-[var(--color-line)] px-4 py-2">
        <h2 className="truncate text-[var(--color-ink)]">
          {name || contact.company_name || "Unnamed"}
        </h2>
        <span className={STATUS_TONE[contact.status] ?? "text-[var(--color-ink-3)]"}>
          {contact.status.replace(/_/g, " ")}
        </span>
        {/* The seam. Everything this screen does not do is one click away. */}
        <Link
          href={{ pathname: "/leads", query: { lead: contact.id } }}
          className="ml-auto text-[var(--color-ink-2)] hover:text-[var(--color-ink)] hover:underline"
        >
          Open in Leads →
        </Link>
        <button type="button" onClick={() => router.push("/contacts")} className={BUTTON_QUIET}>
          close
        </button>
      </header>

      {error && (
        <p
          role="alert"
          className="shrink-0 border-b border-[var(--color-line)] px-4 py-1 text-[var(--color-danger)]"
        >
          {error}
        </p>
      )}

      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-3">
        <section className="space-y-1">
          {contact.title && <Field label="Title">{contact.title}</Field>}
          {contact.company_name && <Field label="Company">{contact.company_name}</Field>}

          {/* Reach, not just read. /leads renders all three as plain text. */}
          <Field label="Email">
            {contact.work_email ? (
              <a href={`mailto:${contact.work_email}`} className="hover:underline">
                {contact.work_email}
              </a>
            ) : (
              <span className="text-[var(--color-ink-3)]">none on file</span>
            )}
          </Field>

          <Field label="Phone">
            {tel ? (
              <a href={tel} className="hover:underline">
                {contact.phone_e164 ?? contact.phone}
              </a>
            ) : (
              <span className="text-[var(--color-ink-3)]">none on file</span>
            )}
          </Field>

          {site && (
            <Field label="Website">
              <a
                href={site}
                target="_blank"
                rel="noreferrer"
                className="hover:underline"
              >
                {contact.website}
              </a>
            </Field>
          )}

          {place && <Field label="Location">{place}</Field>}

          {socials.length > 0 && (
            <Field label="Social">
              <span className="flex flex-wrap gap-x-3 gap-y-1">
                {socials.map((link) => (
                  <a
                    key={`${link.scope}-${link.network}`}
                    href={link.href}
                    target="_blank"
                    rel="noreferrer"
                    title={link.raw}
                    className="hover:underline"
                  >
                    {link.label}
                    {link.scope === "company" && (
                      <span className="text-[var(--color-ink-3)]"> (co)</span>
                    )}
                  </a>
                ))}
              </span>
            </Field>
          )}
        </section>

        <section className="space-y-2 border-t border-[var(--color-line)] pt-3">
          <div className="flex items-center gap-2">
            <span className="w-[92px] shrink-0 text-[var(--color-ink-3)]">Stage</span>
            {closed ? (
              <span className={STAGE_TONE[columnFor(contact)] ?? ""}>
                {COLUMN_LABEL[columnFor(contact)]}
              </span>
            ) : (
              // Deliberately not gated on `editable`: set_lead_stage() checks
              // app.same_operator, which resolves an operator's second address,
              // and a strict comparison here would grey this out on every lead
              // one of them owns. The RPC arbitrates.
              <select
                value={contact.stage}
                disabled={pending}
                onChange={(event) =>
                  run(() => setStage(contact.id, event.target.value as PipelineStage))
                }
                className={INPUT}
              >
                {PIPELINE_STAGES.map((stage) => (
                  <option key={stage} value={stage}>
                    {COLUMN_LABEL[stage]}
                  </option>
                ))}
              </select>
            )}
          </div>

          <div className="flex items-center gap-2">
            <span className="w-[92px] shrink-0 text-[var(--color-ink-3)]">Owner</span>
            {!contact.claimed_by ? (
              <button
                type="button"
                disabled={pending}
                onClick={() => run(() => claimLead(contact.id))}
                className={BUTTON}
              >
                Claim
              </button>
            ) : mine ? (
              <>
                <span className="text-[var(--color-ink)]">you</span>
                <button
                  type="button"
                  disabled={pending}
                  onClick={() => run(() => releaseLead(contact.id))}
                  className={BUTTON_QUIET}
                >
                  release
                </button>
              </>
            ) : (
              <span className="text-[var(--color-ink-2)]">somebody else</span>
            )}
          </div>
        </section>

        <section className="space-y-2 border-t border-[var(--color-line)] pt-3">
          <p className="text-[var(--color-ink-3)]">Next action</p>
          <input
            value={action}
            disabled={pending || !editable}
            onChange={(event) => setAction(event.target.value)}
            placeholder="Call back about the demo"
            className={INPUT + " w-full disabled:opacity-40"}
          />
          <div className="flex flex-wrap items-center gap-2">
            <input
              type="datetime-local"
              value={actionAt}
              disabled={pending || !editable}
              onChange={(event) => setActionAt(event.target.value)}
              className={INPUT + " disabled:opacity-40"}
            />
            <button
              type="button"
              disabled={pending || !editable}
              onClick={() =>
                run(() =>
                  setNextAction(
                    contact.id,
                    action,
                    actionAt ? new Date(actionAt).toISOString() : null,
                  ),
                )
              }
              className={BUTTON}
            >
              Save
            </button>
            <button
              type="button"
              disabled={pending || !editable}
              onClick={() => {
                setAction("");
                setActionAt("");
                run(() => setNextAction(contact.id, "", null));
              }}
              className={BUTTON_QUIET}
            >
              clear
            </button>
          </div>
          {!editable && (
            <p className="text-[var(--color-ink-3)]">
              Somebody else owns this lead, so their follow-up is theirs to set.
            </p>
          )}
        </section>

        <section className="space-y-2 border-t border-[var(--color-line)] pt-3">
          <p className="text-[var(--color-ink-3)]">Notes</p>
          <div className="flex gap-2">
            <input
              value={note}
              disabled={pending}
              onChange={(event) => setNote(event.target.value)}
              placeholder="What was said"
              className={INPUT + " min-w-0 flex-1"}
            />
            <button
              type="button"
              disabled={pending || note.trim() === ""}
              onClick={() => {
                const body = note;
                setNote("");
                run(() => addNote(contact.id, body));
              }}
              className={BUTTON}
            >
              Add
            </button>
          </div>

          {notes.length === 0 ? (
            <p className="text-[var(--color-ink-3)]">Nothing written down yet.</p>
          ) : (
            <ul className="space-y-1">
              {notes.map((entry) => (
                <li key={entry.id} className="border-l border-[var(--color-line-2)] pl-2">
                  <p className="text-[var(--color-ink)]">
                    {String(entry.payload?.body ?? "")}
                  </p>
                  <p className="text-[var(--color-ink-3)]">
                    {DateTime.fromISO(entry.occurred_at).toRelative()}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </section>
  );
}
