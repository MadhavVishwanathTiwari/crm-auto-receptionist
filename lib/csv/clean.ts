// Cleaning the junk Clay writes into data columns.
//
// Clay reports enrichment status inside the value itself: `enrich_company` and
// `scrape_website` come back as "❌ Company Not Found" or "✅ http://acme.com".
// Imported raw, the first becomes a company literally named "❌ Company Not
// Found" and the second a website nothing can parse. `decision_maker_contact`
// arrived in the sample as the literal word "Response".
//
// Everything here returns null rather than "", so a missing value is missing in
// exactly one way and `coalesce` behaves.

const FAILURE_MARK = "❌"; // ❌
const SUCCESS_MARK = "✅"; // ✅

/** Values that mean "nothing", whatever the tool that wrote them intended. */
const NULLISH = new Set([
  "",
  "-",
  "--",
  "n/a",
  "na",
  "#n/a",
  "null",
  "undefined",
  "none",
  "not found",
  "no data",
  "unknown",
]);

export interface CleanResult {
  value: string | null;
  /** True when cleaning changed the value, so the import report can show it. */
  cleaned: boolean;
}

export function cleanValue(raw: unknown): CleanResult {
  if (raw === null || raw === undefined) return { value: null, cleaned: false };

  const original = String(raw);
  let s = original.trim();

  if (s.startsWith(FAILURE_MARK)) {
    // A failure marker means the enrichment did not find anything. The text
    // after it is an error message, not data.
    return { value: null, cleaned: true };
  }

  if (s.startsWith(SUCCESS_MARK)) {
    s = s.slice(SUCCESS_MARK.length).trim();
  }

  if (NULLISH.has(s.toLowerCase())) {
    return { value: null, cleaned: s !== "" };
  }

  return { value: s, cleaned: s !== original };
}

/** Convenience for callers that only want the value. */
export function clean(raw: unknown): string | null {
  return cleanValue(raw).value;
}

export function cleanNumber(raw: unknown): number | null {
  const value = clean(raw);
  if (value === null) return null;
  // Strip thousands separators and stray currency/percent decoration.
  const n = Number(value.replace(/[,\s]/g, "").replace(/[^0-9.+-]/g, ""));
  return Number.isFinite(n) ? n : null;
}

export function cleanInteger(raw: unknown): number | null {
  const n = cleanNumber(raw);
  return n === null ? null : Math.trunc(n);
}

/** Google ratings are 0-5. Anything outside that is not a rating. */
export function cleanRating(raw: unknown): number | null {
  const n = cleanNumber(raw);
  if (n === null || n < 0 || n > 5) return null;
  return Math.round(n * 10) / 10;
}

const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Only returns something that is actually an address. Clay puts status text in
 * email columns ("Response"), and importing that would create a lead whose send
 * target is a word.
 */
export function cleanEmail(raw: unknown): string | null {
  const value = clean(raw);
  if (value === null) return null;
  return EMAIL_SHAPE.test(value) ? value.toLowerCase() : null;
}

const CONFIDENCE_MAP: Record<string, "high" | "medium" | "low"> = {
  high: "high",
  "very high": "high",
  medium: "medium",
  med: "medium",
  moderate: "medium",
  low: "low",
  "very low": "low",
};

export function cleanConfidence(
  raw: unknown,
): "high" | "medium" | "low" | "unknown" {
  const value = clean(raw);
  if (value === null) return "unknown";
  return CONFIDENCE_MAP[value.toLowerCase()] ?? "unknown";
}

const VERIFICATION_MAP: Record<
  string,
  "verified" | "unverified" | "catch_all" | "invalid"
> = {
  verified: "verified",
  valid: "verified",
  ok: "verified",
  unverified: "unverified",
  pending: "unverified",
  "catch all": "catch_all",
  catch_all: "catch_all",
  "catch-all": "catch_all",
  accept_all: "catch_all",
  invalid: "invalid",
  bounced: "invalid",
};

export function cleanVerification(
  raw: unknown,
): "verified" | "unverified" | "catch_all" | "invalid" | "unknown" {
  const value = clean(raw);
  if (value === null) return "unknown";
  return VERIFICATION_MAP[value.toLowerCase()] ?? "unknown";
}
