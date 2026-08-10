"use client";

import { useSearchParams } from "next/navigation";
import { useState, useSyncExternalStore } from "react";

import { describeAuthError } from "@/lib/authErrors";
import { createBrowserSupabase } from "@/lib/supabase/client";

// Supabase also reports failures in the URL fragment, which never reaches the
// server, so a redirect landing anywhere other than the callback loses it
// unless the browser reads it.
//
// Read through useSyncExternalStore rather than an effect: the fragment is
// fixed for the life of the page, and setting state from an effect to surface
// it costs a second render pass for a value that was available all along.
const FRAGMENT_STORE = {
  // Nothing mutates it, so there is nothing to subscribe to.
  subscribe: () => () => {},
  getSnapshot: () => {
    const hash = new URLSearchParams(window.location.hash.slice(1));
    return hash.get("error_description") ?? hash.get("error");
  },
  // No fragment exists during SSR. Returning null keeps hydration honest.
  getServerSnapshot: () => null,
};

export function LoginForm() {
  const params = useSearchParams();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // The callback route reports failures by redirecting back here, which is the
  // only way an allowlist rejection can reach a human.
  const queryError = params.get("error_description") ?? params.get("error");

  const fragmentError = useSyncExternalStore(
    FRAGMENT_STORE.subscribe,
    FRAGMENT_STORE.getSnapshot,
    FRAGMENT_STORE.getServerSnapshot,
  );

  const reported = queryError ?? fragmentError;

  async function signIn() {
    setBusy(true);
    setError(null);

    // Only a same-site path. An absolute URL in ?next would turn the login page
    // into an open redirect.
    const requested = params.get("next");
    const next =
      requested && requested.startsWith("/") && !requested.startsWith("//")
        ? requested
        : "/leads";

    const callback = new URL("/auth/callback", window.location.origin);
    callback.searchParams.set("next", next);

    const supabase = createBrowserSupabase();
    const { error: oauthError } = await supabase.auth.signInWithOAuth({
      provider: "google",
      options: {
        redirectTo: callback.toString(),
        // Deliberately no `hd` parameter. The Workspace has three domains, so
        // pinning one would lock out the operators on the other two, and `hd`
        // is a hint to the account chooser rather than a control anyway. The
        // real gates are Google's Internal consent screen and the allowlist
        // trigger on auth.users.
      },
    });

    if (oauthError) {
      setError(oauthError.message);
      setBusy(false);
    }
    // On success the browser leaves for Google, so there is nothing to reset.
  }

  return (
    <div className="flex w-[300px] flex-col gap-3">
      <button
        type="button"
        onClick={signIn}
        disabled={busy}
        className="w-full border border-[var(--color-line-2)] bg-[var(--color-surface-3)] px-3 py-2 text-[var(--color-ink)] hover:border-[var(--color-line-strong)] disabled:opacity-50"
      >
        {busy ? "Redirecting..." : "Continue with Google"}
      </button>

      {(error ?? reported) && (
        <p role="alert" className="text-[var(--color-danger)]">
          {describeAuthError(error ?? reported ?? "")}
        </p>
      )}

      <p className="text-[var(--color-ink-3)]">
        Sign in with your Auto Receptionist account. Access is granted per
        address, so an account that has not been added will be turned away even
        though it is in the Workspace.
      </p>
    </div>
  );
}
