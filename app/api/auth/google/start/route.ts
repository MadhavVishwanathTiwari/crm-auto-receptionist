// Step one of connecting a sending mailbox: send the operator to Google.
//
// No service role here. This route only needs to know who is asking, which the
// cookie-bound client answers, and CLAUDE.md's exemption covers the callback
// alone.

import { randomBytes } from "node:crypto";

import { NextResponse } from "next/server";

import { serverEnv } from "@/lib/env";
import { buildAuthUrl } from "@/lib/gmail/oauth";
import {
  googleRedirectUri,
  OAUTH_STATE_COOKIE,
  OAUTH_STATE_COOKIE_PATH,
} from "@/lib/gmail/redirect";
import { getOrgContext } from "@/lib/org";
import { requestOrigin } from "@/lib/requestOrigin";

export const runtime = "nodejs";

export async function GET(request: Request) {
  // Everything this route emits is anchored to the origin the browser is
  // actually on, never to a configured one. Sending an operator back to a
  // different host than the one they clicked from is the failure this whole
  // flow is built to avoid.
  const origin = requestOrigin(request);

  const context = await getOrgContext();
  if (!context) {
    return NextResponse.redirect(`${origin}/login`);
  }

  const env = serverEnv();
  if (!env.googleOAuthClientId || !env.googleOAuthClientSecret) {
    return NextResponse.redirect(`${origin}/mailboxes?error=google_not_configured`);
  }

  // CSRF for the round trip. Google echoes `state` back verbatim, and the
  // callback refuses anything that does not match this cookie, so a link
  // someone else crafted cannot attach a mailbox to this org.
  const state = randomBytes(32).toString("base64url");

  const url = buildAuthUrl({
    clientId: env.googleOAuthClientId,
    redirectUri: googleRedirectUri(request),
    state,
    // The address they signed in with is nearly always the one they want to
    // connect. Still only a hint: the chooser can override it, which is why the
    // callback asks Google which mailbox the grant is actually for.
    loginHint: context.email,
  });

  // The cookie is set on the redirect itself rather than through cookies(),
  // so there is no question about whether the mutation reaches this response.
  const response = NextResponse.redirect(url);
  response.cookies.set(OAUTH_STATE_COOKIE, state, {
    httpOnly: true,
    sameSite: "lax", // must survive the redirect back from accounts.google.com
    // From the real scheme, not from configuration. A Secure cookie set over
    // plain http is dropped silently, which would surface as state_mismatch.
    secure: origin.startsWith("https://"),
    path: OAUTH_STATE_COOKIE_PATH,
    // Ten minutes was too tight: the consent screen involves choosing an
    // account and reading a scope list, and an expired cookie is
    // indistinguishable from a forged one.
    maxAge: 1800,
  });

  return response;
}
