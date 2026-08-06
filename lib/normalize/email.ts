// Mirror of app.normalize_email() in supabase/migrations/0001_foundations.sql.
//
// Two implementations exist because the SQL one backs a generated column (which
// must be IMMUTABLE SQL) while the TS one groups rows in-memory during import,
// before anything is written. tests/unit/normalize-parity.test.ts runs the same
// vectors through both and asserts they agree — that test is the only thing
// keeping them honest, so do not change one of these without the other.

/**
 * Providers known to treat `+tag` as an alias of the base address.
 *
 * Stripping `+` on an arbitrary corporate domain would be a guess, and the two
 * errors are not symmetric: a FALSE duplicate silently discards a real lead,
 * whereas a MISSED duplicate merely surfaces in the review queue. So we only
 * strip where the provider documents the behaviour.
 */
const PLUS_ADDRESSING_PROVIDERS = new Set([
  "gmail.com",
  "googlemail.com",
  "outlook.com",
  "hotmail.com",
  "live.com",
  "msn.com",
  "yahoo.com",
  "ymail.com",
  "fastmail.com",
  "proton.me",
  "protonmail.com",
  "icloud.com",
]);

export function normalizeEmail(input: string | null | undefined): string | null {
  const raw = (input ?? "").trim().toLowerCase();

  // Matches Postgres split_part(): part 1 is everything before the first "@",
  // part 2 is everything between the first and second "@".
  const parts = raw.split("@");
  let local = parts[0] ?? "";
  const domain = parts[1] ?? "";

  if (local === "" || domain === "") return null;

  if (PLUS_ADDRESSING_PROVIDERS.has(domain)) {
    local = local.split("+")[0] ?? "";
  }

  // Gmail also ignores dots in the local part, and googlemail.com is the same
  // mailbox as gmail.com.
  if (domain === "gmail.com" || domain === "googlemail.com") {
    return local.replaceAll(".", "") + "@gmail.com";
  }

  return local + "@" + domain;
}

/**
 * Shape check only. Deliberately not an RFC 5322 validator — the goal is to
 * reject junk that Clay put in an email column, not to adjudicate exotic but
 * legal addresses.
 */
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function isValidEmail(input: string | null | undefined): boolean {
  return typeof input === "string" && EMAIL_SHAPE.test(input.trim());
}
