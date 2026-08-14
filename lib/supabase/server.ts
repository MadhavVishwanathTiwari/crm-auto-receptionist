import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import { cache } from "react";

import { publicEnv } from "@/lib/env";

/**
 * Cookie-bound client that runs as the signed-in user. RLS applies to every
 * query, so this is the default for anything that isn't a cron job or an
 * unauthenticated webhook.
 *
 * Memoized per request with React's cache(). One render of /leads?lead=<id>
 * reaches this from the layout, the page and the drawer, and each of those used
 * to get a client with its own empty auth state — which is what turned one
 * session check into six round trips to Tokyo. Sharing the client means the
 * session is decoded once and every later caller reads it from memory.
 */
export const createServerSupabase = cache(async function createServerSupabase() {
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
});
