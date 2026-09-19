"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { formatYours } from "@/lib/time/format";

import { BUTTON, PANEL } from "../ui";
import { useViewerZone } from "../ViewerZone";
import { repairStalledSends, type StalledRepairResult } from "./actions";

const TONE: Record<string, string> = {
  recorded: "text-ok",
  "already recorded, repeats marked": "text-ink-2",
  "in flight, run again later": "text-warn",
  error: "text-danger",
};

const EXPLAIN: Record<string, string> = {
  recorded: "the latest attempt becomes the sent touch, the others are marked as repeats",
  "already recorded, repeats marked": "this step was recorded properly, so the stalled ones are only repeats",
  "in flight, run again later": "something for this step is being sent right now",
  error: "see the row below",
};

/**
 * Records the emails that went out and were never written down.
 *
 * Until 0040 every send the dispatcher made was left `stalled`: Gmail accepted
 * it, recording it failed, and the planner booked the same touch again. Nothing
 * more goes to those leads until each one is settled, and this settles them all
 * at once. Its own panel, like the other repairs here, because it reads no file
 * and imports no leads.
 */
export function StalledRepair() {
  const router = useRouter();
  const { zone } = useViewerZone();
  const [result, setResult] = useState<StalledRepairResult | null>(null);
  const [busy, setBusy] = useState(false);

  async function run(dryRun: boolean) {
    setBusy(true);
    try {
      const next = await repairStalledSends(dryRun);
      setResult(next);
      if (!dryRun && next.ok) router.refresh();
    } finally {
      setBusy(false);
    }
  }

  const recordable = result?.counts.recorded ?? 0;
  const repeatsOnly = result?.counts["already recorded, repeats marked"] ?? 0;
  const actionable = recordable + repeatsOnly;

  return (
    <div className={PANEL}>
      <h2 className="mb-2 text-xl font-semibold text-ink">Emails that went out unrecorded</h2>
      <p className="mb-3 max-w-[70ch] text-ink-3">
        Finds sends that reached Gmail but were never marked sent, so the planner
        booked the same touch again. Each lead&apos;s touch is recorded once, dated
        from its latest attempt, and the rest are marked as the repeats they
        were. Any touch re-booked for that step is cancelled, and a hand-written
        one keeps its words.
      </p>

      <div className="flex items-center gap-3">
        <button type="button" onClick={() => run(true)} disabled={busy} className={BUTTON}>
          {busy ? "Working..." : "Preview"}
        </button>
        {result?.ok && result.dryRun && actionable > 0 && (
          <button type="button" onClick={() => run(false)} disabled={busy} className={BUTTON}>
            Record {actionable} {actionable === 1 ? "touch" : "touches"}
          </button>
        )}
      </div>

      {result && !result.ok && (
        <p role="alert" className="mt-3 text-danger">
          {result.error}
        </p>
      )}

      {result?.ok && (
        <div className="mt-3">
          {Object.keys(result.counts).length === 0 ? (
            <p className="text-ink-3">
              Every email that reached Gmail is recorded. Nothing to do.
            </p>
          ) : (
            <>
              <p className="mb-2 text-ink-2">
                {result.dryRun ? "Would apply:" : "Applied:"}
              </p>
              <ul className="tabular space-y-1">
                {Object.entries(result.counts)
                  .sort((a, b) => b[1] - a[1])
                  .map(([outcome, count]) => (
                    <li key={outcome} className={TONE[outcome] ?? ""}>
                      {count} {outcome}
                      <span className="text-ink-3">
                        {" "}
                        — {EXPLAIN[outcome] ?? ""}
                      </span>
                    </li>
                  ))}
              </ul>
            </>
          )}

          {result.notable.length > 0 && (
            <div className="mt-3 border-t border-line pt-3">
              <p className="mb-2 text-ink-2">
                By lead ({result.notable.length} shown, most repeats first):
              </p>
              <ul className="tabular space-y-1 text-ink-3">
                {result.notable.map((row) => (
                  <li key={`${row.lead_id}:${row.step_number}`}>
                    <span className="text-ink-2">
                      {row.company ?? row.lead_id}
                    </span>{" "}
                    — T{row.step_number} went out {row.attempts}{" "}
                    {row.attempts === 1 ? "time" : "times"}
                    {row.recorded_at ? `, last ${formatYours(row.recorded_at, zone)}` : ""}
                    {row.cancelled_planned > 0
                      ? `; cancels ${row.cancelled_planned} re-booked${
                          row.cancelled_written > 0
                            ? ` (${row.cancelled_written} hand-written)`
                            : ""
                        }`
                      : ""}
                    {row.outcome.startsWith("error:") ? (
                      <span className="text-danger"> — {row.outcome}</span>
                    ) : null}
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
