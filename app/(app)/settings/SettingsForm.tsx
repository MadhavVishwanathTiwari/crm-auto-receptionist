"use client";

import { useState, useTransition } from "react";

import { BUTTON, INPUT, PANEL } from "../ui";
import { type OrgSettingsInput, updateOrgSettings } from "./actions";

export interface OrgSettingsRow {
  dry_run: boolean;
  operator_timezone: string;
  morning_start_hour: number;
  morning_end_hour: number;
  afternoon_start_hour: number;
  afternoon_end_hour: number;
  first_touch_weekdays: number[];
  followup_weekdays: number[];
  max_lookahead_days: number;
  slot_grace_minutes: number;
  stall_minutes: number;
}

const WEEKDAYS: { value: number; label: string }[] = [
  { value: 1, label: "Mon" },
  { value: 2, label: "Tue" },
  { value: 3, label: "Wed" },
  { value: 4, label: "Thu" },
  { value: 5, label: "Fri" },
];

function toInput(row: OrgSettingsRow): OrgSettingsInput {
  return {
    dryRun: row.dry_run,
    operatorTimezone: row.operator_timezone,
    morningStartHour: row.morning_start_hour,
    morningEndHour: row.morning_end_hour,
    afternoonStartHour: row.afternoon_start_hour,
    afternoonEndHour: row.afternoon_end_hour,
    firstTouchWeekdays: [...row.first_touch_weekdays],
    followupWeekdays: [...row.followup_weekdays],
    maxLookaheadDays: row.max_lookahead_days,
    slotGraceMinutes: row.slot_grace_minutes,
    stallMinutes: row.stall_minutes,
  };
}

function Hour({
  label,
  value,
  onChange,
}: {
  label: string;
  value: number;
  onChange: (next: number) => void;
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[var(--color-ink-3)]">{label}</span>
      <select
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className={INPUT + " tabular w-20"}
      >
        {Array.from({ length: 24 }, (_, hour) => (
          <option key={hour} value={hour}>
            {String(hour).padStart(2, "0")}:00
          </option>
        ))}
      </select>
    </label>
  );
}

function Number_({
  label,
  hint,
  value,
  onChange,
}: {
  label: string;
  hint: string;
  value: number;
  onChange: (next: number) => void;
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[var(--color-ink-3)]">{label}</span>
      <input
        value={String(value)}
        onChange={(e) => onChange(Number(e.target.value.replace(/[^0-9]/g, "") || 0))}
        inputMode="numeric"
        className={INPUT + " tabular w-24"}
      />
      <span className="text-[var(--color-ink-3)]">{hint}</span>
    </label>
  );
}

function Weekdays({
  label,
  hint,
  selected,
  onChange,
}: {
  label: string;
  hint: string;
  selected: number[];
  onChange: (next: number[]) => void;
}) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-[var(--color-ink-3)]">{label}</span>
      <div className="flex gap-1">
        {WEEKDAYS.map((day) => {
          const on = selected.includes(day.value);
          return (
            <button
              key={day.value}
              type="button"
              aria-pressed={on}
              onClick={() =>
                onChange(
                  on
                    ? selected.filter((d) => d !== day.value)
                    : [...selected, day.value].sort(),
                )
              }
              className={
                "border px-2 py-0.5 " +
                (on
                  ? "border-[var(--color-line-strong)] bg-[var(--color-surface-3)] text-[var(--color-ink)]"
                  : "border-[var(--color-line)] text-[var(--color-ink-3)]")
              }
            >
              {day.label}
            </button>
          );
        })}
      </div>
      <span className="text-[var(--color-ink-3)]">{hint}</span>
    </div>
  );
}

