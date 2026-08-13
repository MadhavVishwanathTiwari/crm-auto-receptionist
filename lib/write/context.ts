// Everything the composer needs to answer one question: if I write to this
// lead right now, when does it leave and out of which mailbox?
//
// Loaded once and shared by the two callers who must not disagree:
//
//   app/(app)/write/page.tsx   previews a slot for every lead in the worklist,
//                              so the operator sees "Tue 9:42am their time"
//                              before writing a word
//   app/(app)/write/actions.ts books the one they actually wrote
//
// If those two computed slots differently, the app would promise one time and
// book another, which is the single thing a scheduler is not allowed to do.

import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { DateTime } from "luxon";

import {
  buildCapacity,
  type BookingMailbox,
  type BookingSettings,
  type Capacity,
} from "@/lib/scheduler/book";
import { CADENCE_BUSINESS_DAYS, MAX_STEP } from "@/lib/scheduler/slots";
import { addBusinessDays } from "@/lib/timezone/businessDays";
import { holidaySet } from "@/lib/timezone/holidays";

/** A mailbox the composer can actually send from. */
export interface WriteMailbox extends BookingMailbox {
  email: string;
  /** The From header, and {{sender_name}}. Null blocks sending. */
  display_name: string | null;
}

export interface WriteSend {
  id: string;
  lead_id: string;
  step_number: number;
  status: string;
  scheduled_at: string;
  scheduled_local: string;
  sent_at: string | null;
  composed_body: string | null;
  composed_subject: string | null;
}

export interface WriteContext {
  settings: BookingSettings & { dry_run: boolean };
  mailboxes: WriteMailbox[];
  /** Every live send in the org, grouped by lead. */
  sendsByLead: Map<string, WriteSend[]>;
  capacity: Capacity;
  holidays: Set<string>;
  suppressedEmails: Set<string>;
  suppressedDomains: Set<string>;
  now: DateTime;
}

/** Booked, in flight, or already out: everything that consumes a step. */
const LIVE_STATUSES = ["planned", "blocked", "claimed", "sending", "sent"];

export async function loadWriteContext(
  supabase: SupabaseClient,
): Promise<WriteContext | null> {
  const now = DateTime.now();

  const [
    { data: settingsRow },
    { data: mailboxRows },
    { data: sendRows },
    { data: suppressionRows },
  ] = await Promise.all([
    supabase
      .from("org_settings")
      // One string literal: concatenating a select list collapses supabase-js's
      // result type to an error type.
      .select(
        "morning_start_hour, morning_end_hour, afternoon_start_hour, afternoon_end_hour, max_lookahead_days, first_touch_weekdays, followup_weekdays, dry_run",
      )
      .maybeSingle(),
    supabase
      .from("mailboxes")
      .select("id, email, display_name, timezone, daily_cap")
      .eq("is_sendable", true)
      .order("id"),
    supabase
      .from("scheduled_sends")
      .select(
        "id, lead_id, mailbox_id, step_number, status, scheduled_at, scheduled_local, sent_at, composed_body, composed_subject",
      )
      .in("status", LIVE_STATUSES)
      .limit(5000),
    supabase.from("suppressions").select("email_norm, domain"),
  ]);

  if (!settingsRow) return null;

  const mailboxes = (mailboxRows ?? []) as WriteMailbox[];
  const sends = (sendRows ?? []) as (WriteSend & { mailbox_id: string | null })[];

  const sendsByLead = new Map<string, WriteSend[]>();
  for (const send of sends) {
    const list = sendsByLead.get(send.lead_id);
    if (list) list.push(send);
    else sendsByLead.set(send.lead_id, [send]);
  }

  return {
    settings: settingsRow as BookingSettings & { dry_run: boolean },
    mailboxes,
    sendsByLead,
    capacity: buildCapacity(mailboxes, sends, now),
    // Two years, matching the planner. A lookahead cannot reach past that.
    holidays: holidaySet(now.year, now.year + 2),
    suppressedEmails: new Set(
      (suppressionRows ?? []).map((s) => s.email_norm).filter(Boolean) as string[],
    ),
    suppressedDomains: new Set(
      (suppressionRows ?? []).map((s) => s.domain).filter(Boolean) as string[],
    ),
    now,
  };
}

export type NextStep =
  | { ok: true; step: number; replaces: WriteSend | null; lastSentAt: string | null }
  | { ok: false; reason: "in_flight" | "sequence_finished" };

/**
 * Which touch a hand-written email would be, given what this lead already has.
 *
 * A `planned` or `blocked` row is REPLACED rather than added to. An operator
 * writing a personal first touch to a lead the planner had already queued from
 * a template is saying "send mine instead", and the partial unique index on
 * (lead_id, step_number) would otherwise turn that into a duplicate key error.
 *
 * A `claimed` or `sending` row is refused. By then the dispatcher may already
 * be inside the Gmail call, and replacing the body under it would mean the
 * timeline says one thing and the prospect's inbox says another.
 */
export function nextStepFor(sends: WriteSend[]): NextStep {
  if (sends.some((s) => s.status === "claimed" || s.status === "sending")) {
    return { ok: false, reason: "in_flight" };
  }

  const live = sends.find(
    (s) => s.status === "planned" || s.status === "blocked",
  );

  const sent = sends.filter((s) => s.status === "sent");
  const lastSent = sent.reduce<WriteSend | null>(
    (best, s) => (best === null || s.step_number > best.step_number ? s : best),
    null,
  );

  const step = live ? live.step_number : (lastSent?.step_number ?? 0) + 1;
  if (step > MAX_STEP) return { ok: false, reason: "sequence_finished" };

  return { ok: true, step, replaces: live ?? null, lastSentAt: lastSent?.sent_at ?? null };
}

/**
 * The earliest prospect-local day this touch may land on.
 *
 * For a follow-up that is counted in business days from the previous step's
 * ACTUAL send, not from when it was planned: a T2 meant to follow three days
 * after a T1 that itself slipped must not arrive one day later.
 */
export function earliestDayFor(
  step: number,
  lastSentAt: string | null,
  zone: string,
  now: DateTime,
  holidays: Set<string>,
): DateTime {
  if (step <= 1 || !lastSentAt) return now.setZone(zone).startOf("day");

  return addBusinessDays(
    DateTime.fromISO(lastSentAt).setZone(zone).startOf("day"),
    CADENCE_BUSINESS_DAYS[step] ?? 0,
    holidays,
  );
}
