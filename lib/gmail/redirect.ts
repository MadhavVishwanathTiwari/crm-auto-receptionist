// Shared between the two halves of the OAuth round trip.
//
// These live here rather than being exported from app/api/auth/google/start's
// route module because Next validates the export surface of a route file: a
// route may export HTTP verbs and a handful of config keys, and anything else
// fails the build.

import { requestOrigin } from "@/lib/requestOrigin";

export const OAUTH_STATE_COOKIE = "ar_google_oauth_state";

/** Scoped to the OAuth routes, so it is sent on the way back and nowhere else. */
export const OAUTH_STATE_COOKIE_PATH = "/api/auth/google";

/**
 * The redirect URI, derived from the origin the operator is standing on.
 *
 * This used to be built from NEXT_PUBLIC_SITE_URL, on the reasoning that Google
 * compares it character for character and a configured value cannot drift. The
 * reasoning was backwards. A configured value can point at a DIFFERENT HOST
 * than the one the request came from, and when production was deployed with a
 * local site URL the flow did exactly that: an operator clicked Connect on
 * crm.autoreceptionist.io, consented, and Google delivered the code to
 * 127.0.0.1:3000 on their own laptop. The state cookie was on the production
 * host, so the local server rejected it and dead-ended them on a login page.
 *
 * Deriving from the request makes that unrepresentable: you come back to the
 * host you left from. Both halves of the round trip derive it the same way, so
 * the authorization request and the token exchange always agree, which is the
 * one thing Google actually requires.
 *
 * The cost is that every origin must be registered in the Cloud console, which
 * was already true.
 */
export function googleRedirectUri(request: Request): string {
  return `${requestOrigin(request)}/api/auth/google/callback`;
}
