import { DateTime } from "luxon";
import { describe, expect, it } from "vitest";

import {
  addBusinessDays,
  businessDaysBetween,
  isBusinessDay,
} from "@/lib/timezone/businessDays";
import { holidaySet, usFederalHolidays } from "@/lib/timezone/holidays";
import { resolveTimezone } from "@/lib/timezone/resolve";

describe("resolveTimezone", () => {
  it("resolves the sample Phoenix lead", () => {
    // The row from the sample Clay export. Phoenix is the case a state lookup
    // table gets wrong all year, since Arizona does not observe DST.
    expect(resolveTimezone(33.4484, -112.074)).toEqual({
      ok: true,
      timezone: "America/Phoenix",
    });
  });

  it("splits a multi-zone state correctly", () => {
    // Florida: Miami is Eastern, Pensacola in the panhandle is Central. This is
    // the pair that makes a state -> timezone table silently wrong.
    expect(resolveTimezone(25.7617, -80.1918)).toEqual({
      ok: true,
      timezone: "America/New_York",
    });
    expect(resolveTimezone(30.4213, -87.2169)).toEqual({
      ok: true,
      timezone: "America/Chicago",
    });
  });

  it("splits Tennessee and Texas too", () => {
    expect(resolveTimezone(35.9606, -83.9207)).toMatchObject({
      timezone: "America/New_York", // Knoxville
    });
    expect(resolveTimezone(31.7619, -106.485)).toMatchObject({
      timezone: "America/Denver", // El Paso
    });
    expect(resolveTimezone(29.7604, -95.3698)).toMatchObject({
      timezone: "America/Chicago", // Houston
    });
  });

  it("accepts numeric strings, since CSV columns arrive as text", () => {
    expect(resolveTimezone("33.4484", "-112.0740")).toEqual({
      ok: true,
      timezone: "America/Phoenix",
    });
  });

  it("refuses to guess when coordinates are missing or junk", () => {
    for (const [lat, lng] of [
      [null, null],
      [undefined, undefined],
      ["", ""],
      ["abc", "def"],
      [0, 0], // Null Island: a failed geocode, not a location
    ] as const) {
      expect(resolveTimezone(lat, lng)).toEqual({
        ok: false,
        reason: "no_coordinates",
      });
    }
  });

  it("rejects out-of-range coordinates", () => {
    expect(resolveTimezone(91, 0).ok).toBe(false);
    expect(resolveTimezone(0, 181).ok).toBe(false);
  });
});

describe("usFederalHolidays", () => {
  it("computes 2026 correctly", () => {
    const holidays = usFederalHolidays(2026);

    expect(holidays).toContain("2026-01-01"); // New Year's, a Thursday
    expect(holidays).toContain("2026-01-19"); // MLK, 3rd Monday
    expect(holidays).toContain("2026-05-25"); // Memorial, last Monday
    expect(holidays).toContain("2026-07-03"); // Jul 4 is a Saturday -> observed Fri
    expect(holidays).toContain("2026-09-07"); // Labor, 1st Monday
    expect(holidays).toContain("2026-11-26"); // Thanksgiving, 4th Thursday
    expect(holidays).toContain("2026-11-27"); // the Friday after
    expect(holidays).toContain("2026-12-25");
  });

  it("shifts a Sunday holiday to the Monday after", () => {
    // 2027-07-04 is a Sunday.
    expect(usFederalHolidays(2027)).toContain("2027-07-05");
  });

  it("spans multiple years for the planner lookahead", () => {
    const set = holidaySet(2026, 2027);
    expect(set.has("2026-12-25")).toBe(true);
    expect(set.has("2027-01-01")).toBe(true);
  });
});

describe("business days", () => {
  const holidays = holidaySet(2026, 2027);
  const at = (iso: string) => DateTime.fromISO(iso, { zone: "America/Phoenix" });

  it("treats weekends and holidays as non-business days", () => {
    expect(isBusinessDay(at("2026-08-10"), holidays)).toBe(true); // Monday
    expect(isBusinessDay(at("2026-08-15"), holidays)).toBe(false); // Saturday
    expect(isBusinessDay(at("2026-08-16"), holidays)).toBe(false); // Sunday
    expect(isBusinessDay(at("2026-11-26"), holidays)).toBe(false); // Thanksgiving
  });

  it("walks the T1 -> T2 -> T3 -> T4 cadence", () => {
    // Monday 2026-08-10, offsets +3, +4, +5.
    const t1 = at("2026-08-10");
    const t2 = addBusinessDays(t1, 3, holidays);
    const t3 = addBusinessDays(t2, 4, holidays);
    const t4 = addBusinessDays(t3, 5, holidays);

    expect(t2.toISODate()).toBe("2026-08-13"); // Thu
    expect(t3.toISODate()).toBe("2026-08-19"); // Wed, skipping the weekend
    expect(t4.toISODate()).toBe("2026-08-26"); // Wed
  });

  it("skips the weekend when counting from a Friday", () => {
    // Fri 2026-08-14 + 3 business days -> Wed 2026-08-19.
    expect(addBusinessDays(at("2026-08-14"), 3, holidays).toISODate()).toBe(
      "2026-08-19",
    );
  });

  it("normalizes a weekend start forward before counting", () => {
    // Offset 0 means "this day if we can send on it, else the next one".
    expect(addBusinessDays(at("2026-08-15"), 0, holidays).toISODate()).toBe(
      "2026-08-17",
    );
  });

  it("steps over a holiday", () => {
    // Tue 2026-11-24 + 3 must skip Thanksgiving AND the Friday after.
    expect(addBusinessDays(at("2026-11-24"), 3, holidays).toISODate()).toBe(
      "2026-12-01",
    );
  });

  it("counts business days between two dates", () => {
    expect(
      businessDaysBetween(at("2026-08-10"), at("2026-08-17"), holidays),
    ).toBe(5);
    expect(
      businessDaysBetween(at("2026-11-24"), at("2026-12-01"), holidays),
    ).toBe(3);
  });

  it("counts in the prospect's calendar, not the operator's", () => {
    // 23:30 Friday in Phoenix is already Saturday in IST. Counting in the
    // prospect's zone is what stops the whole sequence sliding a day.
    const fridayLatePhoenix = DateTime.fromISO("2026-08-14T23:30", {
      zone: "America/Phoenix",
    });
    expect(fridayLatePhoenix.setZone("Asia/Kolkata").toISODate()).toBe(
      "2026-08-15",
    );
    expect(
      addBusinessDays(fridayLatePhoenix, 1, holidays).toISODate(),
    ).toBe("2026-08-17");
  });
});
