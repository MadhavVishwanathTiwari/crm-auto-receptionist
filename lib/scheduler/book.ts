// Booking ONE send: which instant, and out of which mailbox.
//
// lib/scheduler/slots.ts answers "when would this land in the prospect's
// morning". That is not enough to book anything, because a slot is only real if
// some mailbox still has room on the day it falls in, and room is counted in
// the MAILBOX's timezone rather than the prospect's. This file is the join of
// those two questions.
//
// It exists because the composer needs the answer BEFORE the operator presses
// send. "Goes out Tuesday 9:42am their time" is the sentence that makes it
// acceptable not to choose a time yourself; without it the app is just a text
// box that swallows your email. The planner needs the same arithmetic in a loop
// over hundreds of leads, so the capacity index is separated from the booking
// and both use it.
//
// Pure and synchronous, same as slots.ts, and for the same reason: this is the
// part most likely to be subtly wrong and it is only testable with no database
// and no clock of its own.

import { DateTime } from "luxon";

import { nextSlot, windowsFromSettings } from "@/lib/scheduler/slots";

export interface BookingSettings {
  morning_start_hour: number;
  morning_end_hour: number;
  afternoon_start_hour: number;
  afternoon_end_hour: number;
  max_lookahead_days: number;
  first_touch_weekdays: number[];
  followup_weekdays: number[];
}

export interface BookingMailbox {
  id: string;
  /** The zone the daily cap resets in. Never the prospect's. */
  timezone: string;
  daily_cap: number;
}

/** Anything already booked, in flight or sent, that consumes capacity. */
export interface CapacityConsumer {
  mailbox_id: string | null;
  scheduled_at: string;
}

/** mailbox id -> mailbox-local ISO date -> sends already booked that day. */
export type Capacity = Map<string, Map<string, number>>;

/**
 * What each mailbox has already committed to.
 *
 * Only days from `now` forward are counted. Capacity that has already been
 * spent cannot be planned into anyway, and counting it would make yesterday's
 * traffic reduce today's allowance.
 */
export function buildCapacity(
  mailboxes: BookingMailbox[],
  sends: CapacityConsumer[],
  now: DateTime,
): Capacity {
  const capacity: Capacity = new Map();
  for (const mailbox of mailboxes) capacity.set(mailbox.id, new Map());

  const byId = new Map(mailboxes.map((m) => [m.id, m]));

  for (const send of sends) {
    if (!send.mailbox_id) continue;
    const mailbox = byId.get(send.mailbox_id);
    if (!mailbox) continue;

    const at = DateTime.fromISO(send.scheduled_at).setZone(mailbox.timezone);
    if (!at.isValid || at < now.startOf("day")) continue;

    const days = capacity.get(mailbox.id)!;
    const key = at.toISODate()!;
    days.set(key, (days.get(key) ?? 0) + 1);
  }

  return capacity;
}

/** Books a seat, so a batch planning many sends does not oversubscribe a day. */
export function reserve(
  capacity: Capacity,
  mailboxId: string,
  isoDate: string,
): void {
  const days = capacity.get(mailboxId);
  if (!days) return;
  days.set(isoDate, (days.get(isoDate) ?? 0) + 1);
}

export interface MailboxChoice {
  mailbox: BookingMailbox;
  /** The MAILBOX-local date this send will be counted against. */
  capDate: string;
}

/**
 * The emptiest mailbox with room on the mailbox-local day this instant falls
 * in, or null if every one of them is full.
 *
 * Emptiest rather than first: sends dealt out evenly keep two warming accounts
 * at similar volume, and a mailbox that always goes first would hit its cap
 * every day while the other idles.
 */
export function pickMailbox(
  capacity: Capacity,
  mailboxes: BookingMailbox[],
  at: DateTime,
): MailboxChoice | null {
  let best: { mailbox: BookingMailbox; capDate: string; used: number } | null =
    null;

  for (const mailbox of mailboxes) {
    const capDate = at.setZone(mailbox.timezone).toISODate()!;
    const used = capacity.get(mailbox.id)?.get(capDate) ?? 0;
    if (used >= mailbox.daily_cap) continue;
    if (!best || used < best.used) best = { mailbox, capDate, used };
  }

  return best ? { mailbox: best.mailbox, capDate: best.capDate } : null;
}

export interface BookingRequest {
  now: DateTime;
  /** The prospect's IANA zone. A lead without one never reaches here. */
  zone: string;
  /** Earliest prospect-local day this touch may land on. */
  earliestDay: DateTime;
  /** 1 is a first touch, which uses the narrower weekday set. */
  step: number;
  /** Stable per send. Decides the minute, so two sends do not collide. */
  seed: string;
  settings: BookingSettings;
  mailboxes: BookingMailbox[];
  capacity: Capacity;
  holidays: Set<string>;
}

export type Booking =
  | {
      ok: true;
      at: DateTime;
      /**
       * The same instant as a prospect-local wall clock with no offset, which
       * is what scheduled_sends.scheduled_local stores and what the operator
       * was shown when they pressed send.
       */
      scheduledLocal: string;
      mailbox: BookingMailbox;
      capDate: string;
    }
  | { ok: false; reason: "no_mailbox" | "no_capacity" };

/**
 * The next instant this touch can actually go out, and the mailbox it goes from.
 *
 * Walks forward a day at a time: ask slots.ts for a sendable moment, ask the
 * mailboxes whether anyone has room on that day, and if nobody does, start
 * again from the following morning. A day with no capacity is not a reason to
 * give up, it is a reason to look at tomorrow.
 */
export function bookSlot(request: BookingRequest): Booking {
  const { now, zone, step, seed, settings, mailboxes, capacity, holidays } =
    request;

  if (mailboxes.length === 0) return { ok: false, reason: "no_mailbox" };

  const windows = windowsFromSettings(settings);
  const allowedWeekdays =
    step === 1 ? settings.first_touch_weekdays : settings.followup_weekdays;

  let cursor = request.earliestDay;

  for (let tries = 0; tries <= settings.max_lookahead_days; tries++) {
    const slot = nextSlot({
      notBefore: now,
      earliestDay: cursor,
      zone,
      windows,
      holidays,
      allowedWeekdays: allowedWeekdays ?? [],
      maxLookaheadDays: settings.max_lookahead_days,
      seed,
    });

    if (!slot.ok) break;

    const chosen = pickMailbox(capacity, mailboxes, slot.at);
    if (chosen) {
      return {
        ok: true,
        at: slot.at,
        scheduledLocal: slot.at.toFormat("yyyy-MM-dd'T'HH:mm:ss"),
        mailbox: chosen.mailbox,
        capDate: chosen.capDate,
      };
    }

    cursor = slot.at.plus({ days: 1 }).startOf("day");
    if (cursor.diff(request.earliestDay, "days").days > settings.max_lookahead_days) {
      break;
    }
  }

  return { ok: false, reason: "no_capacity" };
}
