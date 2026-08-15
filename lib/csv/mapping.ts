// Mapping arbitrary CSV headers onto canonical lead fields.
//
// Two shapes feed this: the Clay enrichment export (source of truth for new
// leads) and the legacy outreach sheet we are replacing. Both are auto-mapped
// by header name and then shown for correction, so a wrong guess costs a click.

import {
  clean,
  cleanConfidence,
  cleanEmail,
  cleanInteger,
  cleanNumber,
  cleanRating,
  cleanVerification,
} from "./clean";
import { splitFullName } from "@/lib/normalize";

export type CanonicalField =
  | "place_id" | "company_name" | "full_name" | "first_name" | "last_name"
  | "middle_name" | "name_suffix"
  | "title" | "work_email"
  | "email_confidence" | "email_provider" | "verification"
  | "phone" | "website" | "gmaps_url"
  | "city" | "state" | "postal_code" | "country_code"
  | "latitude" | "longitude"
  | "industry" | "rating" | "reviews_count" | "employee_count"
  | "company_linkedin" | "company_instagram" | "company_facebook" | "company_twitter"
  | "personal_linkedin" | "personal_instagram" | "personal_facebook" | "personal_twitter"
  | "lead_score" | "angle_type" | "notes"
  | "lead_owner";

interface FieldSpec {
  field: CanonicalField;
  label: string;
  synonyms: string[];
  required?: boolean;
  /**
   * Synonyms that only apply once every field has had a chance at a real match.
   * `url` is the case this exists for: it means the company site in a bare CSV
   * and the Google Maps link in a Clay export, and the only thing telling those
   * apart is whether a better `website` column is also present.
   */
  weak?: string[];
  /**
   * Skip the containment pass for this spec. For a synonym that is a common
   * word, containment matches far more than it should — "confidence" is inside
   * "Use AI Confidence Reason", which is a prose paragraph and not a grade.
   */
  exact?: boolean;
}

export const FIELD_SPECS: FieldSpec[] = [
  { field: "work_email", label: "Work email", required: true,
    synonyms: ["work_email", "workemail", "email", "primary_email"] },
  { field: "company_name", label: "Company", required: true,
    synonyms: ["company_name", "company", "business_name", "organization"] },

  { field: "place_id", label: "Google place ID",
    synonyms: ["placeid", "place_id", "google_place_id"] },
  // "person_name" normalizes to 10 characters, so unlike "name" it clears the
  // containment floor below and catches an export that qualifies the column:
  // "Use AI Person Name", "decision_maker_person_name".
  { field: "full_name", label: "Full name",
    synonyms: ["full_name", "fullname", "name", "contact_name", "person_name"] },
  { field: "first_name", label: "First name", synonyms: ["first_name", "firstname"] },
  { field: "last_name", label: "Last name", synonyms: ["last_name", "lastname", "surname"] },
  // Normally derived by splitFullName rather than mapped. They are here so a
  // file that carries them as their own columns can still be mapped by hand.
  { field: "middle_name", label: "Middle name", synonyms: ["middle_name", "middlename"] },
  { field: "name_suffix", label: "Name suffix", synonyms: ["name_suffix", "namesuffix", "suffix"] },
  // Person's job title. Both supported shapes carry company_name separately, so
  // this is never the business name — unlike a raw Apify export, where `title`
  // IS the business.
  { field: "title", label: "Job title", synonyms: ["title", "job_title", "jobtitle", "role"] },

  // There is deliberately nowhere to put a second address. Clay's email_1/2/3
  // and likely_email used to import "for reference" and were never read by
  // anything — they were columns whose entire contract was that nobody may use
  // them. Their values are still in `leads.raw` if a question ever needs one.
  //
  // The scraped ones were mostly noise anyway: webmaster addresses, a website
  // builder's support desk, and placeholders like example@domain.com lifted off
  // an unedited template.

  { field: "email_confidence", label: "Email confidence", exact: true,
    synonyms: ["confidence", "email_confidence"] },
  { field: "email_provider", label: "Email provider",
    synonyms: ["email_provider", "esp", "provider"] },
  { field: "verification", label: "Verification",
    synonyms: ["verification", "verified", "email_status"] },

  { field: "phone", label: "Phone", synonyms: ["phone", "phone_number", "telephone", "mobile"] },
  // `url` is weak on both, and website is listed first, so it falls to whichever
  // of the two has nothing better. A Clay export carrying `url` alongside a real
  // `website` column means the Google Maps link by it; a bare CSV means the site.
  // Getting this backwards is expensive: website_domain is generated from
  // website, a maps link normalizes to google.com, and that is the join key the
  // demo builder and near-duplicate detection both use.
  { field: "website", label: "Website", weak: ["url"],
    synonyms: ["website", "site", "domain", "scrape_website", "company_website"] },
  { field: "gmaps_url", label: "Google Maps URL", weak: ["url"],
    synonyms: ["gmaps_url", "gmapsurl", "google_maps_url", "maps_url"] },

  { field: "city", label: "City", synonyms: ["city", "town", "locality"] },
  { field: "state", label: "State", synonyms: ["state", "region", "province"] },
  { field: "postal_code", label: "Postal code",
    synonyms: ["postal_code", "postalcode", "zip", "zip_code"] },
  { field: "country_code", label: "Country", synonyms: ["country_code", "countrycode", "country"] },

  // Not in either documented shape yet. Carried through from the scraper so
  // timezone resolution is free and offline instead of a paid place_id lookup.
  { field: "latitude", label: "Latitude", synonyms: ["latitude", "lat"] },
  { field: "longitude", label: "Longitude", synonyms: ["longitude", "lng", "lon", "long"] },

  { field: "industry", label: "Industry",
    synonyms: ["category_name", "categoryname", "industry", "category", "vertical"] },
  { field: "rating", label: "Rating",
    synonyms: ["total_score", "totalscore", "rating", "stars", "google_rating"] },
  { field: "reviews_count", label: "Reviews",
    synonyms: ["reviews_count", "reviewscount", "review_count", "reviews"] },
  { field: "employee_count", label: "Employees",
    synonyms: ["employee_count", "employeecount", "employees", "headcount"] },

  { field: "company_linkedin", label: "Company LinkedIn", synonyms: ["company_linkedin"] },
  { field: "company_instagram", label: "Company Instagram", synonyms: ["company_instagram"] },
  { field: "company_facebook", label: "Company Facebook", synonyms: ["company_facebook"] },
  { field: "company_twitter", label: "Company Twitter", synonyms: ["company_twitter"] },
  { field: "personal_linkedin", label: "Personal LinkedIn", synonyms: ["personal_linkedin"] },
  { field: "personal_instagram", label: "Personal Instagram", synonyms: ["personal_instagram"] },
  { field: "personal_facebook", label: "Personal Facebook", synonyms: ["personal_facebook"] },
  { field: "personal_twitter", label: "Personal Twitter", synonyms: ["personal_twitter"] },

  { field: "lead_score", label: "Lead score", synonyms: ["lead_score", "leadscore", "score"] },
  { field: "angle_type", label: "Angle", synonyms: ["angle_type", "angle"] },
  { field: "notes", label: "Notes", synonyms: ["notes", "note", "comments"] },

  // Not a column on `leads`. It is an operator's address, and ownership lives
  // in claimed_by, which is guarded — so mapRow returns it alongside the values
  // rather than in them, and commitImport hands it to assign_lead_owners()
  // after the insert. Listed here so it appears in the mapping UI like any
  // other column and can be pointed at a differently-named header.
  { field: "lead_owner", label: "Lead owner (claims the lead)",
    synonyms: ["lead_owner", "leadowner", "owner", "assigned_to", "assignee"] },
];

