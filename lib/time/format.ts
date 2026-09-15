// An instant, written the way the person reading the screen would say it.
//
// Every screen used to format with whatever the runtime had: the server renders
// on Vercel in UTC with an en-US locale, the browser in IST with en-IN. So each
// time went out in UTC, flashed, and then either changed under the reader or
// threw React's hydration error #418 because the two renders disagreed. The
// server-rendered "Recent imports" on /import never corrected at all.
//
// The fix is to never ask the runtime. The zone comes from the `op_tz` cookie,
// which the browser writes (app/(app)/ViewerZone.tsx) and the server reads
// (lib/time/zone.ts), and the locale is fixed. Given the same instant and the
// same zone, both sides produce the same string, byte for byte.
//
// Prospect-local times are not this file's business: those are stored as a
// wall clock and formatted as one (theirTime() in WriteClient, QueuedSends).
//
// Plain module: imported by server and client components alike.

import { DateTime } from "luxon";

/** The cookie holding the operator's IANA zone. */
export const ZONE_COOKIE = "op_tz";

/**
 * Never the runtime's. The patterns below set the order (day first, which is
 * how both operators read); the locale only supplies month and weekday names.
 * en-US because its names are stable: en-GB's September is "Sep" in some ICU
 * versions and "Sept" in newer ones, and a server and a browser a CLDR release
 * apart would disagree about it, which is the hydration error all over again.
 */
const LOCALE = "en-US";

const FORMATS = {
  /** "Tue 15 Sep, 18:40" -- the style /write has always used. */
  datetime: "ccc d LLL, HH:mm",
  /** "15 Sep 2026" */
  date: "d LLL yyyy",
  /** For a datetime-local input's value. */
  input: "yyyy-LL-dd'T'HH:mm",
} as const;

export type YourStyle = keyof typeof FORMATS;

/**
 * An instant in the reader's own zone.
 *
 * With no zone yet -- a browser's very first visit, before ViewerZone has
 * written the cookie and refreshed -- it renders an ellipsis rather than a UTC
 * time. A wrong time that looks right is worse than a moment of nothing.
 */
export function formatYours(
  iso: string | null | undefined,
  zone: string | null,
  style: YourStyle = "datetime",
): string {
  if (!iso) return "";
  if (!zone) return style === "input" ? "" : "…";

  const at = DateTime.fromISO(iso, { zone, locale: LOCALE });
  return at.isValid ? at.toFormat(FORMATS[style]) : "";
}

/**
 * A datetime-local input's value, read in the reader's zone, as an ISO instant.
 *
 * The inverse of formatYours(…, "input"). `new Date(value)` would read it in
 * whatever zone the runtime is in, which is the same mistake in reverse. With no
 * zone yet it falls back to the runtime's, which is the zone the input showed.
 */
export function fromYourInput(value: string, zone: string | null): string | null {
  if (!value) return null;
  const at = DateTime.fromISO(value, zone ? { zone } : {});
  return at.isValid ? at.toUTC().toISO() : null;
}

/**
 * "3 days ago", measured from the moment the server rendered the page.
 *
 * Not from now: the browser hydrates some seconds after the server rendered,
 * and "59 minutes ago" becoming "1 hour ago" in between is a hydration error.
 */
export function relativeTo(iso: string | null | undefined, base: string): string {
  if (!iso) return "";
  const at = DateTime.fromISO(iso);
  if (!at.isValid) return "";
  return at.toRelative({ base: DateTime.fromISO(base), locale: LOCALE }) ?? "";
}

/** A count, grouped the same way on both sides. */
export function formatCount(value: number): string {
  return value.toLocaleString(LOCALE);
}
