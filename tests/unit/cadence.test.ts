import { DateTime } from "luxon";
import { describe, expect, it } from "vitest";

import {
  CADENCE_BUSINESS_DAYS,
  MAX_STEP,
  nextSlot,
  windowsFromSettings,
} from "@/lib/scheduler/slots";
import { addBusinessDays, businessDaysBetween } from "@/lib/timezone/businessDays";
import { holidaySet } from "@/lib/timezone/holidays";

// The whole four-touch sequence, composed the way the planner composes it.
//
// The other unit suites test the pieces: that one slot lands in a window, that
// business-day arithmetic steps over Thanksgiving. This one asserts the thing
// an operator actually cares about, which is a property of the SEQUENCE rather
// than of any one call: four touches for one lead, each in that lead's own
// morning or afternoon, spaced exactly 3 then 4 then 5 business days from the
// touch before it, never two on one local date, never on a weekend or a federal
// holiday, and never on a first-touch weekday the org has switched off.
//
// The zones are the ones this org's leads are actually in. Phoenix is in the
// list deliberately: it does not observe DST, so a bug that reasons about
// offsets rather than about IANA zones diverges from Denver for eight months of
// the year and agrees with it for the other four, which is exactly the shape of
// bug that survives a single-zone test suite.

/** org_settings as this org runs it. */
const SETTINGS = {
  morning_start_hour: 7,
  morning_end_hour: 11,
  afternoon_start_hour: 13,
  afternoon_end_hour: 16,
};

const WINDOWS = windowsFromSettings(SETTINGS);
const FIRST_TOUCH_WEEKDAYS = [2, 3, 4];
const FOLLOWUP_WEEKDAYS = [1, 2, 3, 4, 5];
const HOLIDAYS = holidaySet(2026, 2028);
const LOOKAHEAD = 30;

const ZONES = [
  "America/Phoenix",
  "America/Los_Angeles",
  "America/Chicago",
  "America/New_York",
];

/** The mailbox's zone, which is where a daily cap resets. Not a prospect's. */
const MAILBOX_ZONE = "Asia/Kolkata";

interface Touch {
  step: number;
  at: DateTime;
  local: DateTime;
}

/**
 * Walks all four touches for one lead, as the planner would.
 *
 * Each step is planned from the PREVIOUS step's actual send, which is what the
 * planner does with lastSent.sent_at. Here every send is assumed to go out
 * exactly on its slot, which is the best case; a slipped send simply moves the
 * next earliest day along with it.
 */
function walk(zone: string, leadId: string, from: DateTime): Touch[] {
  const touches: Touch[] = [];
  let previous: DateTime | null = null;

  for (let step = 1; step <= MAX_STEP; step++) {
    const earliestDay =
      previous === null
        ? from.setZone(zone).startOf("day")
        : addBusinessDays(
            previous.setZone(zone).startOf("day"),
            CADENCE_BUSINESS_DAYS[step] ?? 0,
            HOLIDAYS,
          );

    const result = nextSlot({
      notBefore: previous ?? from,
      earliestDay,
      zone,
      windows: WINDOWS,
      holidays: HOLIDAYS,
      allowedWeekdays: step === 1 ? FIRST_TOUCH_WEEKDAYS : FOLLOWUP_WEEKDAYS,
      maxLookaheadDays: LOOKAHEAD,
      seed: `${leadId}:${step}:0`,
    });

    expect(result.ok, `step ${step} in ${zone} found no slot`).toBe(true);
    if (!result.ok) break;

    touches.push({ step, at: result.at, local: result.at.setZone(zone) });
    previous = result.at;
  }

  return touches;
}

function inAWindow(local: DateTime): boolean {
  const minute = local.hour * 60 + local.minute;
  return WINDOWS.some(
    (w) => minute >= w.startHour * 60 && minute < w.endHour * 60,
  );
}

// A Sunday, so nothing is handed a convenient starting weekday.
const START = DateTime.fromISO("2026-08-16T21:40:00", { zone: "Asia/Kolkata" });

