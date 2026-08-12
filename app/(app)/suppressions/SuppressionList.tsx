"use client";

import { useState, useTransition } from "react";

import { BUTTON, BUTTON_QUIET, INPUT, PANEL } from "../ui";
import { addSuppression, removeSuppression } from "./actions";
// The array and its type come from a plain module, never through the "use
// server" actions file — see reasons.ts.
import { SUPPRESSION_REASONS, type SuppressionReason } from "./reasons";

export interface SuppressionRow {
  id: string;
  email_norm: string | null;
  domain: string | null;
  phone_e164: string | null;
  reason: string;
  notes: string | null;
  created_at: string;
}

export function SuppressionList({
  rows,
  isAdmin,
}: {
  rows: SuppressionRow[];
  isAdmin: boolean;
}) {
  const [target, setTarget] = useState("");
  const [reason, setReason] = useState<SuppressionReason>("manual_dnc");
  const [notes, setNotes] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  /**
   * One field for all three shapes. Asking an operator to choose between
   * "email", "domain" and "phone" before typing is a question the input itself
   * answers: an @ makes it an address, a leading digit or + makes it a phone.
   */
  function classify(value: string): { email?: string; domain?: string; phone?: string } {
    const trimmed = value.trim();
    if (trimmed.includes("@")) return { email: trimmed };
    if (/^[+0-9][0-9\s()\-.]*$/.test(trimmed)) return { phone: trimmed };
    return { domain: trimmed };
  }

  function submit() {
    setError(null);
    startTransition(async () => {
      const result = await addSuppression({ ...classify(target), reason, notes });
      if (result.ok) {
        setTarget("");
        setNotes("");
      } else {
        setError(result.error ?? "That did not save.");
      }
    });
  }

  function remove(id: string) {
    setError(null);
    startTransition(async () => {
      const result = await removeSuppression(id);
      if (!result.ok) setError(result.error ?? "That did not work.");
    });
  }

  return (
    <div className="space-y-4 p-4">
      <div className={PANEL}>
        <h2 className="mb-3 text-[var(--color-ink)]">Add to the list</h2>
        <div className="flex flex-wrap items-end gap-3">
          <label className="flex flex-col gap-1">
            <span className="text-[var(--color-ink-3)]">
              Email, domain or phone
            </span>
            <input
              value={target}
              onChange={(e) => setTarget(e.target.value)}
              placeholder="acme.com"
              className={INPUT + " w-72"}
            />
          </label>

          <label className="flex flex-col gap-1">
            <span className="text-[var(--color-ink-3)]">Reason</span>
            <select
              value={reason}
              onChange={(e) => setReason(e.target.value as SuppressionReason)}
              className={INPUT}
            >
              {SUPPRESSION_REASONS.map((r) => (
                <option key={r.value} value={r.value}>
                  {r.label}
                </option>
              ))}
            </select>
          </label>

          <label className="flex min-w-[200px] flex-1 flex-col gap-1">
            <span className="text-[var(--color-ink-3)]">Notes</span>
            <input
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              className={INPUT}
            />
          </label>

          <button
            type="button"
            onClick={submit}
            disabled={pending || !target.trim()}
            className={BUTTON}
          >
            Suppress
          </button>
        </div>
        <p className="mt-2 text-[var(--color-ink-3)]">
          A domain covers every contact at that company. Suppressing is checked
          immediately before every send.
        </p>
        {error && (
          <p role="alert" className="mt-2 text-[var(--color-danger)]">
            {error}
          </p>
        )}
      </div>

      <div className={PANEL}>
        <h2 className="mb-3 text-[var(--color-ink)]">
          On the list{" "}
          <span className="tabular text-[var(--color-ink-3)]">{rows.length}</span>
        </h2>

        {rows.length === 0 ? (
          <p className="text-[var(--color-ink-3)]">Nobody suppressed yet.</p>
        ) : (
          <table className="w-full border-collapse">
            <thead>
              <tr className="text-left text-[var(--color-ink-3)]">
                <th className="py-1 font-normal">Target</th>
                <th className="py-1 font-normal">Kind</th>
                <th className="py-1 font-normal">Reason</th>
                <th className="py-1 font-normal">Notes</th>
                <th className="py-1 font-normal">Added</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const target =
                  row.email_norm ?? row.domain ?? row.phone_e164 ?? "—";
                const kind = row.email_norm
                  ? "email"
                  : row.domain
                    ? "domain"
                    : "phone";
                return (
                  <tr key={row.id} className="border-t border-[var(--color-line)]">
                    <td className="py-1">{target}</td>
                    <td className="py-1 text-[var(--color-ink-3)]">{kind}</td>
                    <td className="py-1 text-[var(--color-ink-2)]">
                      {row.reason.replace(/_/g, " ")}
                    </td>
                    <td className="py-1 text-[var(--color-ink-2)]">
                      {row.notes ?? "—"}
                    </td>
                    <td className="py-1 text-[var(--color-ink-3)]">
                      {new Date(row.created_at).toLocaleDateString()}
                    </td>
                    <td className="py-1 text-right">
                      {isAdmin && (
                        <button
                          type="button"
                          disabled={pending}
                          onClick={() => remove(row.id)}
                          className={BUTTON_QUIET}
                        >
                          remove
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
