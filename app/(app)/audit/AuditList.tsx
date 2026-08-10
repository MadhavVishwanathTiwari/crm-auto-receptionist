"use client";

import { useEffect, useState, useTransition } from "react";

import { BUTTON, INPUT, PANEL } from "../ui";
import { recordAudit, type AngleType } from "./actions";

export interface AuditLead {
  id: string;
  company_name: string | null;
  first_name: string | null;
  last_name: string | null;
  work_email: string | null;
  phone: string | null;
  website: string | null;
  city: string | null;
  state: string | null;
  timezone: string;
  rating: number | null;
  reviews_count: number | null;
}

const ANGLES: Array<{ value: AngleType; label: string; hint: string }> = [
  {
    value: "soft_text_audit",
    label: "Soft text audit",
    hint: "Texted the business line and timed the reply.",
  },
  {
    value: "voicemail_drop_audit",
    label: "Voicemail drop audit",
    hint: "Called and left a voicemail, then timed the callback.",
  },
];

// The outcomes that actually recur. Free text stays available underneath,
// because the interesting ones are always the unplanned ones.
const OUTCOME_PRESETS = [
  "no response",
  "voicemail",
  "auto-reply: closed",
  "auto-reply: generic",
  "answered by a human",
  "line disconnected",
];

/**
 * The prospect's wall clock, ticking.
 *
 * Rendered client-side and only after mount: the server and the browser are in
 * different zones, so formatting this during SSR guarantees a hydration
 * mismatch on every row.
 */
function ProspectClock({ timezone }: { timezone: string }) {
  const [now, setNow] = useState<string | null>(null);

  useEffect(() => {
    const tick = () =>
      setNow(
        new Intl.DateTimeFormat(undefined, {
          timeZone: timezone,
          hour: "2-digit",
          minute: "2-digit",
          weekday: "short",
        }).format(new Date()),
      );
    tick();
    const id = setInterval(tick, 30_000);
    return () => clearInterval(id);
  }, [timezone]);

  if (!now) return <span className="text-[var(--color-ink-3)]">—</span>;
  return (
    <span className="tabular text-[var(--color-ink)]" title={timezone}>
      {now} <span className="text-[var(--color-ink-3)]">local</span>
    </span>
  );
}

function AuditRow({ lead }: { lead: AuditLead }) {
  const [angle, setAngle] = useState<AngleType>("soft_text_audit");
  const [responded, setResponded] = useState(false);
  const [delayMinutes, setDelayMinutes] = useState("");
  const [outcome, setOutcome] = useState("no response");
  const [notes, setNotes] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function submit() {
    setError(null);
    startTransition(async () => {
      const result = await recordAudit({
        leadId: lead.id,
        angleType: angle,
        responseDelaySeconds: responded
          ? Math.round(Number(delayMinutes) * 60)
          : null,
        outcome,
        notes,
      });
      if (!result.ok) setError(result.error ?? "That did not save.");
    });
  }

  const name = [lead.first_name, lead.last_name].filter(Boolean).join(" ");
  const delayInvalid =
    responded && (delayMinutes.trim() === "" || Number(delayMinutes) < 0);

  return (
    <div className={PANEL}>
      <div className="mb-3 flex items-baseline gap-3">
        <span className="text-[var(--color-ink)]">
          {lead.company_name ?? "Unnamed company"}
        </span>
        {name && <span className="text-[var(--color-ink-2)]">{name}</span>}
        <span className="text-[var(--color-ink-3)]">
          {[lead.city, lead.state].filter(Boolean).join(", ")}
        </span>
        <span className="ml-auto">
          <ProspectClock timezone={lead.timezone} />
        </span>
      </div>

      <div className="mb-3 flex flex-wrap gap-x-6 gap-y-1 text-[var(--color-ink-2)]">
        <span>
          <span className="text-[var(--color-ink-3)]">phone </span>
          {lead.phone ?? "—"}
        </span>
        <span>
          <span className="text-[var(--color-ink-3)]">site </span>
          {lead.website ?? "—"}
        </span>
        <span>
          <span className="text-[var(--color-ink-3)]">rating </span>
          {lead.rating ?? "—"}
          {lead.reviews_count !== null && ` (${lead.reviews_count})`}
        </span>
      </div>

      <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1">
          <span className="text-[var(--color-ink-3)]">Angle</span>
          <select
            value={angle}
            onChange={(e) => setAngle(e.target.value as AngleType)}
            className={INPUT}
          >
            {ANGLES.map((a) => (
              <option key={a.value} value={a.value} title={a.hint}>
                {a.label}
              </option>
            ))}
          </select>
        </label>

        <label className="flex flex-col gap-1">
          <span className="text-[var(--color-ink-3)]">Outcome</span>
          <input
            list={`outcomes-${lead.id}`}
            value={outcome}
            onChange={(e) => setOutcome(e.target.value)}
            className={INPUT + " w-56"}
          />
          <datalist id={`outcomes-${lead.id}`}>
            {OUTCOME_PRESETS.map((preset) => (
              <option key={preset} value={preset} />
            ))}
          </datalist>
        </label>

        <label className="flex items-center gap-2 pb-1">
          <input
            type="checkbox"
            checked={responded}
            onChange={(e) => setResponded(e.target.checked)}
          />
          <span className="text-[var(--color-ink-2)]">They responded</span>
        </label>

        {responded && (
          <label className="flex flex-col gap-1">
            <span className="text-[var(--color-ink-3)]">After (minutes)</span>
            <input
              type="number"
              min={0}
              step="1"
              value={delayMinutes}
              onChange={(e) => setDelayMinutes(e.target.value)}
              className={INPUT + " tabular w-28"}
            />
          </label>
        )}

        <label className="flex min-w-[200px] flex-1 flex-col gap-1">
          <span className="text-[var(--color-ink-3)]">Notes</span>
          <input
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="Anything the email should mention"
            className={INPUT}
          />
        </label>

        <button
          type="button"
          onClick={submit}
          disabled={pending || delayInvalid}
          className={BUTTON}
        >
          {pending ? "Saving..." : "Record audit"}
        </button>
      </div>

      {error && (
        <p role="alert" className="mt-2 text-[var(--color-danger)]">
          {error}
        </p>
      )}
    </div>
  );
}

export function AuditList({ leads }: { leads: AuditLead[] }) {
  if (leads.length === 0) {
    return (
      <p className="px-4 py-6 text-[var(--color-ink-3)]">
        Nothing to audit. A lead shows up here once you have claimed it, it is
        qualified, and it has a timezone.
      </p>
    );
  }

  return (
    <div className="space-y-4 p-4">
      {leads.map((lead) => (
        <AuditRow key={lead.id} lead={lead} />
      ))}
    </div>
  );
}
