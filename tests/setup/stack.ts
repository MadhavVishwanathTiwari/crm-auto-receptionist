// Harness for RLS integration tests.
//
// These run against the LOCAL Supabase stack with real JWTs, not against
// `set local request.jwt.claims` in pgTAP. That choice is deliberate: pgTAP
// exercises the policy predicates but not the layer where this app's secrets
// actually leak — PostgREST role switching (anon vs authenticated vs
// service_role), function GRANT EXECUTE, view security_invoker, and Realtime's
// own RLS check. Those are the interesting failure modes, and only a real
// client over HTTP touches them.

import { execFileSync } from "node:child_process";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { randomUUID } from "node:crypto";

interface StackKeys {
  url: string;
  anonKey: string;
  serviceRoleKey: string;
}

let cached: StackKeys | null = null;

/**
 * Reads keys from the running local stack. Shelling out to the CLI rather than
 * hardcoding the well-known demo keys, because those have changed between CLI
 * major versions and a stale constant fails as a confusing 401.
 */
export function stackKeys(): StackKeys {
  if (cached) return cached;

  if (process.env.TEST_SUPABASE_ANON_KEY && process.env.TEST_SUPABASE_SERVICE_KEY) {
    cached = {
      url: process.env.TEST_SUPABASE_URL!,
      anonKey: process.env.TEST_SUPABASE_ANON_KEY,
      serviceRoleKey: process.env.TEST_SUPABASE_SERVICE_KEY,
    };
    return cached;
  }

  let raw: string;
  try {
    raw = execFileSync("npx", ["supabase", "status", "-o", "json"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      shell: process.platform === "win32",
    });
  } catch {
    throw new Error(
      "Could not read local Supabase status. Start Docker Desktop, then run " +
        "`npm run db:start` before the integration suite.",
    );
  }

  const status = JSON.parse(raw) as Record<string, string>;
  const anonKey = status.ANON_KEY ?? status.API_KEY;
  const serviceRoleKey = status.SERVICE_ROLE_KEY;

  if (!anonKey || !serviceRoleKey) {
    throw new Error(
      `Local stack returned no keys. Got: ${Object.keys(status).join(", ")}`,
    );
  }

  cached = {
    url: status.API_URL ?? process.env.TEST_SUPABASE_URL!,
    anonKey,
    serviceRoleKey,
  };
  return cached;
}

/** Service-role client. Bypasses RLS — used for fixtures and privileged re-reads. */
export function adminClient(): SupabaseClient {
  const { url, serviceRoleKey } = stackKeys();
  return createClient(url, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

/** Unauthenticated client. Should be able to read nothing at all. */
export function anonClient(): SupabaseClient {
  const { url, anonKey } = stackKeys();
  return createClient(url, anonKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

export interface TestUser {
  id: string;
  email: string;
  /** Client carrying this user's real access token. RLS applies. */
  client: SupabaseClient;
}

/**
 * Creates a confirmed auth user and returns a client authenticated as them.
 * Each call uses a unique email so tests never collide across files.
 */
export async function createTestUser(label: string): Promise<TestUser> {
  const { url, anonKey } = stackKeys();
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

  const client = createClient(url, anonKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
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

/** Deletes an org and everything cascading from it, plus its auth users. */
export async function cleanup(orgIds: string[], userIds: string[]) {
  const admin = adminClient();
  for (const id of orgIds) {
    await admin.from("orgs").delete().eq("id", id);
  }
  for (const id of userIds) {
    await admin.auth.admin.deleteUser(id);
  }
}
