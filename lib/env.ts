// Single place that reconciles environment variable names.
//
// Two things make this worth centralising rather than reading process.env
// inline. First, this project uses Supabase's NEW key names
// (`PUBLISHABLE_KEY` / `SECRET_KEY`) while the sibling `ar-lead-finder` repo
// uses the legacy `ANON_KEY` / `SERVICE_ROLE_KEY` — code ported across without
// this shim reads `undefined` and fails at runtime with a misleading auth
// error. Second, it keeps every secret name in one greppable file, so
// "what does this app actually need provisioned" has one answer.

function required(name: string, value: string | undefined): string {
  if (!value || !value.trim()) {
    throw new Error(
      `Missing required environment variable ${name}. See .env.example.`,
    );
  }
  return value.trim();
}

/** Safe in the browser. Anything added here ships to the client. */
export const publicEnv = {
  supabaseUrl: required(
    "NEXT_PUBLIC_SUPABASE_URL",
    process.env.NEXT_PUBLIC_SUPABASE_URL,
  ),
  // New-style name. Falls back to the legacy anon key so a local stack started
  // by an older CLI still works.
  supabasePublishableKey: required(
    "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY",
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ??
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
  ),
};

/**
 * Server-only. Importing this from a client component is a security bug, not a
 * style issue — the throw below is what turns that bug into a build failure
 * instead of a silent key leak.
 */
export function serverEnv() {
  if (typeof window !== "undefined") {
    throw new Error("serverEnv() was called in the browser.");
  }
  return {
    // Bypasses RLS. Only the routes listed in CLAUDE.md may use this.
    supabaseServiceRoleKey: required(
      "SUPABASE_SERVICE_ROLE_KEY",
      process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_SECRET_KEY,
    ),
    // Direct connection, used by migrations and the nightly reconcile job.
    supabaseDirectUrl: process.env.SUPABASE_DIRECT_URL ?? "",

    // Where this deployment lives. Used to build the Google OAuth redirect,
    // which must match the value registered in the Cloud console CHARACTER FOR
    // CHARACTER — so it is read from config rather than inferred from the
    // request, where a proxy or a preview URL would silently change it.
    siteUrl: (process.env.NEXT_PUBLIC_SITE_URL ?? "").replace(/\/+$/, ""),

    // Shared secret pg_cron presents when calling /api/cron/*.
    cronSecret: process.env.CRON_SECRET ?? "",
    // Shared secret the Auto-Receptionist repo presents when POSTing demos.
    arIngestSecret: process.env.AR_INGEST_SECRET ?? "",

    // Phase 2. Absent during Phase 1, so deliberately not `required`.
    googleOAuthClientId: process.env.GOOGLE_OAUTH_CLIENT_ID ?? "",
    googleOAuthClientSecret: process.env.GOOGLE_OAUTH_CLIENT_SECRET ?? "",
  };
}
