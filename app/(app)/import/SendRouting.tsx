"use client";

import { rerouteSendsToOwner } from "./actions";
import { RepairPanel, RepairRows } from "./RepairPanel";

const TONE: Record<string, string> = {
  "would move": "text-ok",
  moved: "text-ok",
  "already correct": "text-ink-3",
  "pinned to its thread, left alone": "text-ink-3",
  "lead is unclaimed, left alone": "text-warn",
  "owner has no sendable mailbox, left alone": "text-danger",
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
 */
export function SendRouting() {
  return (
    <RepairPanel
      title="Sends queued on the wrong mailbox"
      description="Until now a send went out from whichever mailbox had the most room that day, not from the person who owns the lead. This moves anything still waiting onto its owner's account. It never touches a send that has already left, and it leaves a lead whose thread started somewhere else exactly where it is, because a Gmail thread only exists inside the account that started it."
      tone={TONE}
      explain={EXPLAIN}
      run={rerouteSendsToOwner}
      emptyMessage="Every queued send is already on its owner's mailbox. Nothing to do."
      applyLabel={(result) => {
        const n = result.counts["would move"] ?? 0;
        return n > 0 ? `Move ${n} ${n === 1 ? "send" : "sends"}` : null;
      }}
      detail={(result) =>
        result.notable.length > 0 && (
          <RepairRows
            label={`Worth reading before you run it (${result.notable.length} shown):`}
          >
            {result.notable.map((row) => (
              <li key={row.send_id}>
                <span className="text-ink-2">{row.company ?? row.lead_id}</span>{" "}
                T{row.step_number} — {row.from_mailbox ?? "no mailbox"}
                {row.to_mailbox && row.to_mailbox !== row.from_mailbox
                  ? ` → ${row.to_mailbox}`
                  : ""}{" "}
                — {row.outcome}
              </li>
            ))}
          </RepairRows>
        )
      }
    />
  );
}
