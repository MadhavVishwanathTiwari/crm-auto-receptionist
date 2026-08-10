import { NextResponse } from "next/server";

import { createServerSupabase } from "@/lib/supabase/server";

export const runtime = "nodejs";

/**
 * Where Google sends the browser back to. Exchanges the one-time code for a
 * session and drops the cookies.
 *
 * Public by way of middleware's PUBLIC_PATHS: there is no session yet when this
 * runs, so gating it would make signing in impossible.
 */
export async function GET(request: Request) {
  const url = new URL(request.url);

  // Behind Vercel the request URL is the internal origin, so the forwarded
  // headers are what the browser actually asked for. Getting this wrong sends
  // people to a hostname the session cookie was not set on.
  const forwardedHost = request.headers.get("x-forwarded-host");
  const forwardedProto = request.headers.get("x-forwarded-proto") ?? "https";
  const origin = forwardedHost
    ? `${forwardedProto}://${forwardedHost}`
    : url.origin;

  const fail = (message: string) =>
    NextResponse.redirect(
      `${origin}/login?error=${encodeURIComponent(message)}`,
    );

  // Google reports a refusal here — including the consent screen turning away
  // an account outside the Workspace.
  const providerError =
    url.searchParams.get("error_description") ?? url.searchParams.get("error");
  if (providerError) return fail(providerError);

  const code = url.searchParams.get("code");
  if (!code) return fail("That sign-in link was incomplete. Try again.");

  const supabase = await createServerSupabase();
  const { error } = await supabase.auth.exchangeCodeForSession(code);

  if (error) {
    // The allowlist trigger surfaces here, on the very first sign-in by an
    // address that is not listed. Its message is written to be read by a human.
    return fail(error.message);
  }

  const requested = url.searchParams.get("next");
  const next =
    requested && requested.startsWith("/") && !requested.startsWith("//")
      ? requested
      : "/leads";

  return NextResponse.redirect(`${origin}${next}`);
}
