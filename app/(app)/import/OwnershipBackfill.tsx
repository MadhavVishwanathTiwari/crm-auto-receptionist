"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { BUTTON, PANEL } from "../ui";
import { backfillLeadOwners, type BackfillResult } from "./actions";

const TONE: Record<string, string> = {
  assigned: "text-[var(--color-ok)]",
  already_owned: "text-[var(--color-ink-3)]",
  claimed_by_other: "text-[var(--color-warn)]",
  unknown_owner: "text-[var(--color-danger)]",
  not_found: "text-[var(--color-danger)]",
  no_owner: "text-[var(--color-ink-3)]",
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
 * the database.
 *
 * Its own panel rather than part of the upload flow, because it is not an
 * import: it writes no leads and reads no file. It exists because the first
 * upload of the sheet predated the importer understanding that column, and
 * re-uploading cannot fix it — every row is a duplicate by then, and a skipped
 * row has no new lead to claim.
 */
export function OwnershipBackfill() {
  const router = useRouter();
  const [result, setResult] = useState<BackfillResult | null>(null);
  const [busy, setBusy] = useState(false);

  async function run(dryRun: boolean) {
    setBusy(true);
    try {
      const next = await backfillLeadOwners(dryRun);
      setResult(next);
      if (!dryRun && next.ok) router.refresh();
    } finally {
      setBusy(false);
    }
  }

  const assignable = result?.counts.assigned ?? 0;

  return (
    <div className={PANEL}>
      <h2 className="mb-2 text-[var(--color-ink)]">Ownership from the legacy sheet</h2>
      <p className="mb-3 max-w-[70ch] text-[var(--color-ink-3)]">
        Reads <code>lead_owner</code> back out of each lead&apos;s stored import
        row and claims it for that operator. Only touches leads nobody holds, so
        it never takes a lead away from whoever has it now, and running it twice
        does nothing the second time.
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
        {result?.ok && result.dryRun && assignable > 0 && (
          <button
            type="button"
            onClick={() => run(false)}
            disabled={busy}
            className={BUTTON}
          >
            Assign {assignable} {assignable === 1 ? "lead" : "leads"}
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
              No unclaimed lead carries a <code>lead_owner</code>. Nothing to do.
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
                      {count} {outcome.replace(/_/g, " ")}
                      <span className="text-[var(--color-ink-3)]">
                        {" "}
                        — {EXPLAIN[outcome] ?? ""}
                      </span>
                    </li>
                  ))}
              </ul>
            </>
          )}

          {result.problems.length > 0 && (
            <div className="mt-3 border-t border-[var(--color-line)] pt-3">
              <p className="mb-2 text-[var(--color-ink-2)]">
                Needs a person ({result.problems.length} shown):
              </p>
              <ul className="space-y-1 text-[var(--color-ink-3)]">
                {result.problems.map((row) => (
                  <li key={row.lead_id}>
                    <span className="text-[var(--color-ink-2)]">
                      {row.company ?? row.lead_id}
                    </span>{" "}
                    — {row.owner_email} — {row.outcome.replace(/_/g, " ")}
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
