import { Suspense } from "react";
import { redirect } from "next/navigation";

import { firstParam, safeNextPath } from "@/lib/authRedirect";

import { LoginForm } from "./LoginForm";

// Google only, and no signup route. Accounts are not requested and approved,
// they are listed: app.login_allowlist in migration 0008 names the two addresses
// that may exist, and a trigger on auth.users enforces it. Provisioning happens
// on first sign-in, so there is no invite to send and no password to reset.
export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const code = firstParam(params.code);

  // Supabase redirects to the project's Site URL whenever the requested redirect
  // is not on its allowlist, and the Site URL is /login. So a valid auth code can
  // land HERE instead of at /auth/callback, where it would otherwise be thrown
  // away — the browser dead-ends on a login page with a live code in the URL.
  // Forward it to the callback, which is a route handler and can set the session
  // cookie. This makes sign-in work even before the redirect allowlist is fixed;
  // fixing the allowlist just skips this hop.
  if (code) {
    const next = safeNextPath(firstParam(params.next));
    redirect(`/auth/callback?code=${encodeURIComponent(code)}&next=${encodeURIComponent(next)}`);
  }

  return (
    <main className="flex h-full flex-col items-center justify-center gap-6">
      <h1 className="text-[15px] tracking-wide text-[var(--color-ink-2)]">
        Outreach Ops
      </h1>
      <Suspense>
        <LoginForm />
      </Suspense>
    </main>
  );
}
