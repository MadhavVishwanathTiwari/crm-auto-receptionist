// Showing the operator what a mapping would actually do.
//
// The mapping UI used to hand back a header name and nothing else, which meant
// a wrong mapping looked exactly like a right one. `website <- url` imported
// fifty Google Maps links as company sites and nothing on the screen could have
// told you: website_domain is generated from website, a maps link normalizes to
// google.com, and that is the join key the demo builder and near-duplicate
// detection both use.
//
// So the preview reports, per mapped field, how often the column produced a
// value and what those values became after cleaning. That catches every wrong
// mapping rather than the two we happen to know about, which matters because
// the next unfamiliar export is the one nobody has read yet.

import { normalizeDomain } from "@/lib/normalize";

import { type CanonicalField, type ColumnMapping, type MappedLead } from "./mapping";

/** Rows examined for statistics. Independent of the 5-row display sample. */
export const STATS_ROWS = 200;

const MAX_EXAMPLES = 3;
const EXAMPLE_CHARS = 80;

export interface FieldStat {
  /** The CSV column backing this field. */
  header: string;
  /** Rows where that column had anything in it at all. */
  present: number;
  /** Rows where it survived cleaning into a value we would store. */
  filled: number;
  /** Rows examined. */
  total: number;
  /** Distinct cleaned values, as they would be stored. */
  examples: string[];
}

export type FieldStats = Partial<Record<CanonicalField, FieldStat>>;

export interface MappingWarning {
  /** Set when the warning is about one field, so the UI can show it inline. */
  field?: CanonicalField;
  message: string;
}

/**
 * Directory and social hosts. A lead whose `website` is one of these has no
 * company domain, which breaks the demo join and collapses near-duplicate
 * detection onto a single key for the whole file.
 */
const AGGREGATOR_DOMAINS = new Set([
  "google.com",
  "google.co.uk",
  "goo.gl",
  "facebook.com",
  "fb.com",
  "instagram.com",
  "linkedin.com",
  "twitter.com",
  "x.com",
  "yelp.com",
  "yellowpages.com",
  "bbb.org",
  "bing.com",
  "apple.com",
  "maps.apple.com",
  "nextdoor.com",
  "angi.com",
  "thumbtack.com",
]);

const EMAIL_FIELDS: CanonicalField[] = ["work_email", "lead_owner"];

/**
 * Fields where an empty column changes what the app can do with the lead —
 * whether it can be sent to, scheduled, demoed, or attributed to an operator.
 *
 * Everything else is allowed to be empty in silence. A file with no Twitter
 * handles is not a problem, and a warning nobody can act on is what teaches
 * people to stop reading the warnings.
 */
const CONSEQUENTIAL = new Set<CanonicalField>([
  "work_email",
  "company_name",
  "city",
  "state",
  "latitude",
  "longitude",
  "website",
  "full_name",
  "first_name",
  "lead_owner",
]);

/**
 * The value this field would be stored as, for one row.
 *
 * Two fields are not columns on `leads` and need their own answer: `full_name`
 * is split apart by mapRow, so showing the reassembled pieces is what tells the
 * operator whether the split worked; `lead_owner` is handed to an RPC after the
 * insert and lives outside `values`.
 */
function storedValue(field: CanonicalField, mapped: MappedLead): string | null {
  if (field === "lead_owner") return mapped.ownerEmail;

  if (field === "full_name") {
    const parts = [
      mapped.values.first_name,
      mapped.values.middle_name,
      mapped.values.last_name,
      mapped.values.name_suffix,
    ].filter(Boolean);
    return parts.length > 0 ? parts.join(" ") : null;
  }

  const value = mapped.values[field];
  if (value === null || value === undefined || value === "") return null;
  return String(value);
}

/**
 * Per-field evidence for the mapping screen.
 *
 * `present` counts the raw cell being non-blank and `filled` counts it
 * surviving into a stored value, because the gap between them is the signal.
 * A column that is simply empty and a column full of text that is not an email
 * address are different mistakes with different fixes, and collapsing them into
 * one number hides both. It also keeps the defaulted fields honest:
 * `country_code` falls back to "US" and `email_confidence` to "unknown", so
 * counting the stored value alone would report a blank column as fully mapped.
 */
