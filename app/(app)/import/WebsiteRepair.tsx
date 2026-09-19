"use client";

import { repairLeadWebsites } from "./actions";
import { RepairPanel, RepairRows } from "./RepairPanel";

const TONE: Record<string, string> = {
  repaired: "text-ok",
  "repaired, but a demo already exists": "text-warn",
  "no candidate in raw": "text-ink-3",
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
  return (
    <RepairPanel
      title="Websites that are maps links"
      description={
        <>
          Finds leads whose website is a Google Maps link rather than the
          business&apos;s own site, and reads the real company site back out of
          the stored import row. Those leads have a <code>website_domain</code>{" "}
          of <code>google.com</code>, which is what the demo builder joins on and
          the second key duplicate detection checks, so one wrong column makes
          every lead look like the same business.
        </>
      }
      tone={TONE}
      explain={EXPLAIN}
      run={repairLeadWebsites}
      emptyMessage="No lead has a maps link for a website. Nothing to do."
      applyLabel={(result) => {
        const n =
          (result.counts.repaired ?? 0) +
          (result.counts["repaired, but a demo already exists"] ?? 0);
        return n > 0 ? `Repair ${n} ${n === 1 ? "lead" : "leads"}` : null;
      }}
      detail={(result) =>
        result.notable.length > 0 && (
          <RepairRows label={`What changes (${result.notable.length} shown):`}>
            {result.notable.map((row) => (
              <li key={row.lead_id}>
                <span className="text-ink-2">{row.company ?? row.lead_id}</span>{" "}
                — {row.new_website ?? "no candidate"}
              </li>
            ))}
          </RepairRows>
        )
      }
    />
  );
}
