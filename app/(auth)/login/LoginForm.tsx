"use client";

import type { Route } from "next";
import { useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";

import { createBrowserSupabase } from "@/lib/supabase/client";

export function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);

    const supabase = createBrowserSupabase();
    const { error: signInError } = await supabase.auth.signInWithPassword({
      email: email.trim(),
      password,
    });

    if (signInError) {
      // Deliberately not distinguishing "no such user" from "wrong password".
      setError("That email and password did not match.");
      setBusy(false);
      return;
    }

    // Only accept a same-site path. An attacker-supplied absolute URL in ?next
    // would turn the login page into an open redirect.
    const requested = params.get("next");
    const next =
      requested && requested.startsWith("/") && !requested.startsWith("//")
        ? (requested as Route)
        : "/leads";

    // refresh() so Server Components re-render with the new session cookie
    // before we navigate, otherwise the destination renders as logged out once.
    router.refresh();
    router.replace(next);
  }

  const inputClass =
    "w-full bg-[var(--color-surface-2)] border border-[var(--color-line)] " +
    "px-3 py-2 text-[13px] text-[var(--color-ink)] " +
    "placeholder:text-[var(--color-ink-3)] focus:border-[var(--color-focus)]";

  return (
    <form onSubmit={onSubmit} className="w-[300px] space-y-3">
      <div>
        <label htmlFor="email" className="mb-1 block text-[var(--color-ink-2)]">
          Email
        </label>
        <input
          id="email"
          type="email"
          autoComplete="username"
          required
          autoFocus
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className={inputClass}
        />
      </div>

      <div>
        <label
          htmlFor="password"
          className="mb-1 block text-[var(--color-ink-2)]"
        >
          Password
        </label>
        <input
          id="password"
          type="password"
          autoComplete="current-password"
          required
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className={inputClass}
        />
      </div>

      {error && (
        <p role="alert" className="text-[var(--color-danger)]">
          {error}
        </p>
      )}

      <button
        type="submit"
        disabled={busy}
        className="w-full border border-[var(--color-line-2)] bg-[var(--color-surface-3)] px-3 py-2 text-[var(--color-ink)] hover:border-[var(--color-line-strong)] disabled:opacity-50"
      >
        {busy ? "Signing in..." : "Sign in"}
      </button>
    </form>
  );
}
