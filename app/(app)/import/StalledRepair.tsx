"use client";

import { formatYours } from "@/lib/time/format";

import { useViewerZone } from "../ViewerZone";
import { repairStalledSends } from "./actions";
import { RepairPanel, RepairRows } from "./RepairPanel";

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
  const { zone } = useViewerZone();

  return (
    <RepairPanel
      title="Emails that went out unrecorded"
      description="Finds sends that reached Gmail but were never marked sent, so the planner booked the same touch again. Each lead's touch is recorded once, dated from its latest attempt, and the rest are marked as the repeats they were. Any touch re-booked for that step is cancelled, and a hand-written one keeps its words."
      tone={TONE}
      explain={EXPLAIN}
      run={repairStalledSends}
      emptyMessage="Every email that reached Gmail is recorded. Nothing to do."
      applyLabel={(result) => {
        const total =
          (result.counts.recorded ?? 0) +
          (result.counts["already recorded, repeats marked"] ?? 0);
        return total > 0
          ? `Record ${total} ${total === 1 ? "touch" : "touches"}`
          : null;
      }}
      detail={(result) =>
        result.notable.length > 0 && (
          <RepairRows
            label={`By lead (${result.notable.length} shown, most repeats first):`}
          >
            {result.notable.map((row) => (
              <li key={`${row.lead_id}:${row.step_number}`}>
                <span className="text-ink-2">{row.company ?? row.lead_id}</span>{" "}
                — T{row.step_number} went out {row.attempts}{" "}
                {row.attempts === 1 ? "time" : "times"}
                {row.recorded_at
                  ? `, last ${formatYours(row.recorded_at, zone)}`
                  : ""}
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
          </RepairRows>
        )
      }
    />
  );
}