export function collectFieldStats(
  rows: Array<Record<string, string>>,
  mapped: MappedLead[],
  mapping: ColumnMapping,
): FieldStats {
  const limit = Math.min(rows.length, STATS_ROWS);
  const stats: FieldStats = {};

  for (const [key, header] of Object.entries(mapping)) {
    if (!header) continue;
    const field = key as CanonicalField;

    let present = 0;
    let filled = 0;
    const examples: string[] = [];

    for (let i = 0; i < limit; i++) {
      const cell = (rows[i]?.[header] ?? "").trim();
      if (cell === "") continue;
      present++;

      const row = mapped[i];
      const value = row ? storedValue(field, row) : null;
      if (value === null) continue;
      filled++;

      if (examples.length < MAX_EXAMPLES && !examples.includes(value)) {
        examples.push(
          value.length > EXAMPLE_CHARS ? `${value.slice(0, EXAMPLE_CHARS)}…` : value,
        );
      }
    }

    stats[field] = { header, present, filled, total: limit, examples };
  }

  return stats;
}

/** Headers that no field claims, in file order. */
export function unmappedHeaders(
  headers: string[],
  mapping: ColumnMapping,
): string[] {
  const claimed = new Set(Object.values(mapping).filter(Boolean));
  return headers.filter((header) => !claimed.has(header));
}

function numeric(values: string[]): number[] {
  return values.map(Number).filter((n) => Number.isFinite(n));
}

/**
 * Everything wrong with this mapping that is worth saying out loud.
 *
 * None of it blocks a commit. `work_email` and `company_name` are the only two
 * things the importer refuses to proceed without, and that stays true: an
 * operator may knowingly have a list with no coordinates and import it anyway.
 * The point is that they find out here rather than at /queue a week later.
 */
export function mappingWarnings(
  mapping: ColumnMapping,
  stats: FieldStats,
): MappingWarning[] {
  const warnings: MappingWarning[] = [];
  const stat = (field: CanonicalField) => stats[field];

  // --- per field -----------------------------------------------------------
  for (const [key, value] of Object.entries(stats)) {
    const field = key as CanonicalField;
    if (!value || value.total === 0) continue;

    if (value.present === 0) {
      if (CONSEQUENTIAL.has(field)) {
        warnings.push({
          field,
          message: `"${value.header}" is empty in all ${value.total} rows checked.`,
        });
      }
      continue;
    }

    if (value.filled === 0) {
      warnings.push({
        field,
        message:
          `Nothing in "${value.header}" survived cleaning. ` +
          `It has values, but none of them are usable here.`,
      });
      continue;
    }

    if (EMAIL_FIELDS.includes(field) && value.filled * 2 < value.present) {
      warnings.push({
        field,
        message:
          `Most values in "${value.header}" are not email addresses ` +
          `(${value.filled} of ${value.present} parsed).`,
      });
    }
  }

  // --- website is a directory link, not a company site ----------------------
  const website = stat("website");
  if (website && website.examples.length > 0) {
    const aggregators = website.examples.filter((example) => {
      const domain = normalizeDomain(example);
      return domain !== null && AGGREGATOR_DOMAINS.has(domain);
    });
    if (aggregators.length === website.examples.length) {
      warnings.push({
        field: "website",
        message:
          `"${website.header}" looks like a directory or maps link rather than ` +
          `a company site. website_domain is generated from it, and it is what ` +
          `the demo builder and duplicate detection join on.`,
      });
    }
  }

  // --- coordinates that are not coordinates ---------------------------------
  const lat = stat("latitude");
  if (lat && numeric(lat.examples).some((n) => Math.abs(n) > 90)) {
    warnings.push({ field: "latitude", message: `"${lat.header}" has values outside -90 to 90.` });
  }
  const lng = stat("longitude");
  if (lng && numeric(lng.examples).some((n) => Math.abs(n) > 180)) {
    warnings.push({ field: "longitude", message: `"${lng.header}" has values outside -180 to 180.` });
  }

  // --- readiness ------------------------------------------------------------
  // A lead with no resolvable timezone is refused by the planner, by /write and
  // by a trigger that binds the service role. It imports cleanly and then sits
  // there, which is the failure this whole panel exists to pre-empt.
  const hasCoords = Boolean(mapping.latitude && mapping.longitude);
  const hasPlace = Boolean(mapping.city && mapping.state);
  if (!hasCoords && !hasPlace) {
    warnings.push({
      message:
        "No timezone can be resolved from this mapping, so these leads will " +
        "import but can never be scheduled. Map latitude and longitude, or " +
        "city and state.",
    });
  }

  if (!mapping.website) {
    warnings.push({
      message: "No website column, so no demos can be built for these leads.",
    });
  }

  if (!mapping.full_name && !mapping.first_name) {
    warnings.push({
      message:
        "No contact name, so these leads have no name on the /write screen and " +
        "no display name on the email.",
    });
  }

  return warnings;
}
