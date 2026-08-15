// Turning a parsed upload into rows in the database.
//
// The pure half of the pipeline (parse → clean → map → partition) already
// exists and is unit-tested. This is the half that talks to Postgres: it runs
// the lookup that partitioning needs, then writes leads, the per-row import
// report, and the near-duplicate queue.
//
// Everything here goes through the cookie-bound RLS client. There is no
// service-role path: an import is a user action, and the policies on leads /
// imports / import_rows / dedupe_reviews already permit exactly it.

import type { OrgContext } from "@/lib/org";

import { collectLookupKeys, partitionRows, type ExistingKeys } from "./dedupe";
import {
  collectFieldStats,
  mappingWarnings,
  unmappedHeaders,
  type FieldStats,
  type MappingWarning,
} from "./inspect";
import { autoMapColumns, detectShape, mapRow, type ColumnMapping } from "./mapping";
import { parseCsv } from "./parse";

/** PostgREST puts `in` lists in the URL, so they cannot be unbounded. */
const LOOKUP_CHUNK = 200;
const WRITE_CHUNK = 500;
/** Matches the bound assign_lead_owners() enforces on its own input. */
const OWNER_CHUNK = 2000;

export class ImportError extends Error {}

export interface ImportPreview {
  headers: string[];
  headerRowIndex: number;
  totalRows: number;
  shape: ReturnType<typeof detectShape>;
  mapping: ColumnMapping;
  /** First few mapped rows, so the operator can see the mapping is right. */
  sample: Array<Record<string, string>>;
  /** Rows that cannot be inserted at all, found before anything is written. */
  invalidRows: number;
  /** Per mapped field: how often the column produced a value, and which. */
  fieldStats: FieldStats;
  /** Everything wrong with this mapping. None of it blocks a commit. */
  warnings: MappingWarning[];
  /** Columns no field claims, so a dropped one is visible rather than absent. */
  unmapped: string[];
}

export function previewCsv(
  text: string,
  headerRowIndex?: number,
  overrideMapping?: ColumnMapping,
): ImportPreview {
  const parsed = parseCsv(text, headerRowIndex);
  const mapping = overrideMapping ?? autoMapColumns(parsed.headers);

  // Cheap enough to map every row here: it is the same work commit does, and
  // showing "12 rows will fail" before the write is the whole point of a
  // preview step.
  const mapped = parsed.rows.map((row) => mapRow(row, mapping));
  const invalidRows = mapped.filter((row) => row.errors.length > 0).length;

  const fieldStats = collectFieldStats(parsed.rows, mapped, mapping);

  return {
    headers: parsed.headers,
    headerRowIndex: parsed.headerRowIndex,
    totalRows: parsed.totalRows,
    shape: detectShape(parsed.headers),
    mapping,
    sample: parsed.rows.slice(0, 5),
    invalidRows,
    fieldStats,
    warnings: mappingWarnings(mapping, fieldStats),
    unmapped: unmappedHeaders(parsed.headers, mapping),
  };
}

/**
 * Every lead already in the org that shares a dedupe key with this upload.
 *
 * Four indexed lookups beat reading the whole table: the org's lead count grows
 * without bound, the number of distinct keys in one file does not.
 *
 * Archived leads are deliberately included. `leads_org_work_email_key` is a
 * plain unique index, not a partial one, so an archived lead still occupies its
 * email — excluding it here would turn a clean "skipped_duplicate" into a raw
 * 23505 from the insert.
 */
async function fetchExistingKeys(
  supabase: OrgContext["supabase"],
  keys: ReturnType<typeof collectLookupKeys>,
): Promise<ExistingKeys[]> {
  const found = new Map<string, ExistingKeys>();

  const lookups: Array<[string, string[]]> = [
    ["work_email_norm", keys.emails],
    ["place_id", keys.placeIds],
    ["website_domain", keys.domains],
    ["phone_e164", keys.phones],
  ];

  for (const [column, values] of lookups) {
    for (let i = 0; i < values.length; i += LOOKUP_CHUNK) {
      const slice = values.slice(i, i + LOOKUP_CHUNK);
      if (slice.length === 0) continue;

      const { data, error } = await supabase
        .from("leads")
        .select("id, work_email_norm, place_id, website_domain, phone_e164")
        .in(column, slice);

      if (error) {
        throw new ImportError(`Could not check for duplicates: ${error.message}`);
      }
      for (const row of data ?? []) found.set(row.id as string, row as ExistingKeys);
    }
  }

  return [...found.values()];
}