describe("the four-touch cadence, per lead", () => {
  for (const zone of ZONES) {
    describe(zone, () => {
      const touches = walk(zone, `lead-${zone}`, START);

      it("plans all four touches", () => {
        expect(touches.map((t) => t.step)).toEqual([1, 2, 3, 4]);
      });

      it("lands every touch inside a send window, prospect-local", () => {
        for (const touch of touches) {
          expect(
            inAWindow(touch.local),
            `T${touch.step} at ${touch.local.toFormat("ccc dd LLL HH:mm")}`,
          ).toBe(true);
        }
      });

      it("never lands on a weekend or a federal holiday", () => {
        for (const touch of touches) {
          expect(touch.local.weekday).toBeLessThanOrEqual(5);
          expect(HOLIDAYS.has(touch.local.toISODate()!)).toBe(false);
        }
      });

      it("respects the first-touch weekdays, and the wider follow-up set", () => {
        expect(FIRST_TOUCH_WEEKDAYS).toContain(touches[0]!.local.weekday);
        for (const touch of touches.slice(1)) {
          expect(FOLLOWUP_WEEKDAYS).toContain(touch.local.weekday);
        }
      });

      it("spaces the touches 3, 4 and 5 business days apart", () => {
        for (let i = 1; i < touches.length; i++) {
          const previous = touches[i - 1]!;
          const touch = touches[i]!;
          const gap = businessDaysBetween(
            previous.local,
            touch.local,
            HOLIDAYS,
          );
          // Exactly, not at least. A gap larger than the cadence means a slot
          // was pushed and the sequence is drifting; smaller means a touch
          // arrived early, which reads as pestering.
          expect(gap, `T${previous.step} to T${touch.step}`).toBe(
            CADENCE_BUSINESS_DAYS[touch.step],
          );
        }
      });

      it("never puts two touches on one prospect-local date", () => {
        const dates = touches.map((t) => t.local.toISODate());
        expect(new Set(dates).size).toBe(dates.length);
      });

      it("counts the cap in the mailbox's calendar, which is a different day", () => {
        // The reason these are two separate columns, asserted on fixed instants
        // rather than on the hashed slot minute so it cannot pass by luck.
        //
        // A 20/day cap is a Gmail reputation limit on the SENDING ACCOUNT, so it
        // resets in the operator's day. For a Kolkata mailbox selling into the
        // US the two calendars disagree every afternoon: 15:00 anywhere in the
        // continental US is already tomorrow in Kolkata. Count the cap in the
        // prospect's day and an afternoon batch plus the next morning's batch
        // both land inside one Kolkata day, at double the intended volume.
        const afternoon = DateTime.fromISO("2026-08-18T15:00:00", { zone });
        expect(afternoon.setZone(MAILBOX_ZONE).toISODate()).toBe("2026-08-19");

        const morning = DateTime.fromISO("2026-08-18T09:00:00", { zone });
        expect(morning.setZone(MAILBOX_ZONE).toISODate()).toBe("2026-08-18");

        // Kolkata is ahead of every US zone, so the mailbox date can never
        // precede the prospect's.
        for (const touch of touches) {
          expect(
            touch.at.setZone(MAILBOX_ZONE).toISODate()! >=
              touch.local.toISODate()!,
          ).toBe(true);
        }
      });
    });
  }

  it("counts the cadence in the prospect's calendar, not the operator's", () => {
    // The same instant is a different date either side of midnight. If the
    // cadence were counted in the operator's zone, a lead in Los Angeles would
    // drift by a day against one in New York for no reason a prospect can see.
    const la = walk("America/Los_Angeles", "drift-check", START);
    const ny = walk("America/New_York", "drift-check", START);

    for (let i = 1; i < MAX_STEP; i++) {
      expect(
        businessDaysBetween(la[i - 1]!.local, la[i]!.local, HOLIDAYS),
      ).toBe(businessDaysBetween(ny[i - 1]!.local, ny[i]!.local, HOLIDAYS));
    }
  });
});
