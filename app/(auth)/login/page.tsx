import { Suspense } from "react";

import { LoginForm } from "./LoginForm";

// Google only, and no signup route. Accounts are not requested and approved,
// they are listed: app.login_allowlist in migration 0008 names the two addresses
// that may exist, and a trigger on auth.users enforces it. Provisioning happens
// on first sign-in, so there is no invite to send and no password to reset.
export default function LoginPage() {
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
