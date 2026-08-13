// Choosing the instant a touch goes out.
//
// Everything in here is PROSPECT-LOCAL. The operator never sees UTC, the
// prospect never sees IST, and a lead with no resolvable zone never reaches
// this file at all — the planner refuses it before it gets here, because
// guessing a zone silently corrupts every send time downstream.
//
// Pure and synchronous on purpose: slot arithmetic is the part of the scheduler
// most likely to be subtly wrong, and it is only testable if it has no
// database and no clock of its own.

import { DateTime } from "luxon";

import { isBusinessDay } from "@/lib/timezone/businessDays";

/** Ends are EXCLUSIVE: 07:00-11:00 means the last eligible start is 10:59. */
export interface SendWindow {
  startHour: number;
  endHour: number;
}

export interface SlotRequest {
  /** The slot must fall strictly after this instant. Usually "now". */
  notBefore: DateTime;
  /** Earliest prospect-local calendar day to consider. */
  earliestDay: DateTime;
  zone: string;
  windows: SendWindow[];
  holidays: Set<string>;
  /** ISO weekdays, 1 = Monday. Empty means any business day. */
  allowedWeekdays: number[];
  maxLookaheadDays: number;
  /** Anything stable per send. Decides the minute, so re-planning must vary it. */
  seed: string;
}

export type SlotResult =
  | { ok: true; at: DateTime }
  | { ok: false; reason: "lookahead_exhausted" };

/**
 * FNV-1a. Not for security — this only has to spread minutes evenly and
 * produce the same answer on two machines, and a stable 20-line hash beats
 * Math.random() precisely because it is reproducible: the same send re-planned
 * from the same attempt number lands on the same minute, so a retry after a
 * crash is not a second, different slot.
 */
function hash(seed: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/**
 * The next sendable slot.
 *
 * Days are walked forward from `earliestDay`; each candidate day must be a
 * business day, must be one of `allowedWeekdays`, and must have a window with
 * room left in it after `notBefore`. Within a window the minute is chosen by
 * hash rather than sequentially, so forty sends in a morning do not all leave
 * at 07:00 and look exactly like what they are.
 */
export function nextSlot(request: SlotRequest): SlotResult {
  const {
    notBefore,
    zone,
    windows,
    holidays,
    allowedWeekdays,
    maxLookaheadDays,
    seed,
  } = request;

  if (windows.length === 0) return { ok: false, reason: "lookahead_exhausted" };

  const start = request.earliestDay.setZone(zone).startOf("day");
  const floor = notBefore.setZone(zone);

  for (let dayOffset = 0; dayOffset <= maxLookaheadDays; dayOffset++) {
    const day = start.plus({ days: dayOffset });

    if (!isBusinessDay(day, holidays)) continue;
    if (allowedWeekdays.length > 0 && !allowedWeekdays.includes(day.weekday)) {
      continue;
    }

    // Which window to try first is seeded too, so first touches do not pile
    // into the morning and follow-ups into whatever is left.
    const offset = hash(`${seed}:${day.toISODate()}`) % windows.length;

    for (let i = 0; i < windows.length; i++) {
      const window = windows[(offset + i) % windows.length]!;

      const windowStart = window.startHour * 60;
      const windowEnd = window.endHour * 60; // exclusive

      // On the first day the window may be half over. Take the remaining part
      // rather than writing the whole day off: at 14:00 a 13:00-16:00 window
      // still has two hours of capacity in it.
      let earliestMinute = windowStart;
      if (day.hasSame(floor, "day")) {
        // +1 so the slot is strictly after notBefore, never exactly on it.
        earliestMinute = Math.max(windowStart, floor.hour * 60 + floor.minute + 1);
      } else if (day < floor.startOf("day")) {
        // earliestDay was in the past. Nothing on it is sendable.
        continue;
      }

      if (earliestMinute >= windowEnd) continue;

      const span = windowEnd - earliestMinute;
      const minute =
        earliestMinute + (hash(`${seed}:${day.toISODate()}:${window.startHour}`) % span);

      const at = day.set({
        hour: Math.floor(minute / 60),
        minute: minute % 60,
        second: 0,
        millisecond: 0,
      });

      // A DST spring-forward can land the chosen wall clock on an hour that
      // does not exist, which Luxon resolves forward. Re-check rather than
      // trusting the arithmetic.
      if (at > notBefore) return { ok: true, at };
    }
  }

  return { ok: false, reason: "lookahead_exhausted" };
}

/**
 * Business days between touches, counted from the PREVIOUS step's actual send
 * rather than from when it was planned. A T2 that was meant to follow three
 * days after a T1 which itself slipped two days must not arrive one day later.
 */
export const CADENCE_BUSINESS_DAYS: Record<number, number> = {
  2: 3,
  3: 4,
  4: 5,
};

export const MAX_STEP = 4;

/** Windows from org_settings, in chronological order. Ends stay exclusive. */
export function windowsFromSettings(settings: {
  morning_start_hour: number;
  morning_end_hour: number;
  afternoon_start_hour: number;
  afternoon_end_hour: number;
}): SendWindow[] {
  return [
    { startHour: settings.morning_start_hour, endHour: settings.morning_end_hour },
    {
      startHour: settings.afternoon_start_hour,
      endHour: settings.afternoon_end_hour,
    },
  ];
}
