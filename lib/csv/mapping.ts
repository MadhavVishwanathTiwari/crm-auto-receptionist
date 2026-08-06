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
  | "title" | "work_email" | "email_1" | "email_2" | "email_3" | "likely_email"
  | "email_confidence" | "email_provider" | "verification"
  | "phone" | "website" | "gmaps_url"
  | "city" | "state" | "postal_code" | "country_code"
  | "latitude" | "longitude"
  | "industry" | "rating" | "reviews_count" | "employee_count"
  | "company_linkedin" | "company_instagram" | "company_facebook" | "company_twitter"
  | "personal_linkedin" | "personal_instagram" | "personal_facebook" | "personal_twitter"
  | "lead_score" | "angle_type" | "notes";

interface FieldSpec {
  field: CanonicalField;
  label: string;
  synonyms: string[];
  required?: boolean;
}

export const FIELD_SPECS: FieldSpec[] = [
  { field: "work_email", label: "Work email", required: true,
    synonyms: ["work_email", "workemail", "email", "primary_email"] },
  { field: "company_name", label: "Company", required: true,
    synonyms: ["company_name", "company", "business_name", "organization"] },

  { field: "place_id", label: "Google place ID",
    synonyms: ["placeid", "place_id", "google_place_id"] },
  { field: "full_name", label: "Full name",
    synonyms: ["full_name", "fullname", "name", "contact_name"] },
  { field: "first_name", label: "First name", synonyms: ["first_name", "firstname"] },
  { field: "last_name", label: "Last name", synonyms: ["last_name", "lastname", "surname"] },
  // Person's job title. Both supported shapes carry company_name separately, so
  // this is never the business name — unlike a raw Apify export, where `title`
  // IS the business.
  { field: "title", label: "Job title", synonyms: ["title", "job_title", "jobtitle", "role"] },

  // Imported for reference only. work_email is the sole send target; nothing in
  // the scheduler or the Gmail layer reads these.
  { field: "email_1", label: "Email 1 (reference)", synonyms: ["email_1", "email1"] },
  { field: "email_2", label: "Email 2 (reference)", synonyms: ["email_2", "email2"] },
  { field: "email_3", label: "Email 3 (reference)", synonyms: ["email_3", "email3"] },
  { field: "likely_email", label: "Likely email (reference)",
    synonyms: ["likely_email", "likelyemail", "guessed_email"] },

  { field: "email_confidence", label: "Email confidence",
    synonyms: ["confidence", "email_confidence"] },
  { field: "email_provider", label: "Email provider",
    synonyms: ["email_provider", "esp", "provider"] },
  { field: "verification", label: "Verification",
    synonyms: ["verification", "verified", "email_status"] },

  { field: "phone", label: "Phone", synonyms: ["phone", "phone_number", "telephone", "mobile"] },
  { field: "website", label: "Website",
    synonyms: ["website", "site", "url", "domain", "scrape_website", "company_website"] },
  { field: "gmaps_url", label: "Google Maps URL",
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
 * claimed at most once — otherwise "email" would win work_email, email_1 and
 * likely_email simultaneously.
 */
export function autoMapColumns(headers: string[]): ColumnMapping {
  const mapping: ColumnMapping = {};
  const taken = new Set<string>();
  const normalized = headers.map((h) => ({ header: h, key: normalizeHeader(h) }));

  for (const spec of FIELD_SPECS) {
    const keys = spec.synonyms.map(normalizeHeader);

    let hit = normalized.find(
      (h) => !taken.has(h.header) && keys.includes(h.key),
    );

    if (!hit) {
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

    if (hit) {
      mapping[spec.field] = hit.header;
      taken.add(hit.header);
    }
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
    email_1: cleanEmail(raw("email_1")),
    email_2: cleanEmail(raw("email_2")),
    email_3: cleanEmail(raw("email_3")),
    likely_email: cleanEmail(raw("likely_email")),
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
  // full_name only fills the gaps.
  const first = text("first_name");
  const last = text("last_name");
  const split = splitFullName(text("full_name"));
  values.first_name = first ?? split.firstName;
  values.last_name = last ?? split.lastName;
  values.middle_name = first || last ? null : split.middleName;
  values.name_suffix = first || last ? null : split.suffix;

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

  return { values, cleanedFields, errors };
}
