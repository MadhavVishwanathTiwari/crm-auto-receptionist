// Shared between the two halves of the OAuth round trip.
//
// These live here rather than being exported from app/api/auth/google/start's
// route module because Next validates the export surface of a route file: a
// route may export HTTP verbs and a handful of config keys, and anything else
// fails the build.

import { serverEnv } from "@/lib/env";

export const OAUTH_STATE_COOKIE = "ar_google_oauth_state";

/** Scoped to the OAuth routes, so it is sent on the way back and nowhere else. */
export const OAUTH_STATE_COOKIE_PATH = "/api/auth/google";

/**
 * The registered redirect URI.
 *
 * Built from configuration rather than from the incoming request: Google
 * compares it character for character against the value in the Cloud console,
 * and a proxy, a preview deployment or a trailing slash would each break it in
 * a way that only shows up at the end of the flow.
 */
export function googleRedirectUri(): string {
  return `${serverEnv().siteUrl}/api/auth/google/callback`;
}

/**
 * Why NEXT_PUBLIC_SITE_URL cannot be used, or null if it is fine.
 *
 * Checked before the flow starts rather than after. A value with no scheme
 * (`crm.autoreceptionist.io` instead of `https://crm.autoreceptionist.io`) is
 * the failure worth naming: it concatenates into something that looks like a
 * URL, Google rejects it as redirect_uri_mismatch several redirects later, and
 * the error surfaces on Google's own error page rather than in this app.
 */
export function siteUrlProblem(): "missing" | "no_scheme" | null {
  const raw = serverEnv().siteUrl;
  if (!raw) return "missing";

  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return "no_scheme";
    }
  } catch {
    return "no_scheme";
  }

  return null;
}
