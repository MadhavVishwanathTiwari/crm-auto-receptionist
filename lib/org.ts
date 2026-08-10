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

/** Page-side variant: bounces to /login instead of returning null. */
export async function requireOrgContext(): Promise<OrgContext> {
  const context = await getOrgContext();
  if (!context) redirect("/login");
  return context;
}
