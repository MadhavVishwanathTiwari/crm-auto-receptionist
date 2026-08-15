"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";

import type { FieldStats, MappingWarning } from "@/lib/csv/inspect";
import { FIELD_SPECS, type CanonicalField } from "@/lib/csv/mapping";

import { BUTTON, INPUT, OUTCOME_TONE, PANEL } from "../ui";

type Mapping = Partial<Record<CanonicalField, string>>;

interface Preview {
  headers: string[];
  headerRowIndex: number;
  totalRows: number;
  shape: "clay" | "legacy_sheet" | "custom";
  mapping: Mapping;
  sample: Array<Record<string, string>>;
  invalidRows: number;
  fieldStats: FieldStats;
  warnings: MappingWarning[];
  unmapped: string[];
}

/** The half of a preview that changes when the operator remaps a column. */
interface Insight {
  fieldStats: FieldStats;
  warnings: MappingWarning[];
  unmapped: string[];
}

interface Result {
  importId: string;
  totalRows: number;
  counts: Record<string, number>;
  ownership?: Record<string, number>;
  ownershipError?: string;
}

/** A mapping from a previous upload of a file with exactly these columns. */
export interface SavedMapping {
  filename: string;
  headers: string[];
  mapping: Mapping;
}

const SHAPE_LABEL = {
  clay: "Clay export",
  legacy_sheet: "Legacy outreach sheet",
  custom: "Unrecognised layout",
} as const;

/** Debounce on re-previewing after a remap, so dragging through a select does not spam. */
const REMAP_DELAY_MS = 400;

function sameHeaders(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((value, i) => value === b[i]);
}

