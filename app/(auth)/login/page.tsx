import { Suspense } from "react";

import { LoginForm } from "./LoginForm";

// Two users, both provisioned by an admin. There is deliberately no signup
// route: an open signup on an internal tool is an attack surface with no user.
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