const SOURCE_BY_SHAPE: Record<ReturnType<typeof detectShape>, string> = {
  clay: "csv_clay",
  legacy_sheet: "csv_legacy",
  custom: "csv",
};

/** Per-lead outcomes from assign_lead_owners(), tallied. */
export type OwnershipCounts = Partial<Record<string, number>>;

export interface CommitResult {
  importId: string;
  totalRows: number;
  counts: {
    inserted: number;
    skipped_duplicate: number;
    flagged_review: number;
    failed_validation: number;
  };
  /** Absent when the file named no owners. */
  ownership?: OwnershipCounts;
  /**
   * Set when ownership could not be applied at all. Deliberately not thrown:
   * the leads are in, which is the part that is expensive to redo, and
   * backfill_lead_owners() can reapply ownership afterwards from `raw`.
   */
  ownershipError?: string;
}

/**
 * Claims the freshly inserted leads for whoever the sheet says owns them.
 *
 * Only inserted rows: a skipped duplicate has no new lead to claim, and
 * quietly reassigning the lead it matched would make a routine re-upload move
 * ownership around. Re-applying ownership to leads that already exist is
 * backfill_lead_owners(), which is an explicit act.
 */
async function assignOwners(
  supabase: OrgContext["supabase"],
  assignments: Array<{ lead_id: string; owner_email: string }>,
): Promise<OwnershipCounts> {
  const counts: OwnershipCounts = {};

  for (let i = 0; i < assignments.length; i += OWNER_CHUNK) {
    const { data, error } = await supabase.rpc("assign_lead_owners", {
      p_assignments: assignments.slice(i, i + OWNER_CHUNK),
    });
    if (error) throw new ImportError(error.message);

    for (const row of (data ?? []) as Array<{ outcome: string }>) {
      counts[row.outcome] = (counts[row.outcome] ?? 0) + 1;
    }
  }

  return counts;
}

