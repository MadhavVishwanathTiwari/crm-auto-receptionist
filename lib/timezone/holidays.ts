// US federal holidays, computed rather than kept as a hand-maintained table
// that quietly goes stale.
//
// These matter because a touch that lands on Thanksgiving is a wasted send from
// a capacity budget of ~40/day. Skipping one merely delays the touch by a day,
// so the cost of over-including a holiday is small and the cost of missing one
// is a burned send.

import { DateTime } from "luxon";

/** nth occurrence of a weekday in a month. weekday: 1=Mon .. 7=Sun (ISO). */
function nthWeekday(year: number, month: number, weekday: number, n: number) {
  const first = DateTime.utc(year, month, 1);
  const offset = (weekday - first.weekday + 7) % 7;
  return first.plus({ days: offset + (n - 1) * 7 });
}

function lastWeekday(year: number, month: number, weekday: number) {
  const last = DateTime.utc(year, month, 1).endOf("month").startOf("day");
  const offset = (last.weekday - weekday + 7) % 7;
  return last.minus({ days: offset });
}

/**
 * Federal rule: a holiday falling on Saturday is observed the Friday before,
 * on Sunday the Monday after. Only applies to fixed-date holidays.
 */
function observed(date: DateTime): DateTime {
  if (date.weekday === 6) return date.minus({ days: 1 });
  if (date.weekday === 7) return date.plus({ days: 1 });
  return date;
}

/** ISO dates (YYYY-MM-DD) of US federal holidays in the given year. */
export function usFederalHolidays(year: number): string[] {
  const thanksgiving = nthWeekday(year, 11, 4, 4);

  const dates = [
    observed(DateTime.utc(year, 1, 1)), // New Year's Day
    nthWeekday(year, 1, 1, 3), // MLK Jr Day
    nthWeekday(year, 2, 1, 3), // Presidents' Day
    lastWeekday(year, 5, 1), // Memorial Day
    observed(DateTime.utc(year, 6, 19)), // Juneteenth
    observed(DateTime.utc(year, 7, 4)), // Independence Day
    nthWeekday(year, 9, 1, 1), // Labor Day
    nthWeekday(year, 10, 1, 2), // Columbus Day
    observed(DateTime.utc(year, 11, 11)), // Veterans Day
    thanksgiving,
    // Not federal, but the entire ICP is closed and nobody reads email.
    thanksgiving.plus({ days: 1 }),
    observed(DateTime.utc(year, 12, 25)), // Christmas Day
  ];

  return dates.map((d) => d.toISODate()!).sort();
}

/** Holiday set spanning a range of years, for the planner's lookahead. */
export function holidaySet(fromYear: number, toYear: number): Set<string> {
  const out = new Set<string>();
  for (let y = fromYear; y <= toYear; y++) {
    for (const d of usFederalHolidays(y)) out.add(d);
  }
  return out;
}
