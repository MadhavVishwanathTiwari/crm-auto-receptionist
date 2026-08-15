"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { BUTTON, PANEL } from "../ui";
import { repairLeadWebsites, type WebsiteRepairResult } from "./actions";

const TONE: Record<string, string> = {
  repaired: "text-[var(--color-ok)]",
  "repaired, but a demo already exists": "text-[var(--color-warn)]",
  "no candidate in raw": "text-[var(--color-ink-3)]",
};

const EXPLAIN: Record<string, string> = {
  repaired: "the company site was still in the stored CSV row",
  "repaired, but a demo already exists":
    "the demo was built against the wrong domain — check its slug by hand",
  "no candidate in raw": "nothing better was in the file, left as it is",
};

/**
 * Puts the company website back on leads that imported a directory link.
 *
 * Its own panel rather than part of the upload flow, for the same reason as the
 * ownership backfill: it writes no leads and reads no file. Re-uploading cannot
 * fix these — every row is a duplicate by work_email by now — but the original
 * CSV row is stored on each lead, so the real website never actually left.
 */
export function WebsiteRepair() {
  const router = useRouter();
  const [result, setResult] = useState<WebsiteRepairResult | null>(null);
  const [busy, setBusy] = useState(false);

  async function run(dryRun: boolean) {
    setBusy(true);
    try {
      const next = await repairLeadWebsites(dryRun);
      setResult(next);
      if (!dryRun && next.ok) router.refresh();
    } finally {
      setBusy(false);
    }
  }

  const repairable =
    (result?.counts.repaired ?? 0) +
    (result?.counts["repaired, but a demo already exists"] ?? 0);

  return (
    <div className={PANEL}>
      <h2 className="mb-2 text-[var(--color-ink)]">Websites that are maps links</h2>
      <p className="mb-3 max-w-[70ch] text-[var(--color-ink-3)]">
        Finds leads whose <code>website</code> is a Google Maps or directory link
        and reads the real company site back out of the stored import row. Those
        leads have a <code>website_domain</code> of <code>google.com</code>, which
        is what the demo builder joins on and the second key duplicate detection
        checks, so one wrong column makes every lead look like the same business.
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
        {result?.ok && result.dryRun && repairable > 0 && (
          <button
            type="button"
            onClick={() => run(false)}
            disabled={busy}
            className={BUTTON}
          >
            Repair {repairable} {repairable === 1 ? "lead" : "leads"}
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
              No lead has a directory link for a website. Nothing to do.
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
                        {" "}
                        — {EXPLAIN[outcome] ?? ""}
                      </span>
                    </li>
                  ))}
              </ul>
            </>
          )}

          {result.notable.length > 0 && (
            <div className="mt-3 border-t border-[var(--color-line)] pt-3">
              <p className="mb-2 text-[var(--color-ink-2)]">
                What changes ({result.notable.length} shown):
              </p>
              <ul className="space-y-1 text-[var(--color-ink-3)]">
                {result.notable.map((row) => (
                  <li key={row.lead_id}>
                    <span className="text-[var(--color-ink-2)]">
                      {row.company ?? row.lead_id}
                    </span>{" "}
                    — {row.new_website ?? "no candidate"}
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
