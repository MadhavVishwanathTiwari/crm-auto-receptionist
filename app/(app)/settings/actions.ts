"use server";

import { IANAZone } from "luxon";
import { revalidatePath } from "next/cache";

import { getOrgContext } from "@/lib/org";
import { isJobName, type JobRun, runJob } from "@/lib/ops/jobs";

export interface ActionResult {
  ok: boolean;
  error?: string;
}

export interface OrgSettingsInput {
  dryRun: boolean;
  operatorTimezone: string;
  morningStartHour: number;
  morningEndHour: number;
  afternoonStartHour: number;
  afternoonEndHour: number;
  /** ISO weekday numbers, 1 = Monday. */
  firstTouchWeekdays: number[];
  followupWeekdays: number[];
  maxLookaheadDays: number;
  slotGraceMinutes: number;
  stallMinutes: number;
}

const HOUR = (value: number) => Number.isInteger(value) && value >= 0 && value <= 23;

/**
 * The org's send policy, including the dry-run kill switch.
 *
 * The window checks below are duplicated from the CHECK constraints on
 * org_settings on purpose. The database is the enforcement; repeating them here
 * is what turns "23514 violates constraint org_settings_windows_ordered" into a
 * sentence an operator can act on.
 */
export async function updateOrgSettings(
  input: OrgSettingsInput,
): Promise<ActionResult> {
  const context = await getOrgContext();
  if (!context) return { ok: false, error: "Not signed in." };

  if (
    !HOUR(input.morningStartHour) ||
    !HOUR(input.morningEndHour) ||
    !HOUR(input.afternoonStartHour) ||
    !HOUR(input.afternoonEndHour)
  ) {
    return { ok: false, error: "Window hours have to be whole hours from 0 to 23." };
  }
  if (input.morningStartHour >= input.morningEndHour) {
    return { ok: false, error: "The morning window has to start before it ends." };
  }
  if (input.afternoonStartHour >= input.afternoonEndHour) {
    return { ok: false, error: "The afternoon window has to start before it ends." };
  }
  if (input.morningEndHour > input.afternoonStartHour) {
    return {
      ok: false,
      error: "The morning window has to close before the afternoon one opens.",
    };
  }

  const weekdaysValid = (days: number[]) =>
    days.length >= 1 && days.every((d) => Number.isInteger(d) && d >= 1 && d <= 5);

  if (!weekdaysValid(input.firstTouchWeekdays)) {
    return { ok: false, error: "Pick at least one weekday for first touches." };
  }
  if (!weekdaysValid(input.followupWeekdays)) {
    return { ok: false, error: "Pick at least one weekday for follow-ups." };
  }

  // The operator's zone, not a prospect's. Getting it wrong shifts which day a
  // mailbox cap resets in rather than corrupting a send time, but it is the
  // same class of mistake, so it gets the same validation.
  if (!IANAZone.isValidZone(input.operatorTimezone)) {
    return { ok: false, error: `"${input.operatorTimezone}" is not an IANA timezone.` };
  }

  if (!Number.isInteger(input.maxLookaheadDays) || input.maxLookaheadDays < 1) {
    return { ok: false, error: "Lookahead has to be at least one day." };
  }
  if (!Number.isInteger(input.slotGraceMinutes) || input.slotGraceMinutes < 1) {
    return { ok: false, error: "Slot grace has to be at least a minute." };
  }
  if (!Number.isInteger(input.stallMinutes) || input.stallMinutes < 1) {
    return { ok: false, error: "The stall timeout has to be at least a minute." };
  }

  const { data, error } = await context.supabase
    .from("org_settings")
    .update({
      dry_run: input.dryRun,
      operator_timezone: input.operatorTimezone,
      morning_start_hour: input.morningStartHour,
      morning_end_hour: input.morningEndHour,
      afternoon_start_hour: input.afternoonStartHour,
      afternoon_end_hour: input.afternoonEndHour,
      first_touch_weekdays: [...input.firstTouchWeekdays].sort(),
      followup_weekdays: [...input.followupWeekdays].sort(),
      max_lookahead_days: input.maxLookaheadDays,
      slot_grace_minutes: input.slotGraceMinutes,
      stall_minutes: input.stallMinutes,
    })
    .eq("org_id", context.orgId)
    .select("org_id");

  if (error) return { ok: false, error: error.message };
  // A PostgREST update denied by RLS is 204 with zero rows and no error, so
  // the empty result IS the denial. org_settings_update requires admin.
  if (!data || data.length === 0) {
    return {
      ok: false,
      error: "Only an admin can change the send policy.",
    };
  }

  revalidatePath("/settings");
  revalidatePath("/queue");
  return { ok: true };
}

export interface JobRunResult extends JobRun {
  job: string;
}

/**
 * Runs one background job now.
 *
 * Membership is the only check: both operators need to be able to drain the
 * queue, and the job itself is idempotent by construction (the planner's unique
 * (lead, step) constraint, the dispatcher's claim transition). Admin-gating this
 * would mean one operator waiting on the other to press a button.
 */
export async function runJobNow(name: string): Promise<JobRunResult> {
  const context = await getOrgContext();
  if (!context) {
    return { job: name, ok: false, status: 401, body: null, error: "Not signed in." };
  }
  if (!isJobName(name)) {
    return { job: name, ok: false, status: 400, body: null, error: "No such job." };
  }

  const result = await runJob(name);

  // Every job writes something a page is showing: leads, sends, alerts.
  revalidatePath("/settings");
  revalidatePath("/queue");
  revalidatePath("/leads");
  revalidatePath("/alerts");

  return { job: name, ...result };
}