export async function commitImport(
  ctx: OrgContext,
  input: { filename: string; text: string; headerRowIndex?: number; mapping?: ColumnMapping },
): Promise<CommitResult> {
  const { supabase, orgId, userId } = ctx;

  const parsed = parseCsv(input.text, input.headerRowIndex);
  const mapping = input.mapping ?? autoMapColumns(parsed.headers);
  const shape = detectShape(parsed.headers);

  const mapped = parsed.rows.map((row) => mapRow(row, mapping));
  const existing = await fetchExistingKeys(supabase, collectLookupKeys(mapped));
  const { decisions, counts } = partitionRows(mapped, existing);

  // The import row exists before anything references it: import_rows.import_id
  // is NOT NULL and leads.import_id points here too.
  const { data: importRow, error: importError } = await supabase
    .from("imports")
    .insert({
      org_id: orgId,
      created_by: userId,
      filename: input.filename,
      shape,
      header_row_index: parsed.headerRowIndex,
      detected_headers: parsed.headers,
      column_mapping: mapping,
      status: "committing",
      total_rows: parsed.totalRows,
    })
    .select("id")
    .single();

  if (importError || !importRow) {
    throw new ImportError(
      `Could not start the import: ${importError?.message ?? "no row returned"}`,
    );
  }
  const importId = importRow.id as string;

  try {
    // --- leads ---------------------------------------------------------------
    // Insertion order is what ties the returned ids back to their decisions;
    // Postgres returns a multi-row INSERT ... RETURNING in the order given.
    const insertIndexes: number[] = [];
    const leadPayloads: Record<string, unknown>[] = [];

    decisions.forEach((decision, index) => {
      if (decision.outcome !== "inserted") return;
      insertIndexes.push(index);
      leadPayloads.push({
        ...decision.values,
        org_id: orgId,
        import_id: importId,
        source: SOURCE_BY_SHAPE[shape],
        raw: parsed.rows[index] ?? {},
      });
    });

    const newLeadIds: string[] = [];
    for (let i = 0; i < leadPayloads.length; i += WRITE_CHUNK) {
      const chunk = leadPayloads.slice(i, i + WRITE_CHUNK);
      const { data, error } = await supabase.from("leads").insert(chunk).select("id");

      if (error) throw new ImportError(`Could not insert leads: ${error.message}`);
      // A write denied by RLS comes back as zero rows and no error, so an empty
      // result has to be treated as a failure rather than as "nothing to do".
      if (!data || data.length !== chunk.length) {
        throw new ImportError(
          `Inserted ${data?.length ?? 0} of ${chunk.length} leads. ` +
            `The rest were rejected by row-level security.`,
        );
      }
      for (const row of data) newLeadIds.push(row.id as string);
    }

    const leadIdByIndex = new Map<number, string>();
    insertIndexes.forEach((rowIndex, i) => {
      const id = newLeadIds[i];
      if (id) leadIdByIndex.set(rowIndex, id);
    });

    // --- ownership -----------------------------------------------------------
    // The legacy sheet carries `lead_owner`, and a lead somebody has already
    // worked has to come across still belonging to them. It cannot ride along
    // in the insert: claimed_by is guarded and status is derived, so this is an
    // RPC that claims on the named operator's behalf and writes their event.
    const assignments = [...leadIdByIndex]
      .flatMap(([rowIndex, leadId]) => {
        const owner = mapped[rowIndex]?.ownerEmail;
        return owner ? [{ lead_id: leadId, owner_email: owner }] : [];
      });

    let ownership: OwnershipCounts | undefined;
    let ownershipError: string | undefined;
    if (assignments.length > 0) {
      try {
        ownership = await assignOwners(supabase, assignments);
      } catch (cause) {
        // Not fatal. The leads are the expensive part and they are in; ownership
        // is recoverable from `raw` with backfill_lead_owners() afterwards.
        // Rolling the import back over this would be strictly worse.
        ownershipError = cause instanceof Error ? cause.message : String(cause);
      }
    }

    // --- the per-row report --------------------------------------------------
    const importRowPayloads = decisions.map((decision, index) => {
      const base = {
        import_id: importId,
        org_id: orgId,
        row_index: index,
        raw: parsed.rows[index] ?? {},
        cleaned_fields: mapped[index]?.cleanedFields ?? [],
        outcome: decision.outcome,
      };

      switch (decision.outcome) {
        case "inserted":
          return { ...base, lead_id: leadIdByIndex.get(index) ?? null };
        case "skipped_duplicate":
          return {
            ...base,
            matched_lead_id: decision.matchedLeadId,
            match_kind: decision.matchKind,
            error_detail: decision.reason,
          };
        case "flagged_review":
          return {
            ...base,
            matched_lead_id: decision.matchedLeadId,
            match_kind: decision.matchKind,
          };
        case "failed_validation":
          return { ...base, error_detail: decision.reason };
      }
    });

    const importRowIds: string[] = [];
    for (let i = 0; i < importRowPayloads.length; i += WRITE_CHUNK) {
      const chunk = importRowPayloads.slice(i, i + WRITE_CHUNK);
      const { data, error } = await supabase.from("import_rows").insert(chunk).select("id");

      if (error) throw new ImportError(`Could not write the import report: ${error.message}`);
      if (!data || data.length !== chunk.length) {
        throw new ImportError("The import report was rejected by row-level security.");
      }
      for (const row of data) importRowIds.push(row.id as string);
    }

    // --- the near-duplicate queue -------------------------------------------
    const reviewPayloads = decisions.flatMap((decision, index) =>
      decision.outcome === "flagged_review"
        ? [
            {
              org_id: orgId,
              import_id: importId,
              import_row_id: importRowIds[index] ?? null,
              existing_lead_id: decision.matchedLeadId,
              match_kind: decision.matchKind,
              match_value: decision.matchValue,
              // The candidate is stored in full so the decision survives the
              // import being deleted.
              incoming: decision.values,
            },
          ]
        : [],
    );

    for (let i = 0; i < reviewPayloads.length; i += WRITE_CHUNK) {
      const chunk = reviewPayloads.slice(i, i + WRITE_CHUNK);
      const { error } = await supabase.from("dedupe_reviews").insert(chunk);
      if (error) throw new ImportError(`Could not queue duplicates for review: ${error.message}`);
    }

    await supabase
      .from("imports")
      .update({ status: "completed", counts, completed_at: new Date().toISOString() })
      .eq("id", importId);

    return { importId, totalRows: parsed.totalRows, counts, ownership, ownershipError };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // Best effort: if this update is itself what failed, the import is left in
    // `committing`, which is still an honest description of where it stopped.
    await supabase
      .from("imports")
      .update({ status: "failed", error: message, completed_at: new Date().toISOString() })
      .eq("id", importId);
    throw error;
  }
}
