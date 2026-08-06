"use client";

import { useRouter } from "next/navigation";

import { createBrowserSupabase } from "@/lib/supabase/client";

export function SignOutButton() {
  const router = useRouter();

  return (
    <button
      type="button"
      onClick={async () => {
        await createBrowserSupabase().auth.signOut();
        router.refresh();
        router.replace("/login");
      }}
      className="hover:text-[var(--color-ink)]"
    >
      Sign out
    </button>
  );
}
