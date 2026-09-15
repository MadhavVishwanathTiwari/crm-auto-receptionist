// Which days a touch may land on, in words.
//
// /queue said "Mon–Fri" in a literal while org_settings.first_touch_weekdays
// said Tue–Thu, so the one screen that explains when emails go out described a
// schedule the scheduler does not keep. Read from the settings row instead.

const NAMES = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

/**
 * "Tue–Thu" for a run of three or more, "Mon, Wed, Fri" otherwise.
 *
 * ISO weekdays, 1 = Monday, the same numbering as org_settings and slots.ts.
 * An empty list means any business day there (slots.ts), so it says that.
 */
export function weekdayLabel(days: readonly number[] | null | undefined): string {
  const sorted = [...new Set(days ?? [])]
    .filter((day) => Number.isInteger(day) && day >= 1 && day <= 7)
    .sort((a, b) => a - b);

  if (sorted.length === 0) return "any business day";

  const run = sorted.every((day, i) => i === 0 || day === sorted[i - 1] + 1);
  if (run && sorted.length >= 3) {
    return `${NAMES[sorted[0] - 1]}–${NAMES[sorted[sorted.length - 1] - 1]}`;
  }
  return sorted.map((day) => NAMES[day - 1]).join(", ");
}
