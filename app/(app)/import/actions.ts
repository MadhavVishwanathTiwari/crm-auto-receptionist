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

/**
 * The repair for leads whose `website` is a Google Maps link.
 *
 * `url` was a synonym of `website` and it is the first column in the Clay
 * export, so it won that field before the real `website` column was reached.
 * website_domain is generated from website, a maps link normalizes to
 * google.com, and that domain is the demo builder's join key and the second
 * thing near-duplicate detection checks.
 *
 * Recoverable only because commitImport stores the original CSV row as `raw`.
 * Dry run first: the tally is where a lead whose demo was already built against
 * the wrong domain shows up, and that one needs a person rather than a rerun.
 */
export interface WebsiteRepairRow {
  lead_id: string;
  company: string | null;
  old_website: string | null;
  new_website: string | null;
  outcome: string;
}

export interface WebsiteRepairResult {
  ok: boolean;
  error?: string;
  dryRun: boolean;
  counts: Record<string, number>;
  /** A sample of what would change, so the mapping can be sanity-checked. */
  notable: WebsiteRepairRow[];
}

export async function repairLeadWebsites(
  dryRun: boolean,
): Promise<WebsiteRepairResult> {
  const context = await getOrgContext();
  if (!context) {
    return { ok: false, error: "Not signed in.", dryRun, counts: {}, notable: [] };
  }

  const { data, error } = await context.supabase.rpc("repair_lead_websites", {
    p_dry_run: dryRun,
  });

  if (error) {
    return { ok: false, error: error.message, dryRun, counts: {}, notable: [] };
  }

  const rows = (data ?? []) as WebsiteRepairRow[];
  const counts: Record<string, number> = {};
  for (const row of rows) counts[row.outcome] = (counts[row.outcome] ?? 0) + 1;

  if (!dryRun) {
    // website_domain feeds the demo queue and the leads grid.
    for (const path of ["/leads", "/queue", "/write"]) {
      revalidatePath(path);
    }
  }

  return { ok: true, dryRun, counts, notable: rows.slice(0, 50) };
}

/**
 * The repair for emails that went out and were never recorded.
 *
 * Until 0040, mark_send_sent() raised on every call: the mailbox guard refused
 * its own definer function. Gmail had already accepted each message, the row
 * was reaped as `stalled`, and the planner booked the same step again. The
 * result is one `stalled` row per email that actually went out.
 *
 * This records each lead's step once, dated from its LATEST attempt so T2's
 * cadence counts from the most recent email, and marks the rest as repeats.
 * Dry run first: the tally shows how many emails each business really got, and
 * which re-booked touches (including hand-written ones) are about to be
 * cancelled because that step already went out.
 */
export interface StalledRepairRow {
  lead_id: string;
  company: string | null;
  step_number: number;
  attempts: number;
  recorded_at: string | null;
  cancelled_planned: number;
  cancelled_written: number;
  outcome: string;
}

export interface StalledRepairResult {
  ok: boolean;
  error?: string;
  dryRun: boolean;
  counts: Record<string, number>;
  notable: StalledRepairRow[];
}

export async function repairStalledSends(
  dryRun: boolean,
): Promise<StalledRepairResult> {
  const context = await getOrgContext();
  if (!context) {
    return { ok: false, error: "Not signed in.", dryRun, counts: {}, notable: [] };
  }

  const { data, error } = await context.supabase.rpc("repair_stalled_sends", {
    p_dry_run: dryRun,
  });

  if (error) {
    return { ok: false, error: error.message, dryRun, counts: {}, notable: [] };
  }

  const rows = (data ?? []) as StalledRepairRow[];
  const counts: Record<string, number> = {};
  for (const row of rows) {
    // Errors carry the message in the outcome, so one bucket rather than one
    // per message. The rows themselves still show the text.
    const key = row.outcome.startsWith("error:") ? "error" : row.outcome;
    counts[key] = (counts[key] ?? 0) + 1;
  }

  if (!dryRun) {
    // Status, the queue, the composer's worklist and every mailbox's last send.
    for (const path of ["/leads", "/queue", "/write", "/mailboxes", "/pipeline"]) {
      revalidatePath(path);
    }
  }

  return {
    ok: true,
    dryRun,
    counts,
    // Most repeats first: those are the businesses that most need a human look.
    notable: [...rows].sort((a, b) => b.attempts - a.attempts).slice(0, 50),
  };
}
