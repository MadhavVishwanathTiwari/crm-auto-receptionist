"use client";

import { backfillLeadOwners } from "./actions";
import { RepairPanel, RepairRows } from "./RepairPanel";

const TONE: Record<string, string> = {
  assigned: "text-ok",
  already_owned: "text-ink-3",
  claimed_by_other: "text-warn",
  unknown_owner: "text-danger",
  not_found: "text-danger",
  no_owner: "text-ink-3",
};

const EXPLAIN: Record<string, string> = {
  assigned: "claimed for the operator named in the sheet",
  already_owned: "already theirs, left alone",
  claimed_by_other: "someone else holds it now — the sheet is not applied",
  unknown_owner: "that address matches no account in this org",
  not_found: "no such lead",
  no_owner: "the sheet named nobody",
};

/**
 * Re-applies `lead_owner` from the legacy sheet to leads that are already in
 * the database. A re-upload cannot do it: every row is a duplicate by
 * work_email by now, and a skipped row has no new lead to claim.
 */
export function OwnershipBackfill() {
  return (
    <RepairPanel
      title="Ownership from the legacy sheet"
      description={
        <>
          Reads <code>lead_owner</code> back out of each lead&apos;s stored
          import row and claims it for that operator. Only touches leads nobody
          holds, so it never takes a lead away from whoever has it now, and
          running it twice does nothing the second time.
        </>
      }
      tone={TONE}
      explain={EXPLAIN}
      run={backfillLeadOwners}
      emptyMessage="Nothing in the stored import rows names an owner. Nothing to do."
      applyLabel={(result) => {
        const n = result.counts.assigned ?? 0;
        return n > 0 ? `Assign ${n} ${n === 1 ? "lead" : "leads"}` : null;
      }}
      detail={(result) =>
        result.problems.length > 0 && (
          <RepairRows label={`Needs a person (${result.problems.length} shown):`}>
            {result.problems.map((row) => (
              <li key={row.lead_id}>
                <span className="text-ink-2">{row.company ?? row.lead_id}</span>{" "}
                — {row.owner_email} — {row.outcome.replace(/_/g, " ")}
              </li>
            ))}
          </RepairRows>
        )
      }
    />
  );
}
