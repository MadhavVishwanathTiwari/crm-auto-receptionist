// Mirror of app.normalize_domain() in supabase/migrations/0001_foundations.sql.
//
// This is the primary join key for demo ingest, so it must agree with
// domainKey() in the Auto-Receptionist repo (scripts/lib/sheet-rows.mjs:10) —
// that repo has no place_id, derives slugs from the hostname, and has nine
// legacy demos whose slugs do not match their domain. Domain is the only key
// both sides can compute reliably.

export function normalizeDomain(
  input: string | null | undefined,
): string | null {
  let s = (input ?? "").trim().toLowerCase();

  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\/(?:[^@/]*@)?/, ""); // scheme:// and user@
  s = s.replace(/[/?#].*$/, ""); // path, query, fragment
  s = s.replace(/:[0-9]+$/, ""); // port
  s = s.replace(/^www\./, ""); // leading www.
  s = s.replace(/\.$/, ""); // trailing FQDN root dot

  return s === "" ? null : s;
}
