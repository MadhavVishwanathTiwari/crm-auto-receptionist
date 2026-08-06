// `server-only` makes importing this from a client component a BUILD ERROR
// rather than a code-review catch. Keep it as the first import.
import "server-only";

import { createClient } from "@supabase/supabase-js";

import { publicEnv, serverEnv } from "@/lib/env";

/**
 * Service-role client. **Bypasses RLS entirely.**
 *
 * Allowed in exactly these places, and nowhere else:
 *   - app/api/cron/**              (no user session exists)
 *   - app/api/v1/demos/**          (external service-to-service POST)
 *   - app/api/auth/google/callback (writes mailbox_secrets)
 *   - tests/integration/**         (fixture setup and privileged re-reads)
 *
 * Anything reachable from a browser must use lib/supabase/server.ts instead.
 * Three things enforce that: the `server-only` import above, the ESLint
 * no-restricted-imports rule in eslint.config.mjs, and
 * scripts/check-no-service-key-in-bundle.mjs run against build output.
 *
 * Every caller must scope its own queries by org_id. RLS is not doing it here.
 */
export function createAdminSupabase() {
  return createClient(
    publicEnv.supabaseUrl,
    serverEnv().supabaseServiceRoleKey,
    {
      auth: {
        // There is no user and no session to keep alive. Leaving these on makes
        // the client spawn a refresh timer that keeps serverless functions warm
        // and leaks between invocations.
        autoRefreshToken: false,
        persistSession: false,
      },
    },
  );
}