/** Lowercase, strip everything that is not alphanumeric. */
function normalizeHeader(header: string): string {
  return header.toLowerCase().replace(/[^a-z0-9]/g, "");
}

export type ColumnMapping = Partial<Record<CanonicalField, string>>;

/**
 * Best-effort mapping of headers onto canonical fields.
 *
 * Exact normalized match first, then a containment match, and every header is
 * claimed at most once — otherwise a header like `email_provider` would satisfy
 * work_email's `email` synonym as readily as its own, and the send target would
 * be whichever spec happened to ask first.
 */
export function autoMapColumns(headers: string[]): ColumnMapping {
  const mapping: ColumnMapping = {};
  const taken = new Set<string>();
  const normalized = headers.map((h) => ({ header: h, key: normalizeHeader(h) }));

  const claim = (field: CanonicalField, hit?: { header: string }) => {
    if (!hit) return;
    mapping[field] = hit.header;
    taken.add(hit.header);
  };

  for (const spec of FIELD_SPECS) {
    const keys = spec.synonyms.map(normalizeHeader);

    let hit = normalized.find(
      (h) => !taken.has(h.header) && keys.includes(h.key),
    );

    if (!hit && !spec.exact) {
      // Containment runs ONE WAY ONLY: the header must contain the synonym, not
      // the reverse. Matching a header that is a substring of a synonym lets a
      // generic name win a specific column — "full_name" has the synonym
      // "name", and "firstname" contains it, so the reverse rule silently
      // mapped first_name onto full_name and left first_name unmapped.
      // The length floor keeps short synonyms ("lat", "url") to exact matches.
      hit = normalized.find(
        (h) =>
          !taken.has(h.header) &&
          keys.some((k) => k.length >= 5 && h.key.includes(k)),
      );
    }

    claim(spec.field, hit);
  }

  // Weak synonyms run in a pass of their own, after every field has had both of
  // its real chances. That ordering is the whole mechanism: a header only falls
  // to a weak match when nothing claimed it on merit, and within this pass
  // FIELD_SPECS order breaks the tie, so `website` takes `url` in a file that
  // has no better column and `gmaps_url` takes it in a file that does.
  for (const spec of FIELD_SPECS) {
    if (!spec.weak || mapping[spec.field]) continue;
    const keys = spec.weak.map(normalizeHeader);
    claim(
      spec.field,
      normalized.find((h) => !taken.has(h.header) && keys.includes(h.key)),
    );
  }

  return mapping;
}

