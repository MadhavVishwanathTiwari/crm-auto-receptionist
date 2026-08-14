import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

import { publicEnv } from "@/lib/env";

const PUBLIC_PATHS = ["/login", "/auth"];

export async function middleware(request: NextRequest) {
  let response = NextResponse.next({ request });

  const supabase = createServerClient(
    publicEnv.supabaseUrl,
    publicEnv.supabasePublishableKey,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          for (const { name, value } of cookiesToSet) {
            request.cookies.set(name, value);
          }
          response = NextResponse.next({ request });
          for (const { name, value, options } of cookiesToSet) {
            response.cookies.set(name, value, options);
          }
        },
      },
    },
  );

  // getClaims(), not getSession() and no longer getUser().
  //
  // getSession() is still the wrong call: it trusts the cookie as-is, and this
  // is the gate for every protected page. getUser() was the safe answer but it
  // is an HTTP round trip to the auth server on every single request, and
  // middleware runs at the edge PoP nearest the operator rather than in the
  // function region, so it is the one call colocating the functions cannot
  // help.
  //
  // getClaims() is safe AND cheap. It calls getSession() first, so the session
  // is still refreshed and the cookie still rotated here exactly as before,
  // then verifies the JWT signature locally against the project's JWKS, which
  // the client caches. A project still signing with the legacy shared HS256
  // secret has no public key to verify against, so it falls back to getUser()
  // on its own: identical behaviour to what this replaced, never worse.
  const { data } = await supabase.auth.getClaims();
  const user = data?.claims ?? null;

  const { pathname } = request.nextUrl;
  const isPublic = PUBLIC_PATHS.some(
    (p) => pathname === p || pathname.startsWith(p + "/"),
  );

  if (!user && !isPublic) {
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    url.searchParams.set("next", pathname);
    return NextResponse.redirect(url);
  }

  if (user && pathname === "/login") {
    const url = request.nextUrl.clone();
    url.pathname = "/write";
    url.search = "";
    return NextResponse.redirect(url);
  }

  return response;
}

export const config = {
  matcher: [
    // Everything except static assets and API routes. API routes authenticate
    // themselves — cron and demo-ingest present a bearer secret and have no
    // user session, so redirecting them to /login would break them.
    "/((?!_next/static|_next/image|favicon.ico|api/|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)",
  ],
};
