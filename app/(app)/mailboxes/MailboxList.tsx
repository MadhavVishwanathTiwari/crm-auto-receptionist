"use client";

import { useState, useTransition } from "react";

import { BUTTON, BUTTON_QUIET, INPUT, PANEL } from "../ui";
import { setMailboxPaused, updateMailboxSettings } from "./actions";

export interface MailboxRow {
  id: string;
  email: string;
  display_name: string | null;
  timezone: string;
  daily_cap: number;
  paused_at: string | null;
  disconnected_at: string | null;
  last_send_at: string | null;
  last_polled_at: string | null;
  /** Sends already counted against today, in THIS mailbox's timezone. */
  used_today: number;
  is_mine: boolean;
}

function MailboxCard({ row }: { row: MailboxRow }) {
  const [displayName, setDisplayName] = useState(row.display_name ?? "");
  const [dailyCap, setDailyCap] = useState(String(row.daily_cap));
  const [timezone, setTimezone] = useState(row.timezone);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [pending, startTransition] = useTransition();

  const dirty =
    displayName !== (row.display_name ?? "") ||
    dailyCap !== String(row.daily_cap) ||
    timezone !== row.timezone;

  function save() {
    setError(null);
    setSaved(false);
    startTransition(async () => {
      const result = await updateMailboxSettings({
        id: row.id,
        displayName,
        dailyCap: Number(dailyCap),
        timezone,
      });
      if (result.ok) setSaved(true);
      else setError(result.error ?? "That did not save.");
    });
  }

  function togglePause() {
    setError(null);
    startTransition(async () => {
      const result = await setMailboxPaused(row.id, row.paused_at === null);
      if (!result.ok) setError(result.error ?? "That did not work.");
    });
  }

  const state = row.disconnected_at
    ? { label: "needs reconnecting", tone: "text-[var(--color-danger)]" }
    : row.paused_at
      ? { label: "paused", tone: "text-[var(--color-warn)]" }
      : { label: "sending", tone: "text-[var(--color-ok)]" };

  return (
    <div className={PANEL}>
      <div className="flex flex-wrap items-baseline gap-3">
        <h2 className="text-[var(--color-ink)]">{row.email}</h2>
        <span className={state.tone}>{state.label}</span>
        <span className="tabular text-[var(--color-ink-3)]">
          {row.used_today} of {row.daily_cap} used today
        </span>
        <div className="ml-auto flex gap-2">
          {!row.disconnected_at && (
            <button
              type="button"
              onClick={togglePause}
              disabled={pending || !row.is_mine}
              className={BUTTON_QUIET}
            >
              {row.paused_at ? "resume" : "pause"}
            </button>
          )}
          <a href="/api/auth/google/start" className={BUTTON_QUIET}>
            reconnect
          </a>
        </div>
      </div>

      {row.disconnected_at && (
        <p className="mt-2 text-[var(--color-danger)]">
          The Google grant stopped working, so nothing can go out from here.
          Reconnect it to carry on.
        </p>
      )}

      <div className="mt-3 flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1">
          <span className="text-[var(--color-ink-3)]">
            Display name, as the prospect sees it
          </span>
          <input
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            placeholder="Ojas"
            disabled={!row.is_mine}
            className={INPUT + " w-56"}
          />
        </label>

        <label className="flex flex-col gap-1">
          <span className="text-[var(--color-ink-3)]">Daily cap</span>
          <input
            value={dailyCap}
            onChange={(e) => setDailyCap(e.target.value.replace(/[^0-9]/g, ""))}
            inputMode="numeric"
            disabled={!row.is_mine}
            className={INPUT + " tabular w-24"}
          />
        </label>

        <label className="flex flex-col gap-1">
          <span className="text-[var(--color-ink-3)]">
            Mailbox timezone, where the cap resets
          </span>
          <input
            value={timezone}
            onChange={(e) => setTimezone(e.target.value)}
            placeholder="America/New_York"
            disabled={!row.is_mine}
            className={INPUT + " w-56"}
          />
        </label>

        <button
          type="button"
          onClick={save}
          disabled={pending || !dirty || !row.is_mine}
          className={BUTTON}
        >
          Save
        </button>
      </div>

      <p className="mt-2 text-[var(--color-ink-3)]">
        Last send{" "}
        {row.last_send_at ? new Date(row.last_send_at).toLocaleString() : "never"}
        {" · "}
        last polled{" "}
        {row.last_polled_at
          ? new Date(row.last_polled_at).toLocaleString()
          : "never"}
        {!row.is_mine && " · connected by the other operator, so it is read-only here"}
      </p>

      {saved && !error && (
        <p className="mt-2 text-[var(--color-ok)]">Saved.</p>
      )}
      {error && (
        <p role="alert" className="mt-2 text-[var(--color-danger)]">
          {error}
        </p>
      )}
    </div>
  );
}

export function MailboxList({
  rows,
  notice,
}: {
  rows: MailboxRow[];
  notice: { kind: "connected" | "error"; text: string } | null;
}) {
  return (
    <div className="space-y-4 p-4">
      {notice && (
        <p
          role={notice.kind === "error" ? "alert" : undefined}
          className={
            PANEL +
            (notice.kind === "error"
              ? " text-[var(--color-danger)]"
              : " text-[var(--color-ok)]")
          }
        >
          {notice.text}
        </p>
      )}

      <div className={PANEL}>
        <div className="flex items-baseline gap-3">
          <h2 className="text-[var(--color-ink)]">Connect a sending mailbox</h2>
          <a href="/api/auth/google/start" className={BUTTON + " ml-auto"}>
            Connect with Google
          </a>
        </div>
        <p className="mt-2 text-[var(--color-ink-2)]">
          This is a separate grant from signing in. It asks for permission to
          send and to read, and deliberately not to modify: the app is
          structurally incapable of archiving, labelling or marking anything
          read, which is what keeps the warmup mail in these mailboxes untouched.
        </p>
      </div>

      {rows.length === 0 ? (
        <p className="text-[var(--color-ink-3)]">
          No mailbox connected yet, so nothing can be planned or sent.
        </p>
      ) : (
        rows.map((row) => <MailboxCard key={row.id} row={row} />)
      )}
    </div>
  );
}
