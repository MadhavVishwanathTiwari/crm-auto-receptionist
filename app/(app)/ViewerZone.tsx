"use client";

import { useRouter } from "next/navigation";
import { createContext, Fragment, useContext, useEffect } from "react";

import { ZONE_COOKIE } from "@/lib/time/format";

interface ViewerZoneValue {
  /** The operator's IANA zone, or null until their browser has said. */
  zone: string | null;
  /** When the server rendered this page. relativeTo() measures from it. */
  renderedAt: string;
}

const ViewerZoneContext = createContext<ViewerZoneValue>({
  zone: null,
  renderedAt: new Date(0).toISOString(),
});

/**
 * Hands every client component the zone the server rendered with, and keeps
 * the cookie that zone comes from in step with the browser.
 *
 * The browser is the only thing that knows the operator's zone, and the server
 * has to know it before the first byte to avoid rendering UTC. So the browser
 * writes it down: on a first visit (or after travelling) this sets the cookie
 * and asks for the page again, and from then on the server's render and the
 * browser's hydration use the same zone and produce the same text.
 *
 * Keyed by zone so that one refresh remounts the page. Without that, a
 * useState seeded from a time on the first render (the drawer's follow-up
 * field) would keep the value it got while the zone was still unknown.
 */
export function ViewerZone({
  zone,
  renderedAt,
  children,
}: ViewerZoneValue & { children: React.ReactNode }) {
  const router = useRouter();

  useEffect(() => {
    const browser = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (!browser || browser === zone) return;

    // A year, and Lax so it rides along on ordinary navigation. Zone names are
    // letters, "/", "_", "-" and "+", none of which a cookie value forbids.
    document.cookie = `${ZONE_COOKIE}=${browser}; path=/; max-age=31536000; samesite=lax`;
    router.refresh();
  }, [zone, router]);

  return (
    <ViewerZoneContext.Provider value={{ zone, renderedAt }}>
      <Fragment key={zone ?? "unknown"}>{children}</Fragment>
    </ViewerZoneContext.Provider>
  );
}

export function useViewerZone(): ViewerZoneValue {
  return useContext(ViewerZoneContext);
}
