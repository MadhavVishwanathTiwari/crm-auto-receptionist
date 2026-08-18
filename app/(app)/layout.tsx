import type { Route } from "next";
import Link from "next/link";

import { requireOrgContext } from "@/lib/org";

import { SignOutButton } from "./SignOutButton";

// Write is first because it is the job. Everything after it is either what
// feeds the composer or what happens to an email after it leaves, and an
// operator who opens this app to send today's forty should land on the screen
// that sends them rather than on a grid.
//
// The rest is ordered by the pipeline, not alphabetically: import -> claim on
// the grid -> audit -> queue -> send -> what came back. Review sits next to
// Import because it is that step's overflow, and Templates and Mailboxes sit
// after Queue because they are what the queue turns into an email. Pipeline
// follows Alerts for the same reason: it is what you DO about what came back.
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
  { href: "/pipeline", label: "Pipeline" },
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
  // Middleware already gates this, but a layout that renders without a user
  // would leak an empty grid rather than redirect, so check again here.
  //
  // requireOrgContext() rather than a session check plus a membership query of
  // its own: it already returns the email and the role this header needs, it is
  // memoized per request, and the page rendering underneath is about to call it
  // anyway. Asking separately meant the header and the page each authenticated
  // and each read org_members.
  //
  // It also keeps the two failure modes apart, which a bare `if (!context)
  // redirect("/login")` here would not: a signed-in user with no membership has
  // to go to /no-access, because middleware bounces a signed-in user away from
  // /login and the pair would spin. /no-access sits outside this route group,
  // so it does not re-enter this layout.
  const { supabase, email, role } = await requireOrgContext();

  // head:true asks PostgREST for the count and no rows. The badge is the only
  // reason a reply is worth surfacing outside the alerts screen, so it is the
  // only thing loaded here.
  const { count: openAlerts } = await supabase
    .from("alerts")
    .select("id", { count: "exact", head: true })
    .is("acknowledged_at", null);

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
          <span>{email}</span>
          {role === "admin" && <span>admin</span>}
          <SignOutButton />
        </div>
      </header>
      <div className="min-h-0 flex-1">{children}</div>
    </div>
  );
}
