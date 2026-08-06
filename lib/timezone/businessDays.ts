// Business-day arithmetic, in PROSPECT-local calendar days.
//
// The cadence is T1 -> +3 business days -> T2 -> +4 -> T3 -> +5 -> T4, and each
// offset is counted from the previous step's ACTUAL send. Counting in the
// prospect's calendar rather than the operator's is what keeps a send from
// drifting a day when the two are on opposite sides of midnight.

import { DateTime } from "luxon";

/** Mon-Fri and not a holiday. */
export function isBusinessDay(date: DateTime, holidays: Set<string>): boolean {
  if (date.weekday > 5) return false;
  return !holidays.has(date.toISODate()!);
}

/**
 * Advances `count` business days from `start`.
 *
 * `start` is first normalized forward to a business day, so an offset of 0
 * means "this day if we can send on it, otherwise the next one we can". A
 * sequence step whose previous touch went out on a Friday therefore lands its
 * +3 on the following Wednesday, not on the weekend.
 */
export function addBusinessDays(
  start: DateTime,
  count: number,
  holidays: Set<string>,
): DateTime {
  if (count < 0) throw new Error("addBusinessDays: count must be >= 0");

  let cursor = start.startOf("day");
  while (!isBusinessDay(cursor, holidays)) {
    cursor = cursor.plus({ days: 1 });
  }

  let remaining = count;
  while (remaining > 0) {
    cursor = cursor.plus({ days: 1 });
    if (isBusinessDay(cursor, holidays)) remaining -= 1;
  }

  return cursor;
}

/** Business days between two dates, exclusive of `from`, inclusive of `to`. */
export function businessDaysBetween(
  from: DateTime,
  to: DateTime,
  holidays: Set<string>,
): number {
  let cursor = from.startOf("day");
  const end = to.startOf("day");
  let count = 0;

  while (cursor < end) {
    cursor = cursor.plus({ days: 1 });
    if (isBusinessDay(cursor, holidays)) count += 1;
  }

  return count;
}
