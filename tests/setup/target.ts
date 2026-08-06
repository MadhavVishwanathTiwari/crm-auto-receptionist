// Resolves which database the integration suites run against.
//
// Two targets are supported:
//
//   local  — `npm run db:start`. Preferred, because `npm run db:reset` DROPS
//            AND RECREATES the database, and that command must never learn to
//            point at the project holding real leads.
//   cloud  — the hosted project, from .env. Used while the local stack is
//            unavailable. Safe today because the project is empty; it stops
//            being safe the moment real leads land in it.
//
// Default is local when reachable, cloud otherwise, and TEST_TARGET forces
// either. Whichever is chosen is printed once at startup, because a suite that
// silently changes which database it asserts against is worse than one that
// fails.

import { execFileSync } from "node:child_process";
import { config } from "dotenv";

config({ path: ".env", quiet: true });

export type Target = "local" | "cloud";

export interface TargetConfig {
  target: Target;
  apiUrl: string;
  anonKey: string;
  serviceRoleKey: string;
  dbUrl: string;
  /** True when this target holds data we care about. Gates destructive helpers. */
  isShared: boolean;
}

const LOCAL_API_URL = "http://127.0.0.1:54321";
const LOCAL_DB_URL = "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

function cloudConfig(): TargetConfig {
  const apiUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey =
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ??
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  const serviceRoleKey =
    process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_SECRET_KEY;

  // The direct connection (db.<ref>.supabase.co) is IPv6-only on newer
  // projects and does not resolve from every network. The session pooler on
  // 5432 speaks full Postgres including DDL and advisory locks, so it is the
  // reliable choice. The TRANSACTION pooler on 6543 is not — it breaks
  // prepared statements and session-scoped advisory locks, which the scheduler
  // depends on.
  const dbUrl = process.env.SUPABASE_POOLER_URL;

  const missing = Object.entries({
    NEXT_PUBLIC_SUPABASE_URL: apiUrl,
    NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: anonKey,
    SUPABASE_SERVICE_ROLE_KEY: serviceRoleKey,
    SUPABASE_POOLER_URL: dbUrl,
  })
    .filter(([, v]) => !v)
    .map(([k]) => k);

  if (missing.length > 0) {
    throw new Error(
      `Cloud test target is missing ${missing.join(", ")} in .env.`,
    );
  }

  return {
    target: "cloud",
    apiUrl: apiUrl!,
    anonKey: anonKey!,
    serviceRoleKey: serviceRoleKey!,
    dbUrl: dbUrl!,
    isShared: true,
  };
}

function localConfig(): TargetConfig | null {
  // Reading the keys requires the CLI, which requires Docker. If that fails the
  // stack is not up and there is nothing to talk to.
  try {
    // npx.cmd rather than shell:true — passing args through a shell means they
    // are concatenated rather than escaped, which Node now warns about.
    const npx = process.platform === "win32" ? "npx.cmd" : "npx";
    const raw = execFileSync(npx, ["supabase", "status", "-o", "json"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 30_000,
    });
    const status = JSON.parse(raw) as Record<string, string>;
    if (!status.ANON_KEY || !status.SERVICE_ROLE_KEY) return null;

    return {
      target: "local",
      apiUrl: status.API_URL ?? LOCAL_API_URL,
      anonKey: status.ANON_KEY,
      serviceRoleKey: status.SERVICE_ROLE_KEY,
      dbUrl: status.DB_URL ?? LOCAL_DB_URL,
      isShared: false,
    };
  } catch {
    return null;
  }
}

let cached: TargetConfig | null = null;

export function testTarget(): TargetConfig {
  if (cached) return cached;

  const requested = process.env.TEST_TARGET as Target | undefined;

  if (requested === "cloud") {
    cached = cloudConfig();
  } else if (requested === "local") {
    const local = localConfig();
    if (!local) {
      throw new Error(
        "TEST_TARGET=local but the local stack is not running. " +
          "Start Docker Desktop, then `npm run db:start`.",
      );
    }
    cached = local;
  } else {
    cached = localConfig() ?? cloudConfig();
  }

  if (cached.isShared) {
    console.warn(
      `\n  Integration tests are running against the SHARED cloud project ` +
        `(${new URL(cached.apiUrl).hostname}).\n` +
        `  They create and delete orgs and auth users. Safe while the project ` +
        `is empty.\n` +
        `  Switch back with \`npm run db:start\` once Docker works.\n`,
    );
  }

  return cached;
}