export type CsvShape = "clay" | "legacy_sheet" | "custom";

export function detectShape(headers: string[]): CsvShape {
  const keys = new Set(headers.map(normalizeHeader));
  // Columns unique to each export, rather than ones both happen to share.
  if (keys.has("placeid") || keys.has("enrichcompany") || keys.has("scrapewebsite")) {
    return "clay";
  }
  if (keys.has("istrange") || keys.has("leadowner") || keys.has("demotxt")) {
    return "legacy_sheet";
  }
  return "custom";
}

export interface MappedLead {
  values: Record<string, unknown>;
  /** Canonical fields whose raw value was junk and became null. */
  cleanedFields: string[];
  /** Blocking problems. A row with any of these cannot be inserted. */
  errors: string[];
  /**
   * The operator this row already belongs to, if the file names one.
   *
   * Kept out of `values` on purpose: there is no such column on `leads`, and
   * ownership is guarded — assign_lead_owners() writes it after the insert.
   * Never a blocking error, because an address nobody recognises should still
   * produce the lead.
   */
  ownerEmail: string | null;
}

/**
 * Turns one CSV row into a lead payload.
 *
 * Deliberately does NOT compute work_email_norm, phone_e164 or website_domain:
 * those are generated columns, so the database is the only thing that decides
 * what a dedupe key is.
 */
export function mapRow(
  row: Record<string, string>,
  mapping: ColumnMapping,
): MappedLead {
  const cleanedFields: string[] = [];
  const errors: string[] = [];

  const raw = (field: CanonicalField): string | undefined => {
    const header = mapping[field];
    return header === undefined ? undefined : row[header];
  };

  const text = (field: CanonicalField): string | null => {
    const source = raw(field);
    if (source === undefined) return null;
    const value = clean(source);
    if (value === null && source.trim() !== "") cleanedFields.push(field);
    return value;
  };

  const values: Record<string, unknown> = {
    place_id: text("place_id"),
    company_name: text("company_name"),
    title: text("title"),

    work_email: cleanEmail(raw("work_email")),
    email_confidence: cleanConfidence(raw("email_confidence")),
    email_provider: text("email_provider"),
    verification: cleanVerification(raw("verification")),

    phone: text("phone"),
    website: text("website"),
    gmaps_url: text("gmaps_url"),

    city: text("city"),
    state: text("state"),
    postal_code: text("postal_code"),
    country_code: text("country_code") ?? "US",
    latitude: cleanNumber(raw("latitude")),
    longitude: cleanNumber(raw("longitude")),

    industry: text("industry"),
    rating: cleanRating(raw("rating")),
    reviews_count: cleanInteger(raw("reviews_count")),
    employee_count: cleanInteger(raw("employee_count")),

    company_linkedin: text("company_linkedin"),
    company_instagram: text("company_instagram"),
    company_facebook: text("company_facebook"),
    company_twitter: text("company_twitter"),
    personal_linkedin: text("personal_linkedin"),
    personal_instagram: text("personal_instagram"),
    personal_facebook: text("personal_facebook"),
    personal_twitter: text("personal_twitter"),

    lead_score: cleanInteger(raw("lead_score")),
    notes: text("notes"),
  };

  // Clay joins the name; the legacy sheet splits it. Explicit columns win, and
  // full_name only fills the gaps. A file that names first or last is treated as
  // having split the name itself, so the middle and suffix the splitter found in
  // a full_name column are not mixed in with them — but an explicit column for
  // either still wins outright.
  const first = text("first_name");
  const last = text("last_name");
  const middle = text("middle_name");
  const suffix = text("name_suffix");
  const preSplit = Boolean(first || last);
  const split = splitFullName(text("full_name"));
  values.first_name = first ?? split.firstName;
  values.last_name = last ?? split.lastName;
  values.middle_name = middle ?? (preSplit ? null : split.middleName);
  values.name_suffix = suffix ?? (preSplit ? null : split.suffix);

  const angle = text("angle_type")?.toLowerCase().replace(/[\s-]+/g, "_");
  values.angle_type =
    angle === "soft_text_audit" || angle === "voicemail_drop_audit" ? angle : null;

  if (!values.work_email) {
    // work_email is the only send target, so a row without one can never be
    // outreached and is not worth a database row.
    errors.push("no usable work_email");
  }
  if (!values.company_name) {
    errors.push("no company_name");
  }

  return { values, cleanedFields, errors, ownerEmail: cleanEmail(raw("lead_owner")) };
}
