"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { BUTTON, PANEL } from "../ui";
import { rerouteSendsToOwner, type RerouteResult } from "./actions";

const TONE: Record<string, string> = {
  "would move": "text-[var(--color-ok)]",
  moved: "text-[var(--color-ok)]",
  "already correct": "text-[var(--color-ink-3)]",
  "pinned to its thread, left alone": "text-[var(--color-ink-3)]",
  "lead is unclaimed, left alone": "text-[var(--color-warn)]",
  "owner has no sendable mailbox, left alone": "text-[var(--color-danger)]",
};

const EXPLAIN: Record<string, string> = {
  "would move": "queued on the wrong person's mailbox",
  moved: "now leaves from its owner's account",
  "already correct": "already the owner's mailbox",
  "pinned to its thread, left alone":
    "an earlier touch went out from there, and Gmail threads only exist inside one account",
  "lead is unclaimed, left alone": "nobody owns it, so there is no account to use",
  "owner has no sendable mailbox, left alone":
    "that operator has not connected one, or it is paused",
};

/**
 * Re-points sends that were booked before mailbox routing knew who owned a lead.
 *
 * Its own panel, next to the ownership backfill, for the same reason that one
 * has one: it is a repair rather than a feature, it is read before it is run,
 * and it stops being interesting once it reports nothing to do.
 */
export function SendRouting() {
  const router = useRouter();
  const [result, setResult] = useState<RerouteResult | null>(null);
  const [busy, setBusy] = useState(false);

  async function run(dryRun: boolean) {
    setBusy(true);
    try {
      const next = await rerouteSendsToOwner(dryRun);
      setResult(next);
      if (!dryRun && next.ok) router.refresh();
    } finally {
      setBusy(false);
    }
  }

  const movable = result?.counts["would move"] ?? 0;

  return (
    <div className={PANEL}>
      <h2 className="mb-2 text-[var(--color-ink)]">Sends queued on the wrong mailbox</h2>
      <p className="mb-3 max-w-[70ch] text-[var(--color-ink-3)]">
        Until now a send went out from whichever mailbox had the most room that
        day, not from the person who owns the lead. This moves anything still
        waiting onto its owner&apos;s account. It never touches a send that has
        already left, and it leaves a lead whose thread started somewhere else
        exactly where it is, because a Gmail thread only exists inside the
        account that started it.
      </p>

      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={() => run(true)}
          disabled={busy}
          className={BUTTON}
        >
          {busy ? "Working..." : "Preview"}
        </button>
        {result?.ok && result.dryRun && movable > 0 && (
          <button
            type="button"
            onClick={() => run(false)}
            disabled={busy}
            className={BUTTON}
          >
            Move {movable} {movable === 1 ? "send" : "sends"}
          </button>
        )}
      </div>

      {result && !result.ok && (
        <p role="alert" className="mt-3 text-[var(--color-danger)]">
          {result.error}
        </p>
      )}

      {result?.ok && (
        <div className="mt-3">
          {Object.keys(result.counts).length === 0 ? (
            <p className="text-[var(--color-ink-3)]">
              Nothing is queued right now. Nothing to do.
            </p>
          ) : (
            <>
              <p className="mb-2 text-[var(--color-ink-2)]">
                {result.dryRun ? "Would apply:" : "Applied:"}
              </p>
              <ul className="tabular space-y-1">
                {Object.entries(result.counts)
                  .sort((a, b) => b[1] - a[1])
                  .map(([outcome, count]) => (
                    <li key={outcome} className={TONE[outcome] ?? ""}>
                      {count} {outcome}
                      <span className="text-[var(--color-ink-3)]">
                        {EXPLAIN[outcome] ? ` — ${EXPLAIN[outcome]}` : ""}
                      </span>
                    </li>
                  ))}
              </ul>
            </>
          )}

          {result.notable.length > 0 && (
            <div className="mt-3 border-t border-[var(--color-line)] pt-3">
              <p className="mb-2 text-[var(--color-ink-2)]">
                Worth reading before you run it ({result.notable.length} shown):
              </p>
              <ul className="space-y-1 text-[var(--color-ink-3)]">
                {result.notable.map((row) => (
                  <li key={row.send_id}>
                    <span className="text-[var(--color-ink-2)]">
                      {row.company ?? row.lead_id}
                    </span>{" "}
                    T{row.step_number} — {row.from_mailbox ?? "no mailbox"}
                    {row.to_mailbox && row.to_mailbox !== row.from_mailbox
                      ? ` → ${row.to_mailbox}`
                      : ""}{" "}
                    — {row.outcome}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
