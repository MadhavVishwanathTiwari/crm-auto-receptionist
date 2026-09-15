import { describe, expect, it } from "vitest";

import { formatCount, formatYours, fromYourInput, relativeTo } from "@/lib/time/format";

// Every time on screen goes through these, and the whole point is that the
// answer depends on the zone passed in and on nothing about the machine: the
// server renders in UTC, the browser in the operator's zone, and the two must
// produce the same string or React throws #418.

describe("formatYours", () => {
  it("writes an instant in the reader's zone, not the runtime's", () => {
    // 12:59 UTC is 18:29 in Kolkata and 05:59 in Phoenix.
    expect(formatYours("2026-09-15T12:59:00Z", "Asia/Kolkata")).toBe("Tue 15 Sep, 18:29");
    expect(formatYours("2026-09-15T12:59:00Z", "America/Phoenix")).toBe(
      "Tue 15 Sep, 05:59",
    );
  });

  it("writes a date day-first, on the reader's calendar", () => {
    // Still 7 Aug in UTC; already 8 Aug in Kolkata.
    expect(formatYours("2026-08-07T20:00:00Z", "Asia/Kolkata", "date")).toBe("8 Aug 2026");
  });

  it("fills a datetime-local input in the reader's zone", () => {
    expect(formatYours("2026-09-15T12:59:00Z", "Asia/Kolkata", "input")).toBe(
      "2026-09-15T18:29",
    );
  });

  it("shows nothing it cannot stand behind before the zone is known", () => {
    expect(formatYours("2026-09-15T12:59:00Z", null)).toBe("…");
    expect(formatYours("2026-09-15T12:59:00Z", null, "input")).toBe("");
  });

  it("is empty for no instant or a broken one", () => {
    expect(formatYours(null, "Asia/Kolkata")).toBe("");
    expect(formatYours("not a time", "Asia/Kolkata")).toBe("");
  });
});

describe("fromYourInput", () => {
  it("reads a datetime-local value in the reader's zone", () => {
    expect(fromYourInput("2026-09-15T18:29", "Asia/Kolkata")).toBe(
      "2026-09-15T12:59:00.000Z",
    );
  });

  it("round-trips with formatYours", () => {
    const iso = "2026-09-15T12:59:00.000Z";
    expect(fromYourInput(formatYours(iso, "America/Phoenix", "input"), "America/Phoenix")).toBe(
      iso,
    );
  });

  it("is null for an empty or unreadable value", () => {
    expect(fromYourInput("", "Asia/Kolkata")).toBeNull();
    expect(fromYourInput("tomorrow", "Asia/Kolkata")).toBeNull();
  });
});

describe("relativeTo", () => {
  it("measures from the render, not from now", () => {
    expect(relativeTo("2026-09-12T12:00:00Z", "2026-09-15T12:00:00Z")).toBe("3 days ago");
    expect(relativeTo("2026-09-16T12:00:00Z", "2026-09-15T12:00:00Z")).toBe("in 1 day");
  });

  it("is empty for no instant", () => {
    expect(relativeTo(null, "2026-09-15T12:00:00Z")).toBe("");
  });
});

describe("formatCount", () => {
  it("groups the same way whatever the machine's locale", () => {
    // en-IN would write 1,23,456.
    expect(formatCount(123456)).toBe("123,456");
  });
});
