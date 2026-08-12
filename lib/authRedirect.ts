/**
 * Where to send someone after a successful sign-in.
 *
 * Only ever a same-site path. An absolute URL in `?next` would turn the login
 * page into an open redirect, and `//evil.com` is a protocol-relative URL that
 * a naive startsWith("/") check lets straight through.
 *
 * /login is excluded because Supabase's Site URL fallback can point at it, and
 * forwarding back to the page that just forwarded here is an infinite loop.
 */
export function safeNextPath(
  value: string | null | undefined,
  fallback = "/leads",
): string {
  if (!value) return fallback;
  if (!value.startsWith("/") || value.startsWith("//")) return fallback;
  if (value === "/login" || value.startsWith("/login?")) return fallback;
  return value;
}

/** First value of a Next.js searchParams entry. */
export function firstParam(
  value: string | string[] | undefined,
): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}
