// Bearer-secret check for routes with no user session: /api/cron/* (called by
// pg_cron via pg_net) and /api/v1/demos/* (called by the Auto-Receptionist
// repo).

import { timingSafeEqual } from "node:crypto";

function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  // timingSafeEqual throws on length mismatch, which would itself leak length.
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/**
 * Returns null when authorized, or a Response to return as-is.
 *
 * A missing configured secret is a hard failure rather than an open door: an
 * unset CRON_SECRET in production must not mean "everyone is allowed".
 */
export function requireBearer(
  request: Request,
  expected: string | undefined,
): Response | null {
  if (!expected || expected.trim() === "") {
    return Response.json({ error: "server misconfigured" }, { status: 500 });
  }

  const header = request.headers.get("authorization") ?? "";
  const provided = header.startsWith("Bearer ") ? header.slice(7) : "";

  if (!safeEqual(provided.trim(), expected.trim())) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  return null;
}
