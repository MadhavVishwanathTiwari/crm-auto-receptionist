"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

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
}

interface Result {
  importId: string;
  totalRows: number;
  counts: Record<string, number>;
}

const SHAPE_LABEL = {
  clay: "Clay export",
  legacy_sheet: "Legacy outreach sheet",
  custom: "Unrecognised layout",
} as const;

export function ImportClient() {
  const router = useRouter();

  // The file text lives here for the whole flow. Preview and commit are both
  // stateless on the server, so this is the only copy.
  const [file, setFile] = useState<{ name: string; text: string } | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [mapping, setMapping] = useState<Mapping>({});
  const [result, setResult] = useState<Result | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function post(path: string, body: unknown) {
    const response = await fetch(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error ?? "Something went wrong.");
    return payload;
  }

  async function onPick(event: React.ChangeEvent<HTMLInputElement>) {
    const picked = event.target.files?.[0];
    if (!picked) return;

    setBusy(true);
    setError(null);
    setResult(null);
    setPreview(null);

    try {
      const text = await picked.text();
      setFile({ name: picked.name, text });
      const next: Preview = await post("/api/import/preview", { text });
      setPreview(next);
      setMapping(next.mapping);
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
      const next: Preview = await post("/api/import/preview", {
        text: file.text,
        headerRowIndex,
      });
      setPreview(next);
      setMapping(next.mapping);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  function remap(field: CanonicalField, header: string) {
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
          Clay exports and the legacy outreach sheet are both recognised. Nothing
          is written until you commit.
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
          </div>

          <div className={PANEL}>
            <h2 className="mb-3 text-[var(--color-ink)]">Column mapping</h2>
            <div className="grid grid-cols-2 gap-x-8 gap-y-1">
              {FIELD_SPECS.map((spec) => (
                <label key={spec.field} className="flex items-center gap-2">
                  <span className="w-44 shrink-0 text-[var(--color-ink-2)]">
                    {spec.label}
                    {spec.required && (
                      <span className="text-[var(--color-danger)]"> *</span>
                    )}
                  </span>
                  <select
                    value={mapping[spec.field] ?? ""}
                    disabled={busy}
                    onChange={(e) => remap(spec.field, e.target.value)}
                    className={INPUT + " min-w-0 flex-1"}
                  >
                    <option value="">— not imported —</option>
                    {preview.headers.map((header) => (
                      <option key={header} value={header}>
                        {header}
                      </option>
                    ))}
                  </select>
                </label>
              ))}
            </div>
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
