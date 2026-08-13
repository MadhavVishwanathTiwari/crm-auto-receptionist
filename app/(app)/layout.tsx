import type { Route } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";

import { createServerSupabase } from "@/lib/supabase/server";

import { SignOutButton } from "./SignOutButton";

// Write is first because it is the job. Everything after it is either what
// feeds the composer or what happens to an email after it leaves, and an
// operator who opens this app to send today's forty should land on the screen
// that sends them rather than on a grid.
//
// The rest is ordered by the pipeline, not alphabetically: import -> claim on
// the grid -> audit -> queue -> send -> what came back. Review sits next to
// Import because it is that step's overflow, and Templates and Mailboxes sit
// after Queue because they are what the queue turns into an email.
// Annotated rather than `as const`: with typed routes, a bare union of ten
// literal hrefs makes Link infer its generic from the wrong member and reject
// every other one.
const NAV: { href: Route; label: string }[] = [
  { href: "/write", label: "Write" },
  { href: "/leads", label: "Leads" },
  { href: "/import", label: "Import" },
  { href: "/review", label: "Review" },
  { href: "/audit", label: "Audit" },
  { href: "/queue", label: "Queue" },
  { href: "/alerts", label: "Alerts" },
  { href: "/templates", label: "Templates" },
  { href: "/mailboxes", label: "Mailboxes" },
  { href: "/suppressions", label: "Suppressions" },
  { href: "/settings", label: "Settings" },
];

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

  const [{ data: membership }, { count: openAlerts }] = await Promise.all([
    supabase.from("org_members").select("role").eq("user_id", user.id).maybeSingle(),
    // head:true asks PostgREST for the count and no rows. The badge is the only
    // reason a reply is worth surfacing outside the alerts screen, so it is the
    // only thing loaded here.
    supabase
      .from("alerts")
      .select("id", { count: "exact", head: true })
      .is("acknowledged_at", null),
  ]);

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
              {item.href === "/alerts" && openAlerts ? (
                <span className="tabular ml-1 text-[var(--color-ok)]">
                  {openAlerts}
                </span>
              ) : null}
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
