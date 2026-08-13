import { DateTime } from "luxon";
import { describe, expect, it } from "vitest";

import { nextSlot, windowsFromSettings } from "@/lib/scheduler/slots";
import { holidaySet } from "@/lib/timezone/holidays";

const ZONE = "America/Chicago";
const WINDOWS = windowsFromSettings({
  morning_start_hour: 7,
  morning_end_hour: 11,
  afternoon_start_hour: 13,
  afternoon_end_hour: 16,
});
const NO_HOLIDAYS = new Set<string>();
const WEEKDAYS = [1, 2, 3, 4, 5];

/** Monday 10 August 2026, 02:00 in the prospect's zone. */
const MONDAY_EARLY = DateTime.fromISO("2026-08-10T02:00:00", { zone: ZONE });

function ask(overrides: Partial<Parameters<typeof nextSlot>[0]> = {}) {
  return nextSlot({
    notBefore: MONDAY_EARLY,
    earliestDay: MONDAY_EARLY,
    zone: ZONE,
    windows: WINDOWS,
    holidays: NO_HOLIDAYS,
    allowedWeekdays: WEEKDAYS,
    maxLookaheadDays: 30,
    seed: "lead:1:0",
    ...overrides,
  });
}

function minuteOfDay(at: DateTime) {
  return at.hour * 60 + at.minute;
}

describe("slot selection", () => {
  it("lands inside a window, in the prospect's zone", () => {
    const result = ask();
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.at.zoneName).toBe(ZONE);
    expect(result.at.toISODate()).toBe("2026-08-10");
  });

  it("never starts at or after the exclusive end of a window", () => {
    // 07:00-11:00 means the last eligible start is 10:59. An off-by-one here
    // sends outside the window the prospect was chosen for.
    for (let i = 0; i < 400; i++) {
      const result = ask({ seed: `lead-${i}:1:0` });
      expect(result.ok).toBe(true);
      if (!result.ok) continue;

      const minute = minuteOfDay(result.at);
      const inMorning = minute >= 7 * 60 && minute < 11 * 60;
      const inAfternoon = minute >= 13 * 60 && minute < 16 * 60;
      expect(inMorning || inAfternoon, result.at.toISO() ?? "").toBe(true);
    }
  });

  it("uses more than one minute across leads", () => {
    // Forty sends leaving at exactly 07:00 look like exactly what they are.
    const minutes = new Set<number>();
    for (let i = 0; i < 40; i++) {
      const result = ask({ seed: `spread-${i}:1:0` });
      if (result.ok) minutes.add(minuteOfDay(result.at));
    }
    expect(minutes.size).toBeGreaterThan(5);
  });

  it("is deterministic for the same seed and varies with the attempt", () => {
    const first = ask({ seed: "same:1:0" });
    const again = ask({ seed: "same:1:0" });
    expect(first.ok && again.ok && +first.at === +again.at).toBe(true);

    const attempts = new Set<number>();
    for (let attempt = 0; attempt < 20; attempt++) {
      const result = ask({ seed: `same:1:${attempt}` });
      if (result.ok) attempts.add(+result.at);
    }
    // A re-planned send must be able to move, or a missed slot rolls forward
    // onto the same busy minute forever.
    expect(attempts.size).toBeGreaterThan(1);
  });

  it("skips the weekend", () => {
    const saturday = DateTime.fromISO("2026-08-15T09:00:00", { zone: ZONE });
    const result = ask({ notBefore: saturday, earliestDay: saturday });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.at.toISODate()).toBe("2026-08-17"); // the Monday
  });

  it("skips a federal holiday", () => {
    // 4 July 2026 falls on a Saturday, so it is observed on Friday the 3rd.
    const holidays = holidaySet(2026, 2026);
    const friday = DateTime.fromISO("2026-07-03T06:00:00", { zone: ZONE });
    expect(holidays.has("2026-07-03")).toBe(true);

    const result = ask({
      notBefore: friday,
      earliestDay: friday,
      holidays,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.at.toISODate()).toBe("2026-07-06");
  });

  it("honours the weekday preference for a first touch", () => {
    // Tue/Wed/Thu. A Monday first touch competes with the weekend backlog and
    // a Friday one is old by the time it is read.
    for (let i = 0; i < 30; i++) {
      const result = ask({ allowedWeekdays: [2, 3, 4], seed: `pref-${i}:1:0` });
      expect(result.ok).toBe(true);
      if (!result.ok) continue;
      expect([2, 3, 4]).toContain(result.at.weekday);
    }
  });

  it("uses what is left of a window rather than writing the day off", () => {
    // 14:30 on a Monday. The morning is gone; the afternoon still has ninety
    // minutes of capacity in it.
    const afternoon = DateTime.fromISO("2026-08-10T14:30:00", { zone: ZONE });
    const result = ask({ notBefore: afternoon, earliestDay: afternoon });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.at.toISODate()).toBe("2026-08-10");
    expect(+result.at).toBeGreaterThan(+afternoon);
    expect(minuteOfDay(result.at)).toBeLessThan(16 * 60);
  });

  it("moves to the next day once the last window has closed", () => {
    const evening = DateTime.fromISO("2026-08-10T19:00:00", { zone: ZONE });
    const result = ask({ notBefore: evening, earliestDay: evening });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.at.toISODate()).toBe("2026-08-11");
  });

  it("reports exhaustion instead of guessing when nothing fits", () => {
    // Mondays only, looking three days ahead, starting on a Tuesday.
    const tuesday = DateTime.fromISO("2026-08-11T06:00:00", { zone: ZONE });
    const result = ask({
      notBefore: tuesday,
      earliestDay: tuesday,
      allowedWeekdays: [1],
      maxLookaheadDays: 3,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("lookahead_exhausted");
  });

  it("is prospect-local, so the same wall clock is a different instant per zone", () => {
    const chicago = ask({ zone: "America/Chicago" });
    const losAngeles = nextSlot({
      notBefore: MONDAY_EARLY,
      earliestDay: MONDAY_EARLY,
      zone: "America/Los_Angeles",
      windows: WINDOWS,
      holidays: NO_HOLIDAYS,
      allowedWeekdays: WEEKDAYS,
      maxLookaheadDays: 30,
      seed: "lead:1:0",
    });

    expect(chicago.ok && losAngeles.ok).toBe(true);
    if (!chicago.ok || !losAngeles.ok) return;

    // Same seed, so the same wall-clock minute is chosen. A prospect in
    // Los Angeles gets it two hours later in absolute time, which is the whole
    // reason none of this arithmetic happens in UTC.
    expect(minuteOfDay(chicago.at)).toBe(minuteOfDay(losAngeles.at));
    expect(+losAngeles.at).toBeGreaterThan(+chicago.at);
  });
});
