import { requireOrgContext } from "@/lib/org";

import { OUTCOME_TONE, PAGE, PAGE_HEADER, PANEL } from "../ui";
import { ImportClient } from "./ImportClient";
import { OwnershipBackfill } from "./OwnershipBackfill";

// The import history has to reflect the upload that just finished.
export const dynamic = "force-dynamic";

interface ImportRecord {
  id: string;
  filename: string;
  shape: string;
  status: string;
  total_rows: number;
  counts: Record<string, number> | null;
  error: string | null;
  created_at: string;
}

export default async function ImportPage() {
  const { supabase } = await requireOrgContext();

  const { data: imports } = await supabase
    .from("imports")
    .select("id, filename, shape, status, total_rows, counts, error, created_at")
    .order("created_at", { ascending: false })
    .limit(20);

  const history = (imports ?? []) as ImportRecord[];

  return (
    <div className={PAGE}>
      <header className={PAGE_HEADER}>
        <h1 className="text-[var(--color-ink)]">Import</h1>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        <div className="max-w-[1100px] space-y-4">
          <ImportClient />

          <OwnershipBackfill />

          <div className={PANEL}>
            <h2 className="mb-3 text-[var(--color-ink)]">Recent imports</h2>
            {history.length === 0 ? (
              <p className="text-[var(--color-ink-3)]">Nothing imported yet.</p>
            ) : (
              <table className="w-full border-collapse">
                <thead>
                  <tr className="text-left text-[var(--color-ink-3)]">
                    <th className="py-1 font-normal">File</th>
                    <th className="py-1 font-normal">Shape</th>
                    <th className="py-1 font-normal">Status</th>
                    <th className="py-1 text-right font-normal">Rows</th>
                    <th className="py-1 text-right font-normal">In</th>
                    <th className="py-1 text-right font-normal">Dupe</th>
                    <th className="py-1 text-right font-normal">Review</th>
                    <th className="py-1 text-right font-normal">Failed</th>
                    <th className="py-1 font-normal">When</th>
                  </tr>
                </thead>
                <tbody>
                  {history.map((record) => (
                    <tr
                      key={record.id}
                      className="border-t border-[var(--color-line)]"
                    >
                      <td className="py-1" title={record.error ?? undefined}>
                        {record.filename}
                      </td>
                      <td className="py-1 text-[var(--color-ink-2)]">
                        {record.shape}
                      </td>
                      <td
                        className={
                          "py-1 " +
                          (record.status === "failed"
                            ? "text-[var(--color-danger)]"
                            : "text-[var(--color-ink-2)]")
                        }
                      >
                        {record.status}
                      </td>
                      <td className="tabular py-1 text-right">
                        {record.total_rows}
                      </td>
                      {(
                        [
                          "inserted",
                          "skipped_duplicate",
                          "flagged_review",
                          "failed_validation",
                        ] as const
                      ).map((key) => (
                        <td
                          key={key}
                          className={
                            "tabular py-1 text-right " + (OUTCOME_TONE[key] ?? "")
                          }
                        >
                          {record.counts?.[key] ?? 0}
                        </td>
                      ))}
                      <td className="py-1 text-[var(--color-ink-3)]">
                        {new Date(record.created_at).toLocaleString()}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
