// Harness for RLS integration tests.
//
// These run against a real Supabase instance with real JWTs, not against
// `set local request.jwt.claims` in pgTAP. That choice is deliberate: pgTAP
// exercises the policy predicates but not the layer where this app's secrets
// actually leak — PostgREST role switching (anon vs authenticated vs
// service_role), function GRANT EXECUTE, view security_invoker, and Realtime's
// own RLS check. Those are the interesting failure modes, and only a real
// client over HTTP touches them.
//
// See target.ts for how local vs cloud is chosen.

import { randomUUID } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import { testTarget } from "./target";

const clientOptions = {
  auth: { autoRefreshToken: false, persistSession: false },
} as const;

/** Service-role client. Bypasses RLS — for fixtures and privileged re-reads. */
export function adminClient(): SupabaseClient {
  const { apiUrl, serviceRoleKey } = testTarget();
  return createClient(apiUrl, serviceRoleKey, clientOptions);
}

/** Unauthenticated client. Should be able to read nothing at all. */
export function anonClient(): SupabaseClient {
  const { apiUrl, anonKey } = testTarget();
  return createClient(apiUrl, anonKey, clientOptions);
}

export interface TestUser {
  id: string;
  email: string;
  /** Client carrying this user's real access token. RLS applies. */
  client: SupabaseClient;
}

/**
 * Creates a confirmed auth user and returns a client authenticated as them.
 *
 * The email is randomized per call so parallel runs and reruns never collide,
 * and uses the reserved `.test` TLD so a stray outbound email can never reach
 * a real inbox.
 */
export async function createTestUser(label: string): Promise<TestUser> {
  const { apiUrl, anonKey } = testTarget();
  const admin = adminClient();
  const email = `${label}-${randomUUID().slice(0, 8)}@example.test`;
  const password = randomUUID();

  const { data: created, error: createError } =
    await admin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
    });
  if (createError || !created.user) {
    throw new Error(`Could not create test user: ${createError?.message}`);
  }

  const client = createClient(apiUrl, anonKey, clientOptions);
  const { error: signInError } = await client.auth.signInWithPassword({
    email,
    password,
  });
  if (signInError) {
    throw new Error(`Could not sign in test user: ${signInError.message}`);
  }

  return { id: created.user.id, email, client };
}

export interface TestOrg {
  id: string;
  slug: string;
}

export async function createTestOrg(label: string): Promise<TestOrg> {
  const admin = adminClient();
  const slug = `${label}-${randomUUID().slice(0, 8)}`;

  const { data, error } = await admin
    .from("orgs")
    .insert({ name: label, slug })
    .select("id, slug")
    .single();
  if (error) throw new Error(`Could not create test org: ${error.message}`);

  const { error: settingsError } = await admin
    .from("org_settings")
    .insert({ org_id: data.id });
  if (settingsError) {
    throw new Error(`Could not create org_settings: ${settingsError.message}`);
  }

  return { id: data.id, slug: data.slug };
}

export async function addMember(
  orgId: string,
  userId: string,
  role: "admin" | "member",
): Promise<void> {
  const admin = adminClient();
  const { error } = await admin
    .from("org_members")
    .insert({ org_id: orgId, user_id: userId, role });
  if (error) throw new Error(`Could not add org member: ${error.message}`);
}

/**
 * Deletes only what this run created: the named orgs (everything else cascades)
 * and the named auth users. Deliberately scoped by id rather than truncating,
 * because these suites may be running against the shared cloud project.
 */
export async function cleanup(orgIds: string[], userIds: string[]) {
  const admin = adminClient();
  for (const id of orgIds) {
    await admin.from("orgs").delete().eq("id", id);
  }
  for (const id of userIds) {
    await admin.auth.admin.deleteUser(id);
  }
}
