import { SignOutButton } from "../(app)/SignOutButton";

// Outside the (app) route group on purpose: that layout fetches a membership of
// its own, which is the thing that is missing here.
export default function NoAccessPage() {
  return (
    <main className="flex h-full flex-col items-center justify-center gap-4">
      <h1 className="text-[15px] tracking-wide text-[var(--color-ink-2)]">
        Outreach Ops
      </h1>
      <p className="max-w-[380px] text-center text-[var(--color-ink-2)]">
        You are signed in, but your account is not attached to an organisation,
        so there is nothing you can see yet.
      </p>
      <p className="max-w-[380px] text-center text-[var(--color-ink-3)]">
        Membership is normally created the moment an account is, so this means
        something went wrong rather than that you are waiting on an approval.
        Worth telling whoever set the project up.
      </p>
      <div className="text-[var(--color-ink-2)]">
        <SignOutButton />
      </div>
    </main>
  );
}
