// Partitioning an upload into the four outcomes the import report counts.
//
// Pure: it takes the mapped rows and a snapshot of existing dedupe keys, and
// returns a decision per row. No database access, so the interesting rules are
// unit-testable without a stack.
//
// Deliberately NOT done with ON CONFLICT. Two reasons: a partial unique index
// is not a valid ON CONFLICT arbiter from supabase-js, and pre-partitioning is
// the only way to produce exact counts for all four buckets — ON CONFLICT DO
// NOTHING can tell you what was inserted but not why the rest was not.

import { normalizeDomain, normalizeEmail, normalizePhone } from "@/lib/normalize";
import type { MappedLead } from "./mapping";

export interface ExistingKeys {
  id: string;
  work_email_norm: string | null;
  place_id: string | null;
  website_domain: string | null;
  phone_e164: string | null;
}

export type RowDecision =
  | { outcome: "inserted"; values: Record<string, unknown>; cleanedFields: string[] }
  | {
      outcome: "skipped_duplicate";
      matchedLeadId: string | null;
      matchKind: "work_email";
      reason: string;
    }
  | {
      outcome: "flagged_review";
      matchedLeadId: string;
      matchKind: "place_id" | "website_domain" | "phone";
      matchValue: string;
      values: Record<string, unknown>;
    }
  | { outcome: "failed_validation"; reason: string };

export interface PartitionResult {
  decisions: RowDecision[];
  counts: {
    inserted: number;
    skipped_duplicate: number;
    flagged_review: number;
    failed_validation: number;
  };
}

export function partitionRows(
  rows: MappedLead[],
  existing: ExistingKeys[],
): PartitionResult {
  const byEmail = new Map<string, string>();
  const byPlace = new Map<string, string>();
  const byDomain = new Map<string, string>();
  const byPhone = new Map<string, string>();

  for (const lead of existing) {
    if (lead.work_email_norm) byEmail.set(lead.work_email_norm, lead.id);
    if (lead.place_id) byPlace.set(lead.place_id, lead.id);
    if (lead.website_domain) byDomain.set(lead.website_domain, lead.id);
    if (lead.phone_e164) byPhone.set(lead.phone_e164, lead.id);
  }

  // A file that lists the same address twice must not produce two leads and
  // then a confusing unique-violation on the second insert.
  const seenInBatch = new Set<string>();

  const decisions: RowDecision[] = rows.map((row) => {
    if (row.errors.length > 0) {
      return { outcome: "failed_validation", reason: row.errors.join("; ") };
    }

    const email = normalizeEmail(row.values.work_email as string | null);
    if (!email) {
      return { outcome: "failed_validation", reason: "no usable work_email" };
    }

    const existingId = byEmail.get(email);
    if (existingId) {
      return {
        outcome: "skipped_duplicate",
        matchedLeadId: existingId,
        matchKind: "work_email",
        reason: `already in the database as ${email}`,
      };
    }

    if (seenInBatch.has(email)) {
      return {
        outcome: "skipped_duplicate",
        matchedLeadId: null,
        matchKind: "work_email",
        reason: `appears earlier in this file as ${email}`,
      };
    }

    // Near-duplicates. Checked most to least reliable: a shared place_id is
    // certainly the same business, a shared domain very likely, a shared phone
    // often (but franchises and answering services share numbers). None of
    // these is dropped — two contacts at one company are usually both worth
    // having, and only a human can tell.
    const placeId = (row.values.place_id as string | null) ?? null;
    const domain = normalizeDomain(row.values.website as string | null);
    const phone = normalizePhone(row.values.phone as string | null);

    const near: Array<[string | null, Map<string, string>, "place_id" | "website_domain" | "phone"]> = [
      [placeId, byPlace, "place_id"],
      [domain, byDomain, "website_domain"],
      [phone, byPhone, "phone"],
    ];

    for (const [value, index, kind] of near) {
      if (!value) continue;
      const matched = index.get(value);
      if (matched) {
        seenInBatch.add(email);
        return {
          outcome: "flagged_review",
          matchedLeadId: matched,
          matchKind: kind,
          matchValue: value,
          values: row.values,
        };
      }
    }

    seenInBatch.add(email);

    // Near-duplicate detection deliberately does NOT extend within the batch.
    // A review row has to point at an existing lead, and a row we have not
    // inserted yet has no id to point at. Two rows in one file for the same
    // business are therefore both inserted — they are two real contacts at that
    // company, the org-wide unique on work_email still prevents an actual
    // duplicate, and the next import that touches that business will flag
    // against the leads these created.
    return {
      outcome: "inserted",
      values: row.values,
      cleanedFields: row.cleanedFields,
    };
  });

  const counts = {
    inserted: 0,
    skipped_duplicate: 0,
    flagged_review: 0,
    failed_validation: 0,
  };
  for (const decision of decisions) counts[decision.outcome] += 1;

  return { decisions, counts };
}

/** The distinct keys an upload needs to look up before partitioning. */
export function collectLookupKeys(rows: MappedLead[]) {
  const emails = new Set<string>();
  const placeIds = new Set<string>();
  const domains = new Set<string>();
  const phones = new Set<string>();

  for (const row of rows) {
    const email = normalizeEmail(row.values.work_email as string | null);
    if (email) emails.add(email);

    const placeId = row.values.place_id as string | null;
    if (placeId) placeIds.add(placeId);

    const domain = normalizeDomain(row.values.website as string | null);
    if (domain) domains.add(domain);

    const phone = normalizePhone(row.values.phone as string | null);
    if (phone) phones.add(phone);
  }

  return {
    emails: [...emails],
    placeIds: [...placeIds],
    domains: [...domains],
    phones: [...phones],
  };
}
