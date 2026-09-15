import "server-only";

import { IANAZone } from "luxon";
import { cookies } from "next/headers";
import { cache } from "react";

import { ZONE_COOKIE } from "@/lib/time/format";

/**
 * The zone the operator reading this page is in, or null if their browser has
 * not said yet.
 *
 * Read from the cookie ViewerZone writes, so a server render formats times the
 * way the browser will and the two never disagree (see lib/time/format.ts).
 * Validated because a cookie is whatever the client sent: anything that is not
 * an IANA zone is treated as no answer rather than handed to luxon.
 *
 * cache()d like getOrgContext(), so the layout and the page share one read.
 * Costs no round trip: it is a request header.
 */
export const getViewerZone = cache(async (): Promise<string | null> => {
  const value = (await cookies()).get(ZONE_COOKIE)?.value;
  return value && IANAZone.isValidZone(value) ? value : null;
});
