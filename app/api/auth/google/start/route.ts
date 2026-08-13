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
  siteUrlProblem,
} from "@/lib/gmail/redirect";
import { getOrgContext } from "@/lib/org";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const context = await getOrgContext();
  if (!context) {
    return NextResponse.redirect(new URL("/login", request.url));
  }

  const env = serverEnv();
  if (!env.googleOAuthClientId || !env.googleOAuthClientSecret) {
    return NextResponse.redirect(
      new URL("/mailboxes?error=google_not_configured", request.url),
    );
  }
  const siteProblem = siteUrlProblem();
  if (siteProblem) {
    return NextResponse.redirect(
      new URL(
        siteProblem === "missing"
          ? "/mailboxes?error=site_url_not_configured"
          : "/mailboxes?error=site_url_has_no_scheme",
        request.url,
      ),
    );
  }

  // CSRF for the round trip. Google echoes `state` back verbatim, and the
  // callback refuses anything that does not match this cookie, so a link
  // someone else crafted cannot attach a mailbox to this org.
  const state = randomBytes(32).toString("base64url");

  const url = buildAuthUrl({
    clientId: env.googleOAuthClientId,
    redirectUri: googleRedirectUri(),
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
    secure: env.siteUrl.startsWith("https://"),
    path: OAUTH_STATE_COOKIE_PATH,
    maxAge: 600,
  });

  return response;
}
