// lat/lng -> IANA timezone.
//
// IMPORTANT: import this module only from the timezone-resolution route.
// geo-tz ships ~70 MB of boundary data; Next traces dependencies per route, so
// keeping it out of shared modules keeps that weight in one lambda. It is also
// listed in serverExternalPackages, because bundling it rewrites the paths it
// uses to load that data at runtime and lookups silently return nothing.
//
// There is deliberately no state-to-timezone fallback. A lookup table gets FL,
// TX, TN, ID, OR, KS, NE, ND, SD, MI, IN and KY wrong, and gets Arizona wrong
// in a way that only shows up twice a year. A lead we cannot place is flagged
// for a human, never guessed.

import { find } from "geo-tz";

export type TimezoneResolution =
  | { ok: true; timezone: string }
  | { ok: false; reason: "no_coordinates" | "out_of_range" | "unresolved" };

export function resolveTimezone(
  latitude: number | string | null | undefined,
  longitude: number | string | null | undefined,
): TimezoneResolution {
  const lat = typeof latitude === "string" ? Number(latitude) : latitude;
  const lng = typeof longitude === "string" ? Number(longitude) : longitude;

  if (
    lat === null || lat === undefined || lng === null || lng === undefined ||
    !Number.isFinite(lat) || !Number.isFinite(lng)
  ) {
    return { ok: false, reason: "no_coordinates" };
  }

  // 0,0 is Null Island — almost always a failed geocode rather than a real
  // location, and it resolves to a real zone, so reject it explicitly.
  if (lat === 0 && lng === 0) return { ok: false, reason: "no_coordinates" };

  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) {
    return { ok: false, reason: "out_of_range" };
  }

  const zones = find(lat, lng);
  if (zones.length === 0) return { ok: false, reason: "unresolved" };

  // Overlapping zones happen at disputed borders. The first is geo-tz's
  // best match, and none of them occur in the US service-business ICP.
  return { ok: true, timezone: zones[0]! };
}
