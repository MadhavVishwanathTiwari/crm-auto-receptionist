"use client";

import { useSearchParams } from "next/navigation";
import { useState } from "react";

import { createBrowserSupabase } from "@/lib/supabase/client";

export function LoginForm() {
  const params = useSearchParams();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // The callback route reports failures by redirecting back here, which is the
  // only way an allowlist rejection can reach a human.
  const reported = params.get("error");

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
          {error ?? reported}
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
