import "server-only";

import { cookies } from "next/headers";
import { cache } from "react";

import { SIDEBAR_COOKIE } from "./cookies";

/**
 * Whether the sidebar is collapsed, read on the server so the first byte is
 * already the right width.
 *
 * A cookie rather than localStorage for the same reason ViewerZone uses one:
 * every page in (app) is force-dynamic, so the server renders the shell on
 * every navigation, and localStorage would mean a flash of the wrong width
 * each time or a blocking script in <head> to prevent it.
 *
 * cache()d like getViewerZone(), so the layout reads it once. Costs no round
 * trip: it is a request header.
 */
export const getSidebarCollapsed = cache(async (): Promise<boolean> => {
  return (await cookies()).get(SIDEBAR_COOKIE)?.value === "1";
});
