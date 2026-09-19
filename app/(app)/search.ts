"use server";

import { getOrgContext } from "@/lib/org";

export interface LeadHit {
  id: string;
  company: string | null;
  email: string | null;
  status: string;
  city: string | null;
  state: string | null;
}

/**
 * Leads matching what somebody typed into the command palette.
 *
 * Bounded at twenty rows, so this is the one kind of read that does not go
 * through selectAll()/selectUpTo(): it is a "show me the first few" query by
 * construction, and PostgREST's 1000-row ceiling is nowhere near it. The
 * ordinary cookie-bound RLS client, so an operator can only find leads in
 * their own org.
 */
export async function searchLeads(query: string): Promise<LeadHit[]> {
  const term = query.trim();
  if (term.length < 2) return [];

  const context = await getOrgContext();
  if (!context) return [];

  // PostgREST's or() takes a comma-separated filter list, and a comma or a
  // parenthesis inside the value would end the filter early.
  const safe = term.replace(/[,()*\\]/g, " ").trim();
  if (!safe) return [];

  const { data, error } = await context.supabase
    .from("leads")
    .select("id, company_name, work_email, status, city, state")
    .is("archived_at", null)
    .or(
      `company_name.ilike.%${safe}%,work_email.ilike.%${safe}%,city.ilike.%${safe}%`,
    )
    .order("created_at", { ascending: false })
    .limit(20);

  if (error || !data) return [];

  return data.map((row) => ({
    id: row.id,
    company: row.company_name,
    email: row.work_email,
    status: row.status,
    city: row.city,
    state: row.state,
  }));
}
