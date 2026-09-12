// Runs once, before any test file loads: points the APP's own environment at
// the database the fixtures are written to.
//
// Fixtures go through tests/setup/stack.ts, which picks its target itself. The
// route handlers a suite imports do not: they call createAdminSupabase(), which
// reads NEXT_PUBLIC_SUPABASE_URL and the service key from .env -- the hosted
// project. So a local run seeded a local org, then asked the HOSTED planner,
// dispatcher and demo route about it. The cron routes are scoped with ?org=
// and found nothing there. The demo route is not scoped, and wrote orphan_demo
// alerts into a real org on the hosted project.
//
// Workers are forked from this process and inherit its environment, and
// dotenv never overrides a variable that is already set, so what is set here
// is what lib/env.ts sees in every suite.

import { execFileSync } from "node:child_process";

import { config } from "dotenv";

const LOCAL_API_URL = "http://127.0.0.1:54321";
const LOCAL_DB_URL = "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

function localStatus(): Record<string, string> | null {
  try {
    const npx = process.platform === "win32" ? "npx.cmd" : "npx";
    const raw = execFileSync(npx, ["supabase", "status", "-o", "json"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 30_000,
    });
    return JSON.parse(raw) as Record<string, string>;
  } catch {
    return null;
  }
}

export default function setup() {
  config({ path: ".env", quiet: true });

  // Asked for by name. target.ts warns about it.
  if (process.env.TEST_TARGET === "cloud") return;

  // No stack: point at the local ports anyway. Nothing answers there, so a
  // handler that runs fails to connect rather than reaching the hosted project
  // with its service key. target.ts throws first in any case.
  const status = localStatus();
  const anonKey = status?.ANON_KEY ?? "no-local-stack";
  const serviceKey = status?.SERVICE_ROLE_KEY ?? "no-local-stack";
  const dbUrl = status?.DB_URL ?? LOCAL_DB_URL;

  process.env.NEXT_PUBLIC_SUPABASE_URL = status?.API_URL ?? LOCAL_API_URL;
  process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY = anonKey;
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = anonKey;
  process.env.SUPABASE_SERVICE_ROLE_KEY = serviceKey;
  process.env.SUPABASE_SECRET_KEY = serviceKey;
  process.env.SUPABASE_POOLER_URL = dbUrl;
  process.env.SUPABASE_DIRECT_URL = dbUrl;
  process.env.SUPABASE_TRXN_URL = dbUrl;

  // Nothing under test may mint a token for a real mailbox. The Gmail suites
  // mock the token module; this is what makes forgetting to a failure.
  process.env.GOOGLE_OAUTH_CLIENT_ID = "";
  process.env.GOOGLE_OAUTH_CLIENT_SECRET = "";
}