export function SettingsForm({
  settings,
  canEdit,
}: {
  settings: OrgSettingsRow;
  canEdit: boolean;
}) {
  const [form, setForm] = useState<OrgSettingsInput>(toInput(settings));
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [pending, startTransition] = useTransition();

  const dirty = JSON.stringify(form) !== JSON.stringify(toInput(settings));

  function set<K extends keyof OrgSettingsInput>(key: K, value: OrgSettingsInput[K]) {
    setSaved(false);
    setForm((current) => ({ ...current, [key]: value }));
  }

  function save() {
    setError(null);
    setSaved(false);
    startTransition(async () => {
      const result = await updateOrgSettings(form);
      if (result.ok) setSaved(true);
      else setError(result.error ?? "That did not save.");
    });
  }

  const hours =
    form.morningEndHour -
    form.morningStartHour +
    (form.afternoonEndHour - form.afternoonStartHour);

  return (
    <div className="space-y-4">
      <div className={PANEL}>
        <div className="flex flex-wrap items-baseline gap-3">
          <h2 className="text-[var(--color-ink)]">Sending</h2>
          <span
            className={
              form.dryRun
                ? "text-[var(--color-warn)]"
                : "text-[var(--color-ok)]"
            }
          >
            {form.dryRun ? "dry run: nothing can send" : "live: mail goes out"}
          </span>
        </div>

        <p className="mt-2 text-[var(--color-ink-2)]">
          Dry run is enforced inside <code>claim_due_sends()</code>, not in the
          dispatcher, so while it is on the app is physically incapable of
          sending even if a job runs by accident. Turning it off is the moment
          this becomes a live outbound system.
        </p>

        <label className="mt-3 flex items-center gap-2">
          <input
            type="checkbox"
            checked={!form.dryRun}
            disabled={!canEdit}
            onChange={(e) => set("dryRun", !e.target.checked)}
          />
          <span className="text-[var(--color-ink)]">
            Send real email from the connected mailboxes
          </span>
        </label>
      </div>

      <div className={PANEL}>
        <h2 className="text-[var(--color-ink)]">Send window, prospect-local</h2>
        <p className="mt-1 mb-3 text-[var(--color-ink-3)]">
          Every slot lands inside these hours in the PROSPECT&rsquo;s zone. Ends
          are exclusive, so 07:00 to 11:00 means the last start is 10:59. That
          is {hours} hours a day of window.
        </p>

        <div className="flex flex-wrap items-end gap-3">
          <Hour
            label="Morning from"
            value={form.morningStartHour}
            onChange={(v) => set("morningStartHour", v)}
          />
          <Hour
            label="to"
            value={form.morningEndHour}
            onChange={(v) => set("morningEndHour", v)}
          />
          <span className="pb-1 text-[var(--color-ink-3)]">and</span>
          <Hour
            label="Afternoon from"
            value={form.afternoonStartHour}
            onChange={(v) => set("afternoonStartHour", v)}
          />
          <Hour
            label="to"
            value={form.afternoonEndHour}
            onChange={(v) => set("afternoonEndHour", v)}
          />
        </div>

        <div className="mt-4 flex flex-wrap gap-8">
          <Weekdays
            label="First touch on"
            hint="T1 only. Narrower than follow-ups because it is the one a stranger judges."
            selected={form.firstTouchWeekdays}
            onChange={(v) => set("firstTouchWeekdays", v)}
          />
          <Weekdays
            label="Follow-ups on"
            hint="T2 to T4, which are already a thread rather than a cold arrival."
            selected={form.followupWeekdays}
            onChange={(v) => set("followupWeekdays", v)}
          />
        </div>
      </div>

      <div className={PANEL}>
        <h2 className="text-[var(--color-ink)]">Your clock, and the timers</h2>
        <p className="mt-1 mb-3 text-[var(--color-ink-3)]">
          The operator zone is what the queue shows &ldquo;your time&rdquo; in.
          Mailbox caps reset in each mailbox&rsquo;s own zone, set on the
          Mailboxes page, because a daily cap is a limit on the sending account
          rather than on the prospect&rsquo;s day.
        </p>

        <div className="flex flex-wrap items-start gap-6">
          <label className="flex flex-col gap-1">
            <span className="text-[var(--color-ink-3)]">Operator timezone</span>
            <input
              value={form.operatorTimezone}
              onChange={(e) => set("operatorTimezone", e.target.value)}
              placeholder="Asia/Kolkata"
              className={INPUT + " w-56"}
            />
            <span className="text-[var(--color-ink-3)]">
              An IANA name, not an offset.
            </span>
          </label>

          <Number_
            label="Lookahead"
            hint="Days the planner searches before it gives up and blocks a send."
            value={form.maxLookaheadDays}
            onChange={(v) => set("maxLookaheadDays", v)}
          />
          <Number_
            label="Slot grace"
            hint="Minutes late a send may still go. Older ones roll forward instead."
            value={form.slotGraceMinutes}
            onChange={(v) => set("slotGraceMinutes", v)}
          />
          <Number_
            label="Stall timeout"
            hint="Minutes in 'sending' before a killed dispatcher's row is failed."
            value={form.stallMinutes}
            onChange={(v) => set("stallMinutes", v)}
          />
        </div>
      </div>

      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={save}
          disabled={pending || !dirty || !canEdit}
          className={BUTTON}
        >
          Save settings
        </button>
        {!canEdit && (
          <span className="text-[var(--color-ink-3)]">
            Read-only: changing the send policy is an admin action.
          </span>
        )}
        {saved && !error && <span className="text-[var(--color-ok)]">Saved.</span>}
        {error && (
          <span role="alert" className="text-[var(--color-danger)]">
            {error}
          </span>
        )}
      </div>
    </div>
  );
}
