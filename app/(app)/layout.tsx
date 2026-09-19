import { requireOrgContext } from "@/lib/org";
import { getViewerZone } from "@/lib/time/zone";
import { getSidebarCollapsed } from "@/lib/ui/prefs";

import { AppSidebar } from "@/components/shell/AppSidebar";

import { ViewerZone } from "./ViewerZone";

export default async function AppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // Middleware already gates this, but a layout that renders without a user
  // would leak an empty grid rather than redirect, so check again here.
  //
  // requireOrgContext() rather than a session check plus a membership query of
  // its own: it already returns the email and the role this shell needs, it is
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

  // head:true asks PostgREST for the count and no rows. It seeds the sidebar
  // badge, which then keeps itself current over Realtime -- a layout is not
  // re-rendered when the operator moves between pages, so a server count alone
  // went stale the moment an alert was acknowledged.
  //
  // The viewer's zone and the sidebar's width ride along: both are cookies, so
  // they cost nothing, and reading the width here is what stops the sidebar
  // flashing open on every force-dynamic navigation.
  const [{ count: openAlerts }, zone, collapsed] = await Promise.all([
    supabase
      .from("alerts")
      .select("id", { count: "exact", head: true })
      .is("acknowledged_at", null),
    getViewerZone(),
    getSidebarCollapsed(),
  ]);

  // One "now" for the whole render, so a relative time reads the same on the
  // server and in the browser that hydrates it a moment later.
  const renderedAt = new Date().toISOString();

  return (
    <div className="flex h-full">
      <AppSidebar
        email={email}
        role={role}
        openAlerts={openAlerts ?? 0}
        initialCollapsed={collapsed}
      />

      {/* min-w-0 is not optional. The leads grid is `w-max min-w-full`, and a
          flex child defaults to min-width:auto -- so without this a wide grid
          pushes the sidebar off the left edge, and there are no responsive
          breakpoints in this app to rescue it. */}
      <div className="min-h-0 min-w-0 flex-1">
        <ViewerZone zone={zone} renderedAt={renderedAt}>
          {children}
        </ViewerZone>
      </div>
    </div>
  );
}
