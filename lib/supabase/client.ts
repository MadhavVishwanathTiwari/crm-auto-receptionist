import { createBrowserClient } from "@supabase/ssr";

import { publicEnv } from "@/lib/env";

/**
 * Browser client. Runs as the signed-in user with RLS applied, and is also what
 * the grid subscribes to for Realtime — `postgres_changes` enforces the same
 * policies, so a row the user cannot select is a row they are never pushed.
 */
export function createBrowserSupabase() {
  return createBrowserClient(
    publicEnv.supabaseUrl,
    publicEnv.supabasePublishableKey,
  );
}
