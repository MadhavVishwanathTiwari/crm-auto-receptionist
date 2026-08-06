// Mirror of app.normalize_phone() in supabase/migrations/0001_foundations.sql.
//
// NANP (US/CA) only, which is the entire ICP. This is hand-written rather than
// libphonenumber-js because the SQL side backs a generated column and Postgres
// only allows IMMUTABLE expressions there — a JS library cannot participate.
// Revisit only if non-NANP leads appear.

export function normalizePhone(
  input: string | null | undefined,
): string | null {
  const digits = (input ?? "").replace(/[^0-9]/g, "");

  // NANP area codes and exchange codes never begin with 0 or 1, so this also
  // rejects ten digits of junk (extensions, zip+phone concatenations, IDs).
  const startsValid = (c: string | undefined) =>
    c !== undefined && c >= "2" && c <= "9";

  if (digits.length === 10 && startsValid(digits[0])) {
    return "+1" + digits;
  }
  if (digits.length === 11 && digits[0] === "1" && startsValid(digits[1])) {
    return "+" + digits;
  }
  return null;
}
