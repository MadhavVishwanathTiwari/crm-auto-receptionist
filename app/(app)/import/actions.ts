"use server";

import { revalidatePath } from "next/cache";

import { getOrgContext } from "@/lib/org";

/**
 * The one-time repair for leads that came across from the Google Sheet before
 * the importer knew what `lead_owner` meant.
 *
 * A re-upload cannot fix them: every row is a duplicate by work_email now, and
 * a skipped row produces no lead to claim. But commitImport stores the original
 * CSV row on the lead as `raw`, so the owner is already in the database — this
 * reads it back out and claims each lead for the operator named there.
 *
 * Dry run first, always, because the tally is the only chance to notice that an
 * address resolved to nobody before 300 leads change hands.
 */

export interface BackfillRow {
  lead_id: string;
  company: string | null;
  owner_email: string | null;
  outcome: string;
}

export interface BackfillResult {
  ok: boolean;
  error?: string;
  dryRun: boolean;
  counts: Record<string, number>;
  /** The rows that did not simply work, so they can be dealt with by hand. */
  problems: BackfillRow[];
}

const PROBLEM_OUTCOMES = new Set([
  "unknown_owner",
  "claimed_by_other",
  "not_found",
]);

export async function backfillLeadOwners(
  dryRun: boolean,
  rawKey = "lead_owner",
): Promise<BackfillResult> {
  const context = await getOrgContext();
  if (!context) {
    return { ok: false, error: "Not signed in.", dryRun, counts: {}, problems: [] };
  }

  const { data, error } = await context.supabase.rpc("backfill_lead_owners", {
    p_raw_key: rawKey,
    p_dry_run: dryRun,
  });

  if (error) {
    return { ok: false, error: error.message, dryRun, counts: {}, problems: [] };
  }

  const rows = (data ?? []) as BackfillRow[];
  const counts: Record<string, number> = {};
  for (const row of rows) counts[row.outcome] = (counts[row.outcome] ?? 0) + 1;

  if (!dryRun) {
    // Ownership is on the grid, gates the audit and write queues, and is one of
    // the things /settings counts as a blocker.
    for (const path of ["/leads", "/queue", "/audit", "/write", "/settings"]) {
      revalidatePath(path);
    }
  }

  return {
    ok: true,
    dryRun,
    counts,
    problems: rows.filter((row) => PROBLEM_OUTCOMES.has(row.outcome)).slice(0, 50),
  };
}

/**
 * The repair for sends already queued on the wrong person's mailbox.
 *
 * Routing was org-wide until 0032: pickMailbox() returned whichever mailbox was
 * emptiest, so an email one operator wrote went out from the other's account and
 * the reply landed in the wrong inbox. Fixing that forward does nothing for what
 * is already booked, and those go out within the day.
 *
 * Dry run first for the same reason as the ownership backfill: the tally is the
 * only chance to see a lead pinned to a thread, or an owner with no mailbox,
 * before anything moves.
 */
export interface RerouteRow {
  lead_id: string;
  company: string | null;
  send_id: string;
  step_number: number;
  from_mailbox: string | null;
  to_mailbox: string | null;
  outcome: string;
}

export interface RerouteResult {
  ok: boolean;
  error?: string;
  dryRun: boolean;
  counts: Record<string, number>;
  /** Everything that is not already correct, so it can be read before running. */
  notable: RerouteRow[];
}

export async function rerouteSendsToOwner(dryRun: boolean): Promise<RerouteResult> {
  const context = await getOrgContext();
  if (!context) {
    return { ok: false, error: "Not signed in.", dryRun, counts: {}, notable: [] };
  }

  const { data, error } = await context.supabase.rpc(
    "reroute_planned_sends_to_owner",
    { p_dry_run: dryRun },
  );

  if (error) {
    return { ok: false, error: error.message, dryRun, counts: {}, notable: [] };
  }

  const rows = (data ?? []) as RerouteRow[];
  const counts: Record<string, number> = {};
  for (const row of rows) counts[row.outcome] = (counts[row.outcome] ?? 0) + 1;

  if (!dryRun) {
    for (const path of ["/queue", "/write", "/leads", "/mailboxes"]) {
      revalidatePath(path);
    }
  }

  return {
    ok: true,
    dryRun,
    counts,
    notable: rows.filter((row) => row.outcome !== "already correct").slice(0, 50),
  };
}
