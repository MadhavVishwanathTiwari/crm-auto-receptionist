/**
 * Cookie names, in a module with no imports.
 *
 * The sidebar's collapsed state is written by a client component and read by a
 * server one, so the name has to be reachable from both. lib/ui/prefs.ts is
 * `server-only`, and importing a constant from it pulls the whole module into
 * the browser bundle and fails the build -- the same shape as the bug that put
 * SUPPRESSION_REASONS in its own file, and as ZONE_COOKIE living in
 * lib/time/format.ts rather than in lib/time/zone.ts.
 */
export const SIDEBAR_COOKIE = "ui_sidebar";
