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
  /**
   * How far apart two bookings on one mailbox are kept, in minutes (0041).
   * The MAXIMUM of the dispatcher's random gap, so a booked send is never held
   * at dispatch for longer than a cron tick and the time /write shows is the
   * time it leaves. Absent or 0 means no spacing, which is what the unit tests
   * written before it assume.
   */
  send_gap_max_minutes?: number;
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

/** What each mailbox has already committed to, from today on. */
export interface Capacity {
  /** mailbox id -> mailbox-local ISO date -> sends already booked that day. */
  days: Map<string, Map<string, number>>;
  /**
   * mailbox id -> every booked instant, as epoch millis. The daily count says
   * whether a mailbox has room; only this says whether a new send would sit
   * too close to one already booked on it.
   */
  instants: Map<string, number[]>;
}

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
  const capacity: Capacity = { days: new Map(), instants: new Map() };
  for (const mailbox of mailboxes) {
    capacity.days.set(mailbox.id, new Map());
    capacity.instants.set(mailbox.id, []);
  }

  const byId = new Map(mailboxes.map((m) => [m.id, m]));

  for (const send of sends) {
    if (!send.mailbox_id) continue;
    const mailbox = byId.get(send.mailbox_id);
    if (!mailbox) continue;

    const at = DateTime.fromISO(send.scheduled_at).setZone(mailbox.timezone);
    if (!at.isValid || at < now.startOf("day")) continue;

    const days = capacity.days.get(mailbox.id)!;
    const key = at.toISODate()!;
    days.set(key, (days.get(key) ?? 0) + 1);
    capacity.instants.get(mailbox.id)!.push(at.toMillis());
  }

  return capacity;
}

/**
 * Books a seat, so a batch planning many sends does not oversubscribe a day.
 *
 * Pass `at` whenever there is one. Without it the day is counted but the
 * instant is not, and the next booking can land right on top of this one.
 */
export function reserve(
  capacity: Capacity,
  mailboxId: string,
  isoDate: string,
  at?: DateTime,
): void {
  const days = capacity.days.get(mailboxId);
  if (!days) return;
  days.set(isoDate, (days.get(isoDate) ?? 0) + 1);
  if (at) capacity.instants.get(mailboxId)?.push(at.toMillis());
}

export interface MailboxChoice {
  mailbox: BookingMailbox;
  /** The MAILBOX-local date this send will be counted against. */
  capDate: string;
}

/**
 * The emptiest mailbox with room on the mailbox-local day this instant falls
 * in, and nothing booked within `gapMinutes` of it, or null if there is none.
 *
 * Emptiest rather than first: sends dealt out evenly keep two warming accounts
 * at similar volume, and a mailbox that always goes first would hit its cap
 * every day while the other idles.
 */
export function pickMailbox(
  capacity: Capacity,
  mailboxes: BookingMailbox[],
  at: DateTime,
  gapMinutes = 0,
): MailboxChoice | null {
  const gapMs = gapMinutes * 60_000;
  const instant = at.toMillis();

  let best: { mailbox: BookingMailbox; capDate: string; used: number } | null =
    null;

  for (const mailbox of mailboxes) {
    const capDate = at.setZone(mailbox.timezone).toISODate()!;
    const used = capacity.days.get(mailbox.id)?.get(capDate) ?? 0;
    if (used >= mailbox.daily_cap) continue;

    if (
      gapMs > 0 &&
      (capacity.instants.get(mailbox.id) ?? []).some(
        (booked) => Math.abs(booked - instant) < gapMs,
      )
    ) {
      continue;
    }

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
 * nextSlot() walks the prospect's days and windows; this hands it the question
 * "would some mailbox take a send at this minute" to ask of every candidate.
 * A full day, or a minute too close to another booking, is not a reason to give
 * up: nextSlot tries another minute of the window, then the next window, then
 * the next day, until the lookahead runs out.
 */
export function bookSlot(request: BookingRequest): Booking {
  const { now, zone, step, seed, settings, mailboxes, capacity, holidays } =
    request;

  if (mailboxes.length === 0) return { ok: false, reason: "no_mailbox" };

  const gap = settings.send_gap_max_minutes ?? 0;
  const allowedWeekdays =
    step === 1 ? settings.first_touch_weekdays : settings.followup_weekdays;

  const slot = nextSlot({
    notBefore: now,
    earliestDay: request.earliestDay,
    zone,
    windows: windowsFromSettings(settings),
    holidays,
    allowedWeekdays: allowedWeekdays ?? [],
    maxLookaheadDays: settings.max_lookahead_days,
    seed,
    accept: (at) => pickMailbox(capacity, mailboxes, at, gap) !== null,
  });

  if (!slot.ok) return { ok: false, reason: "no_capacity" };

  // Accepted above, so this cannot be null; asked again because the accept
  // callback only answers yes or no and the booking needs which mailbox.
  const chosen = pickMailbox(capacity, mailboxes, slot.at, gap)!;

  return {
    ok: true,
    at: slot.at,
    scheduledLocal: slot.at.toFormat("yyyy-MM-dd'T'HH:mm:ss"),
    mailbox: chosen.mailbox,
    capDate: chosen.capDate,
  };
}
