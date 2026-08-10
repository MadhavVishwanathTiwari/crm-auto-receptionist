import "server-only";

import { redirect } from "next/navigation";

import { createServerSupabase } from "@/lib/supabase/server";

export type OrgRole = "admin" | "member";

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
 */
export async function getOrgContext(): Promise<OrgContext | null> {
  const supabase = await createServerSupabase();

  const {
    data: { user },
  } = await supabase.auth.getUser();
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
    email: user.email ?? null,
    orgId: membership.org_id as string,
    role: membership.role as OrgRole,
  };
}

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
  const supabase = await createServerSupabase();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const context = await getOrgContext();
  if (!context) redirect("/no-access");
  return context;
}
