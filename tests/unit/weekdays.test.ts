import { describe, expect, it } from "vitest";

import { weekdayLabel } from "@/lib/scheduler/weekdays";

describe("weekdayLabel", () => {
  it("names the live first-touch days", () => {
    // org_settings.first_touch_weekdays on the real project, Sep 2026.
    expect(weekdayLabel([2, 3, 4])).toBe("Tue–Thu");
    expect(weekdayLabel([1, 2, 3, 4, 5])).toBe("Mon–Fri");
  });

  it("lists days that are not a run", () => {
    expect(weekdayLabel([5, 1, 3])).toBe("Mon, Wed, Fri");
    expect(weekdayLabel([2, 3])).toBe("Tue, Wed");
  });

  it("says what an empty list means rather than nothing", () => {
    expect(weekdayLabel([])).toBe("any business day");
    expect(weekdayLabel(null)).toBe("any business day");
  });
});
