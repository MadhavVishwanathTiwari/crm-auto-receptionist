import { DateTime } from "luxon";
import { describe, expect, it } from "vitest";

import {
  bookSlot,
  buildCapacity,
  pickMailbox,
  reserve,
  type BookingMailbox,
  type BookingSettings,
} from "@/lib/scheduler/book";

// Booking one send.
//
// slots.ts already has its own suite for the wall-clock arithmetic. What is
// tested here is the join of a slot to a MAILBOX, which is where the two
// timezones in this system meet: the slot is chosen in the prospect's day and
// the capacity it consumes is counted in the sender's. Collapsing those two is
// the bug this file exists to catch, because it does not throw, it just
// over-sends.

const SETTINGS: BookingSettings = {
  morning_start_hour: 7,
  morning_end_hour: 11,
  afternoon_start_hour: 13,
  afternoon_end_hour: 16,
  max_lookahead_days: 14,
  first_touch_weekdays: [2, 3, 4],
  followup_weekdays: [1, 2, 3, 4, 5],
};

/** A Monday, so a first touch has to skip to Tuesday. */
const NOW = DateTime.fromISO("2026-08-17T09:00:00", { zone: "Asia/Kolkata" });

const MAILBOX: BookingMailbox = {
  id: "mailbox-a",
  timezone: "Asia/Kolkata",
  daily_cap: 20,
};

function book(overrides: Partial<Parameters<typeof bookSlot>[0]> = {}) {
  const mailboxes = overrides.mailboxes ?? [MAILBOX];
  return bookSlot({
    now: NOW,
    zone: "America/Chicago",
    earliestDay: NOW.setZone("America/Chicago").startOf("day"),
    step: 1,
    seed: "lead:1:0",
    settings: SETTINGS,
    mailboxes,
    capacity: overrides.capacity ?? buildCapacity(mailboxes, [], NOW),
    holidays: new Set<string>(),
    ...overrides,
  });
}

describe("bookSlot", () => {
  it("puts a first touch in the prospect's morning or afternoon window", () => {
    const result = book();
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const local = result.at.setZone("America/Chicago");
    const hour = local.hour;
    expect(hour >= 7 && hour < 16).toBe(true);
    expect(hour === 11 || hour === 12).toBe(false); // the gap between windows
  });

  it("only ever picks a weekday the settings allow for that step", () => {
    const result = book();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(SETTINGS.first_touch_weekdays).toContain(
      result.at.setZone("America/Chicago").weekday,
    );
  });

  it("allows a follow-up on a Monday, which a first touch may not have", () => {
    const monday = DateTime.fromISO("2026-08-23T09:00:00", { zone: "Asia/Kolkata" });
    const result = book({
      now: monday,
      step: 2,
      earliestDay: monday.setZone("America/Chicago").startOf("day"),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(SETTINGS.followup_weekdays).toContain(
      result.at.setZone("America/Chicago").weekday,
    );
  });

  it("reports no_mailbox rather than inventing a slot with nothing to send from", () => {
    const result = book({ mailboxes: [], capacity: buildCapacity([], [], NOW) });
    expect(result).toEqual({ ok: false, reason: "no_mailbox" });
  });

  it("walks to the next day when the only mailbox is full", () => {
    const first = book();
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    // Fill the day the first booking landed on, in the MAILBOX's zone.
    const capacity = buildCapacity([MAILBOX], [], NOW);
    for (let i = 0; i < MAILBOX.daily_cap; i++) {
      reserve(capacity, MAILBOX.id, first.capDate);
    }

    const second = book({ capacity });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.capDate).not.toBe(first.capDate);
  });

  it("gives up with no_capacity once every day in the lookahead is full", () => {
    const capacity = buildCapacity([MAILBOX], [], NOW);
    // Every mailbox-local date the lookahead could reach.
    for (let day = 0; day <= SETTINGS.max_lookahead_days + 3; day++) {
      const date = NOW.setZone(MAILBOX.timezone).plus({ days: day }).toISODate()!;
      for (let i = 0; i < MAILBOX.daily_cap; i++) reserve(capacity, MAILBOX.id, date);
    }

    expect(book({ capacity })).toEqual({ ok: false, reason: "no_capacity" });
  });

  it("counts the cap in the mailbox's day, not the prospect's", () => {
    // A Chicago afternoon is already the following morning in Kolkata. The date
    // the send is counted against has to come from the mailbox's clock: a
    // 20/day cap is a Gmail reputation limit on the sending account.
    const result = book({
      earliestDay: NOW.setZone("America/Chicago").startOf("day"),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.capDate).toBe(result.at.setZone(MAILBOX.timezone).toISODate());
  });

  it("stores a prospect-local wall clock with no offset in it", () => {
    const result = book();
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.scheduledLocal).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/);
    expect(result.scheduledLocal).toBe(
      result.at.setZone("America/Chicago").toFormat("yyyy-MM-dd'T'HH:mm:ss"),
    );
  });
});

