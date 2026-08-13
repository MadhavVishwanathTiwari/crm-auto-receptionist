"use client";

import { DateTime } from "luxon";
import { useState, useTransition } from "react";

import { BUTTON_QUIET } from "../ui";
import { cancelSend } from "../write/actions";

export interface QueuedSend {
  id: string;
  step_number: number;
  status: string;
  scheduled_at: string;
  /** Prospect-local wall clock, frozen at plan time. No offset. */
  scheduled_local: string;
  prospect_timezone: string;
  outcome_reason: string | null;
  /** Set when a person wrote this one. The subject is theirs, verbatim. */
  composed_subject: string | null;
  company: string | null;
}

/**
 * Everything booked and not yet gone, with the one control a human has over it.
 *
 * Cancelling is deliberately the only write here. A row that says `sent` has an
 * email behind it in somebody's inbox, and an editable queue would let the
 * timeline disagree with reality. Fixing the WORDS of a written email happens
 * on the composer, which keeps the slot; this only removes the send.
 */
export function QueuedSends({ sends }: { sends: QueuedSend[] }) {
  const [rows, setRows] = useState(sends);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function cancel(id: string, company: string | null) {
    setError(null);
    if (
      !window.confirm(
        `Cancel the email queued for ${company ?? "this lead"}? The planner may book a template send in its place.`,
      )
    ) {
      return;
    }

    startTransition(async () => {
      const result = await cancelSend(id);
      if (!result.ok) {
        setError(result.error ?? "That send could not be cancelled.");
        return;
      }
      setRows((current) => current.filter((row) => row.id !== id));
    });
  }

  return (
    <>
      {error && (
        <p role="alert" className="mb-2 text-[var(--color-danger)]">
          {error}
        </p>
      )}

      <table className="w-full border-collapse">
        <thead>
          <tr className="text-left text-[var(--color-ink-3)]">
            <th className="py-1 font-normal">Company</th>
            <th className="py-1 font-normal">Step</th>
            <th className="py-1 font-normal">Copy</th>
            <th className="py-1 font-normal">Your time</th>
            <th className="py-1 font-normal">Their time</th>
            <th className="py-1 font-normal">State</th>
            <th className="py-1 font-normal"></th>
          </tr>
        </thead>
        <tbody>
          {rows.map((send) => {
            const at = DateTime.fromISO(send.scheduled_at);
            const local = DateTime.fromISO(send.scheduled_local);
            const written = send.composed_subject !== null;

            return (
              <tr key={send.id} className="border-t border-[var(--color-line)]">
                <td className="max-w-[240px] truncate py-1">
                  {send.company ?? "—"}
                </td>
                <td className="tabular py-1">T{send.step_number}</td>
                <td className="max-w-[280px] truncate py-1">
                  {written ? (
                    <span className="text-[var(--color-ink-2)]">
                      <span className="text-[var(--color-info)]">written</span>{" "}
                      {send.composed_subject}
                    </span>
                  ) : (
                    <span className="text-[var(--color-ink-3)]">from a template</span>
                  )}
                </td>
                <td className="tabular py-1 text-[var(--color-ink-2)]">
                  {send.status === "blocked" ? "—" : at.toFormat("ccc d LLL, HH:mm")}
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
                    <span className="text-[var(--color-ink-3)]">planned</span>
                  )}
                </td>
                <td className="py-1 text-right">
                  <button
                    type="button"
                    className={BUTTON_QUIET}
                    disabled={pending}
                    onClick={() => cancel(send.id, send.company)}
                  >
                    cancel
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>

      {rows.length === 0 && (
        <p className="text-[var(--color-ink-3)]">Nothing booked.</p>
      )}
    </>
  );
}