export function ImportClient({ saved = [] }: { saved?: SavedMapping[] }) {
  const router = useRouter();

  // The file text lives here for the whole flow. Preview and commit are both
  // stateless on the server, so this is the only copy.
  const [file, setFile] = useState<{ name: string; text: string } | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [mapping, setMapping] = useState<Mapping>({});
  const [insight, setInsight] = useState<Insight | null>(null);
  const [recomputing, setRecomputing] = useState(false);
  const [result, setResult] = useState<Result | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Only a manual remap should trigger a re-preview; a mapping that just came
  // back from the server is already described by the insight beside it.
  const remapped = useRef(false);

  const post = useCallback(async (path: string, body: unknown) => {
    const response = await fetch(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error ?? "Something went wrong.");
    return payload;
  }, []);

  function adopt(next: Preview) {
    setPreview(next);
    setMapping(next.mapping);
    setInsight({
      fieldStats: next.fieldStats,
      warnings: next.warnings,
      unmapped: next.unmapped,
    });
    remapped.current = false;
  }

  async function onPick(event: React.ChangeEvent<HTMLInputElement>) {
    const picked = event.target.files?.[0];
    if (!picked) return;

    setBusy(true);
    setError(null);
    setResult(null);
    setPreview(null);
    setInsight(null);

    try {
      const text = await picked.text();
      setFile({ name: picked.name, text });
      adopt(await post("/api/import/preview", { text }));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setFile(null);
    } finally {
      setBusy(false);
    }
  }

  /** Re-parse against a different header row; the mapping is redetected too. */
  async function onHeaderRowChange(headerRowIndex: number) {
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      adopt(await post("/api/import/preview", { text: file.text, headerRowIndex }));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  // Recompute the evidence after a remap. The preview route is stateless and
  // takes the mapping as an override, so this is the same call as the first
  // one — which keeps one implementation of what a mapping means.
  useEffect(() => {
    if (!file || !preview || !remapped.current) return;

    const timer = setTimeout(async () => {
      setRecomputing(true);
      try {
        const next: Preview = await post("/api/import/preview", {
          text: file.text,
          headerRowIndex: preview.headerRowIndex,
          mapping,
        });
        setInsight({
          fieldStats: next.fieldStats,
          warnings: next.warnings,
          unmapped: next.unmapped,
        });
        setPreview((current) =>
          current ? { ...current, invalidRows: next.invalidRows } : current,
        );
      } catch {
        // A failed recompute leaves the previous evidence on screen, which is
        // stale rather than wrong, and the commit re-derives everything anyway.
      } finally {
        setRecomputing(false);
      }
    }, REMAP_DELAY_MS);

    return () => clearTimeout(timer);
  }, [mapping, file, preview, post]);

  function remap(field: CanonicalField, header: string) {
    remapped.current = true;
    setMapping((current) => {
      const next = { ...current };
      // A header may back only one field, matching autoMapColumns. Letting
      // "email" feed both work_email and likely_email would send to a guess.
      for (const key of Object.keys(next) as CanonicalField[]) {
        if (next[key] === header) delete next[key];
      }
      if (header === "") delete next[field];
      else next[field] = header;
      return next;
    });
  }

  function reuse(saved: SavedMapping) {
    remapped.current = true;
    setMapping(saved.mapping);
  }

  async function onCommit() {
    if (!file || !preview) return;
    setBusy(true);
    setError(null);
    try {
      const next: Result = await post("/api/import/commit", {
        filename: file.name,
        text: file.text,
        headerRowIndex: preview.headerRowIndex,
        mapping,
      });
      setResult(next);
      setPreview(null);
      setInsight(null);
      setFile(null);
      // The leads grid and the review queue both changed.
      router.refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  const missingRequired = FIELD_SPECS.filter(
    (spec) => spec.required && !mapping[spec.field],
  );

  const fieldWarnings = new Map<CanonicalField, string>();
  const readiness: string[] = [];
  for (const warning of insight?.warnings ?? []) {
    if (warning.field) fieldWarnings.set(warning.field, warning.message);
    else readiness.push(warning.message);
  }

  const reusable = preview
    ? saved.find((entry) => sameHeaders(entry.headers, preview.headers))
    : undefined;

  return (
    <div className="space-y-4">
      <div className={PANEL}>
        <label htmlFor="csv" className="mb-2 block text-[var(--color-ink-2)]">
          CSV file
        </label>
        <input
          id="csv"
          type="file"
          accept=".csv,text/csv"
          disabled={busy}
          onChange={onPick}
          className={INPUT + " w-[400px] file:mr-3 file:border-0 file:bg-transparent file:text-[var(--color-ink-2)]"}
        />
        <p className="mt-2 text-[var(--color-ink-3)]">
          Clay exports and the legacy outreach sheet are both recognised, and any
          other layout can be mapped by hand below. Nothing is written until you
          commit.
        </p>
      </div>

      {error && (
        <p role="alert" className={PANEL + " text-[var(--color-danger)]"}>
          {error}
        </p>
      )}

      {result && (
        <div className={PANEL}>
          <h2 className="mb-2 text-[var(--color-ink)]">
            Imported {result.totalRows} rows
          </h2>
          <ul className="tabular space-y-1">
            {Object.entries(result.counts).map(([outcome, count]) => (
              <li key={outcome} className={OUTCOME_TONE[outcome]}>
                {count} {outcome.replace(/_/g, " ")}
              </li>
            ))}
          </ul>
          {(result.counts.flagged_review ?? 0) > 0 && (
            <p className="mt-3 text-[var(--color-ink-2)]">
              <a href="/review" className="underline">
                {result.counts.flagged_review} near-duplicates need a decision
              </a>
            </p>
          )}

          {result.ownership && (
            <p className="mt-3 text-[var(--color-ink-2)]">
              Ownership:{" "}
              {Object.entries(result.ownership)
                .map(([outcome, count]) => `${count} ${outcome.replace(/_/g, " ")}`)
                .join(", ")}
            </p>
          )}
          {result.ownershipError && (
            <p className="mt-2 text-[var(--color-warn)]">
              The leads imported, but ownership did not apply:{" "}
              {result.ownershipError} You can re-apply it below.
            </p>
          )}
        </div>
      )}

      {preview && (
        <>
          <div className={PANEL}>
            <div className="mb-3 flex items-center gap-4">
              <span className="text-[var(--color-ink)]">
                {SHAPE_LABEL[preview.shape]}
              </span>
              <span className="tabular text-[var(--color-ink-2)]">
                {preview.totalRows} rows
              </span>
              {preview.invalidRows > 0 && (
                <span className="tabular text-[var(--color-danger)]">
                  {preview.invalidRows} will fail validation
                </span>
              )}
            </div>

            <label className="text-[var(--color-ink-2)]">
              Headers are on row{" "}
              <input
                type="number"
                min={1}
                max={21}
                value={preview.headerRowIndex + 1}
                disabled={busy}
                onChange={(e) => onHeaderRowChange(Number(e.target.value) - 1)}
                className={INPUT + " tabular ml-1 w-16"}
              />
            </label>

            {reusable && (
              <p className="mt-3 flex items-center gap-3 text-[var(--color-ink-2)]">
                <span>
                  These columns match an earlier upload,{" "}
                  <span className="text-[var(--color-ink)]">{reusable.filename}</span>.
                </span>
                <button
                  type="button"
                  onClick={() => reuse(reusable)}
                  disabled={busy}
                  className={BUTTON}
                >
                  Reuse that mapping
                </button>
              </p>
            )}
          </div>

          {readiness.length > 0 && (
            <div className={PANEL}>
              <h2 className="mb-2 text-[var(--color-ink)]">
                These leads will import, but
              </h2>
              <ul className="max-w-[80ch] space-y-1 text-[var(--color-warn)]">
                {readiness.map((message) => (
                  <li key={message}>{message}</li>
                ))}
              </ul>
            </div>
          )}

          <div className={PANEL}>
            <div className="mb-3 flex items-baseline gap-3">
              <h2 className="text-[var(--color-ink)]">Column mapping</h2>
              <span className="text-[var(--color-ink-3)]">
                {recomputing
                  ? "checking..."
                  : `what ${preview.totalRows === 1 ? "the row" : "these rows"} would become`}
              </span>
            </div>

            <div className="space-y-1">
              {FIELD_SPECS.map((spec) => {
                const stat = insight?.fieldStats[spec.field];
                const warning = fieldWarnings.get(spec.field);
                const empty = stat !== undefined && stat.filled === 0;

                return (
                  <div key={spec.field}>
                    <label className="flex items-center gap-3">
                      <span className="w-40 shrink-0 text-[var(--color-ink-2)]">
                        {spec.label}
                        {spec.required && (
                          <span className="text-[var(--color-danger)]"> *</span>
                        )}
                      </span>
                      <select
                        value={mapping[spec.field] ?? ""}
                        disabled={busy}
                        onChange={(e) => remap(spec.field, e.target.value)}
                        className={INPUT + " w-56 shrink-0"}
                      >
                        <option value="">— not imported —</option>
                        {preview.headers.map((header) => (
                          <option key={header} value={header}>
                            {header}
                          </option>
                        ))}
                      </select>

                      <span
                        className={
                          "tabular w-16 shrink-0 text-right " +
                          (empty
                            ? "text-[var(--color-danger)]"
                            : warning
                              ? "text-[var(--color-warn)]"
                              : "text-[var(--color-ink-3)]")
                        }
                      >
                        {stat ? `${stat.filled}/${stat.total}` : ""}
                      </span>

                      <span
                        className="min-w-0 flex-1 truncate text-[var(--color-ink-3)]"
                        title={stat?.examples.join("  ·  ")}
                      >
                        {stat?.examples[0] ?? ""}
                      </span>
                    </label>

                    {warning && (
                      <p className="ml-[11.75rem] max-w-[70ch] text-[var(--color-warn)]">
                        {warning}
                      </p>
                    )}
                  </div>
                );
              })}
            </div>

            {insight && insight.unmapped.length > 0 && (
              <div className="mt-4 border-t border-[var(--color-line)] pt-3">
                <p className="max-w-[80ch] text-[var(--color-ink-3)]">
                  <span className="text-[var(--color-ink-2)]">
                    Not imported ({insight.unmapped.length}):
                  </span>{" "}
                  {insight.unmapped.join(", ")}
                </p>
              </div>
            )}
          </div>

          <div className={PANEL + " overflow-x-auto"}>
            <h2 className="mb-3 text-[var(--color-ink)]">First rows</h2>
            <table className="w-max border-collapse">
              <thead>
                <tr>
                  {preview.headers.map((header) => (
                    <th
                      key={header}
                      className="border border-[var(--color-line)] px-2 py-1 text-left font-normal text-[var(--color-ink-3)]"
                    >
                      {header}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {preview.sample.map((row, i) => (
                  <tr key={i}>
                    {preview.headers.map((header) => (
                      <td
                        key={header}
                        className="max-w-[220px] truncate border border-[var(--color-line)] px-2 py-1"
                      >
                        {row[header]}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="flex items-center gap-3 pb-4">
            <button
              type="button"
              onClick={onCommit}
              disabled={busy || missingRequired.length > 0}
              className={BUTTON}
            >
              {busy ? "Importing..." : `Import ${preview.totalRows} rows`}
            </button>
            {missingRequired.length > 0 && (
              <span className="text-[var(--color-danger)]">
                Map {missingRequired.map((s) => s.label).join(" and ")} first.
              </span>
            )}
          </div>
        </>
      )}
    </div>
  );
}