describe("capacity", () => {
  it("ignores sends already in the past", () => {
    const capacity = buildCapacity(
      [MAILBOX],
      [
        {
          mailbox_id: MAILBOX.id,
          scheduled_at: NOW.minus({ days: 3 }).toUTC().toISO()!,
        },
      ],
      NOW,
    );

    expect(capacity.days.get(MAILBOX.id)!.size).toBe(0);
    expect(capacity.instants.get(MAILBOX.id)).toEqual([]);
  });

  it("counts a future send against the mailbox-local date it falls on", () => {
    const at = NOW.plus({ days: 1 });
    const capacity = buildCapacity(
      [MAILBOX],
      [{ mailbox_id: MAILBOX.id, scheduled_at: at.toUTC().toISO()! }],
      NOW,
    );

    const key = at.setZone(MAILBOX.timezone).toISODate()!;
    expect(capacity.days.get(MAILBOX.id)!.get(key)).toBe(1);
    expect(capacity.instants.get(MAILBOX.id)).toEqual([at.toMillis()]);
  });

  it("deals the next send to the emptier of two mailboxes", () => {
    const other: BookingMailbox = { ...MAILBOX, id: "mailbox-b" };
    const capacity = buildCapacity([MAILBOX, other], [], NOW);

    const at = NOW.plus({ days: 1 });
    const capDate = at.setZone(MAILBOX.timezone).toISODate()!;
    reserve(capacity, MAILBOX.id, capDate);

    const chosen = pickMailbox(capacity, [MAILBOX, other], at);
    expect(chosen?.mailbox.id).toBe(other.id);
  });

  it("returns null when both are at their cap", () => {
    const other: BookingMailbox = { ...MAILBOX, id: "mailbox-b", daily_cap: 1 };
    const one: BookingMailbox = { ...MAILBOX, daily_cap: 1 };
    const capacity = buildCapacity([one, other], [], NOW);

    const at = NOW.plus({ days: 1 });
    const capDate = at.setZone(one.timezone).toISODate()!;
    reserve(capacity, one.id, capDate);
    reserve(capacity, other.id, capDate);

    expect(pickMailbox(capacity, [one, other], at)).toBeNull();
  });
});

describe("spacing (0041)", () => {
  // The dispatcher enforces the gap between two sends from one mailbox. Booking
  // keeps its promise honest: bookings sit at least the maximum gap apart, so a
  // booked send is never held behind another one and the time /write showed is
  // the time it leaves.
  const SPACED: BookingSettings = { ...SETTINGS, send_gap_max_minutes: 15 };
  const GAP = 15 * 60_000;

  it("without a gap, two sends with the same seed land on the same minute", () => {
    // What happened before 0041: nothing kept two bookings apart.
    const capacity = buildCapacity([MAILBOX], [], NOW);
    const first = book({ capacity });
    if (!first.ok) throw new Error("first booking failed");
    reserve(capacity, first.mailbox.id, first.capDate, first.at);

    const second = book({ capacity });
    expect(second.ok && +second.at === +first.at).toBe(true);
  });

  it("with a gap, moves the second at least the gap away", () => {
    const capacity = buildCapacity([MAILBOX], [], NOW);
    const first = book({ settings: SPACED, capacity });
    if (!first.ok) throw new Error("first booking failed");
    reserve(capacity, first.mailbox.id, first.capDate, first.at);

    const second = book({ settings: SPACED, capacity });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(Math.abs(+second.at - +first.at)).toBeGreaterThanOrEqual(GAP);
  });

  it("keeps a whole day's worth of bookings on one mailbox the gap apart", () => {
    const capacity = buildCapacity([MAILBOX], [], NOW);
    const booked: number[] = [];

    for (let i = 0; i < MAILBOX.daily_cap; i++) {
      const result = book({ settings: SPACED, capacity, seed: `lead-${i}:1:0` });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      reserve(capacity, result.mailbox.id, result.capDate, result.at);
      booked.push(+result.at);
    }

    booked.sort((a, b) => a - b);
    for (let i = 1; i < booked.length; i++) {
      expect(booked[i]! - booked[i - 1]!).toBeGreaterThanOrEqual(GAP);
    }
  });

  it("steers clear of a send already in the table, not only of reservations", () => {
    const first = book({ settings: SPACED });
    if (!first.ok) throw new Error("first booking failed");

    const capacity = buildCapacity(
      [MAILBOX],
      [{ mailbox_id: MAILBOX.id, scheduled_at: first.at.toUTC().toISO()! }],
      NOW,
    );

    const again = book({ settings: SPACED, capacity });
    expect(again.ok).toBe(true);
    if (!again.ok) return;
    expect(Math.abs(+again.at - +first.at)).toBeGreaterThanOrEqual(GAP);
  });

  it("passes over the emptier mailbox when it has a send too close", () => {
    const other: BookingMailbox = { ...MAILBOX, id: "mailbox-b" };
    const capacity = buildCapacity([MAILBOX, other], [], NOW);

    const at = NOW.plus({ days: 1 });
    const capDate = at.setZone(MAILBOX.timezone).toISODate()!;

    // MAILBOX has one booking, five minutes from `at`. `other` has two, hours
    // away. Emptiest-first alone would pick MAILBOX.
    reserve(capacity, MAILBOX.id, capDate, at.plus({ minutes: 5 }));
    reserve(capacity, other.id, capDate, at.plus({ hours: 3 }));
    reserve(capacity, other.id, capDate, at.plus({ hours: 4 }));

    expect(pickMailbox(capacity, [MAILBOX, other], at)?.mailbox.id).toBe(MAILBOX.id);
    expect(pickMailbox(capacity, [MAILBOX, other], at, 15)?.mailbox.id).toBe(other.id);
  });
});
