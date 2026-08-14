import "server-only";

import { redirect } from "next/navigation";
import { cache } from "react";

import { createServerSupabase } from "@/lib/supabase/server";

export type OrgRole = "admin" | "member";

export interface AuthUser {
  id: string;
  email: string | null;
}

/**
 * Who is signed in, verified, once per request.
 *
 * getClaims() rather than getUser(). getUser() is an HTTP call to the auth
 * server on every invocation, and the note this replaces was right that
 * getSession() is the wrong way to make it cheap: getSession() trusts the
 * cookie as-is. getClaims() is the third option and it is the correct one. It
 * still calls getSession() first, so the session is refreshed and the cookie
 * rotated exactly as before, and then it VERIFIES the JWT signature locally
 * against the project's JWKS (cached in the client) whenever the project signs
 * asymmetrically. On a project still using the legacy shared HS256 secret there
 * is no key to verify against, so it falls back to getUser() — same behaviour
 * and same cost as before, never worse.
 *
 * Wrapped in cache() so the layout, the page and any server component below
 * them share one answer instead of asking the network each.
 */
export const getAuthUser = cache(async (): Promise<AuthUser | null> => {
  const supabase = await createServerSupabase();

  const { data } = await supabase.auth.getClaims();
  const claims = data?.claims;
  if (!claims) return null;

  return { id: claims.sub, email: claims.email ?? null };
});

export interface OrgContext {
  supabase: Awaited<ReturnType<typeof createServerSupabase>>;
  userId: string;
  email: string | null;
  orgId: string;
  role: OrgRole;
}

/**
 * The signed-in user plus the single org they belong to.
 *
 * Every page and route needs the same three facts, and every one of them needs
 * org_id explicitly: RLS proves a write is *permitted*, but INSERT still has to
 * name the org, and a policy with `with check (org_id = app.current_org_id())`
 * rejects a row that omits it rather than filling it in.
 *
 * Returns null rather than throwing so route handlers can answer 401 instead of
 * rendering an error page.
 *
 * Cached per request for the same reason getAuthUser() is: the layout wants the
 * role, the page wants the org id and the drawer wants the user id, and asking
 * org_members three times for one row is three trips across the Pacific.
 */
export const getOrgContext = cache(async (): Promise<OrgContext | null> => {
  const supabase = await createServerSupabase();

  const user = await getAuthUser();
  if (!user) return null;

  const { data: membership } = await supabase
    .from("org_members")
    .select("org_id, role")
    .eq("user_id", user.id)
    .maybeSingle();

  // A user with no membership is authenticated but has no org, so
  // app.current_org_id() is null and every policy denies them. Treat that as
  // "no context" rather than letting the page render an empty grid that looks
  // like a working app with no leads in it.
  if (!membership) return null;

  return {
    supabase,
    userId: user.id,
    email: user.email,
    orgId: membership.org_id as string,
    role: membership.role as OrgRole,
  };
});

/**
 * Page-side variant.
 *
 * The two failure modes go to different places on purpose. No session at all is
 * /login. A valid session with no org membership is /no-access, NOT /login:
 * middleware sends a signed-in user away from /login, so bouncing them there
 * would put the browser in an infinite redirect and make a provisioning problem
 * look like a broken app.
 *
 * Since migration 0008 that second state should be unreachable — membership is
 * created by a trigger when the auth user is — but "should be unreachable" is
 * not a reason to loop if it happens.
 */
export async function requireOrgContext(): Promise<OrgContext> {
  // Both reads are memoized, so distinguishing the two failure modes costs
  // nothing beyond what getOrgContext() was going to do anyway. It used to cost
  // a second full authentication round trip.
  if (!(await getAuthUser())) redirect("/login");

  const context = await getOrgContext();
  if (!context) redirect("/no-access");
  return context;
}
