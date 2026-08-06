import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";

import { publicEnv } from "@/lib/env";

/**
 * Cookie-bound client that runs as the signed-in user. RLS applies to every
 * query, so this is the default for anything that isn't a cron job or an
 * unauthenticated webhook.
 */
export async function createServerSupabase() {
  const cookieStore = await cookies();

  return createServerClient(
    publicEnv.supabaseUrl,
    publicEnv.supabasePublishableKey,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet) {
          try {
            for (const { name, value, options } of cookiesToSet) {
              cookieStore.set(name, value, options);
            }
          } catch {
            // Server Components cannot set cookies. That is fine: middleware.ts
            // refreshes the session on every request, so the token this client
            // just rotated will be persisted there instead.
          }
        },
      },
    },
  );
}
