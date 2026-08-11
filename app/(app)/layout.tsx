import Link from "next/link";
import { redirect } from "next/navigation";

import { createServerSupabase } from "@/lib/supabase/server";

import { SignOutButton } from "./SignOutButton";

// Ordered by the pipeline, not alphabetically: import -> claim on the grid ->
// audit -> queue. Review sits next to Import because it is that step's overflow.
const NAV = [
  { href: "/leads", label: "Leads" },
  { href: "/import", label: "Import" },
  { href: "/review", label: "Review" },
  { href: "/audit", label: "Audit" },
  { href: "/queue", label: "Queue" },
  { href: "/suppressions", label: "Suppressions" },
] as const;

export default async function AppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const supabase = await createServerSupabase();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  // Middleware already gates this, but a layout that renders without a user
  // would leak an empty grid rather than redirect, so check again here.
  if (!user) redirect("/login");

  const { data: membership } = await supabase
    .from("org_members")
    .select("role")
    .eq("user_id", user.id)
    .maybeSingle();

  return (
    <div className="flex h-full flex-col">
      <header className="flex h-9 shrink-0 items-center gap-5 border-b border-[var(--color-line)] bg-[var(--color-surface)] px-3">
        <span className="text-[var(--color-ink-3)]">Outreach Ops</span>
        <nav className="flex items-center gap-4">
          {NAV.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className="text-[var(--color-ink-2)] hover:text-[var(--color-ink)]"
            >
              {item.label}
            </Link>
          ))}
        </nav>
        <div className="ml-auto flex items-center gap-3 text-[var(--color-ink-3)]">
          <span>{user.email}</span>
          {membership?.role === "admin" && <span>admin</span>}
          <SignOutButton />
        </div>
      </header>
      <div className="min-h-0 flex-1">{children}</div>
    </div>
  );
}
