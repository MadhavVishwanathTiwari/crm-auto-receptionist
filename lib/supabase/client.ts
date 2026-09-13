import { createBrowserClient } from "@supabase/ssr";
import type { RealtimeChannel } from "@supabase/supabase-js";

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

/**
 * Joins a Realtime channel as the signed-in user, and returns the cleanup.
 *
 * `subscribe()` puts whatever token the socket holds at that instant into the
 * join, and on a fresh page that is nothing: the session is read out of the
 * cookie asynchronously, after the first effect has already run. The join then
 * carries the publishable key alone, Realtime records the subscription as
 * `anon`, and since 0045 anon can select nothing, so RLS drops every change and
 * the screen silently stops being live. The token arriving a moment later does
 * not rescue a join already in flight. Every subscriber in the app did this;
 * the Realtime test passed because it calls `setAuth()` first, which is exactly
 * the step the app skipped.
 *
 * `setAuth()` with no argument asks the client for the session's token, so it
 * waits for the cookie to be read and the join itself carries the JWT.
 */
export function subscribeAsUser(
  supabase: ReturnType<typeof createBrowserSupabase>,
  channel: RealtimeChannel,
): () => void {
  let unmounted = false;

  void supabase.realtime
    .setAuth()
    .catch(() => undefined)
    .then(() => {
      if (!unmounted) channel.subscribe();
    });

  return () => {
    unmounted = true;
    void supabase.removeChannel(channel);
  };
}
