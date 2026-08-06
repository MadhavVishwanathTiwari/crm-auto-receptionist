import Papa from "papaparse";

// Limits kept conservative so one upload stays well inside serverless memory.
// A 1000-lead import is ~1 MB, so 10 MB is a wide margin, not a constraint.
export const MAX_CSV_BYTES = 10 * 1024 * 1024;
export const MAX_CSV_ROWS = 50_000;

export class CsvParseError extends Error {}

export interface ParsedCsv {
  headers: string[];
  rows: Record<string, string>[];
  /** Which row the headers came from. 0 for Clay, 1 for the legacy sheet. */
  headerRowIndex: number;
  totalRows: number;
}

/**
 * Picks the header row out of the first few lines.
 *
 * The legacy outreach sheet has a merged banner across row 1 and the real
 * headers on row 2 — the Auto-Receptionist repo hardcodes headerRowNumber = 2
 * for the same sheet. Papaparse cannot skip rows while `header: true`, so we
 * parse headerless, choose the row, and re-key by hand.
 *
 * The heuristic is "the row with the most distinct non-empty cells", which
 * separates a sparse banner from a dense header without guessing at content.
 * It is only ever a default: the UI shows which row was chosen and lets it be
 * overridden, so a wrong guess costs a click rather than a bad import.
 */
export function detectHeaderRow(rows: string[][], lookahead = 3): number {
  const window = rows.slice(0, lookahead);
  const width = Math.max(0, ...window.map((r) => r.length));
  if (width === 0) return 0;

  // The FIRST row that fills at least half its width. A merged banner leaves
  // most cells empty and fails this; a header row passes even when it has a
  // blank column or two.
  //
  // Counting distinct values instead would be wrong: a header with one blank
  // column scores lower than the dense data row beneath it, and the parser
  // would eat the header as data and report "no data rows".
  for (let i = 0; i < window.length; i++) {
    const filled = (window[i] ?? []).filter((c) => (c ?? "").trim()).length;
    if (filled * 2 >= width) return i;
  }

  return 0;
}

/**
 * Parses CSV text into keyed rows.
 *
 * `headerRowIndex` overrides detection — this is what the correction UI sends
 * back when the heuristic picked wrong.
 */
export function parseCsv(text: string, headerRowIndex?: number): ParsedCsv {
  if (Buffer.byteLength(text, "utf8") > MAX_CSV_BYTES) {
    throw new CsvParseError(
      `File is larger than ${MAX_CSV_BYTES / 1024 / 1024} MB.`,
    );
  }

  const result = Papa.parse<string[]>(text, {
    header: false,
    skipEmptyLines: "greedy",
  });

  // Papaparse reports a delimiter guess as an error on single-column files;
  // only genuine structural problems should stop an import.
  const fatal = result.errors.filter((e) => e.type !== "Delimiter");
  if (fatal.length > 0) {
    const first = fatal[0]!;
    throw new CsvParseError(
      `CSV parse error (row ${first.row ?? "?"}): ${first.message}`,
    );
  }

  const grid = result.data;
  if (grid.length === 0) throw new CsvParseError("The file is empty.");

  const index = headerRowIndex ?? detectHeaderRow(grid);
  const headerRow = grid[index];
  if (!headerRow) {
    throw new CsvParseError(`There is no row ${index + 1} to read headers from.`);
  }

  // Blank trailing headers are common in spreadsheet exports. Keep the position
  // so column alignment survives, but give it a stable synthetic name.
  const headers = headerRow.map((h, i) => {
    const trimmed = (h ?? "").trim();
    return trimmed || `column_${i + 1}`;
  });

  if (headers.every((h) => h.startsWith("column_"))) {
    throw new CsvParseError("That row has no column names in it.");
  }

  const body = grid.slice(index + 1);
  if (body.length === 0) throw new CsvParseError("The file has no data rows.");
  if (body.length > MAX_CSV_ROWS) {
    throw new CsvParseError(
      `The file has ${body.length} rows; the limit is ${MAX_CSV_ROWS}.`,
    );
  }

  const rows = body.map((cells) => {
    const row: Record<string, string> = {};
    headers.forEach((header, i) => {
      row[header] = (cells[i] ?? "").trim();
    });
    return row;
  });

  return { headers, rows, headerRowIndex: index, totalRows: rows.length };
}
