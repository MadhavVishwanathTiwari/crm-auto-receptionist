// The app's first charts, and deliberately its least ambitious ones.
//
// Both are <div>s. There is no chart library here and no SVG anywhere in the
// repo, and fourteen bars is not the thing to introduce either for. A CSS bar
// themes itself from --color-*, is inspectable in the elements panel, gets a
// hover label from the native title attribute, and degrades to "just the
// numbers" at zero width -- which an SVG does not.
//
// Colour follows globals.css: the chromatic tokens each mean something, so
// volume is --color-ink-3 and ok/warn/danger are reserved for bars that carry a
// judgement. The funnel takes its colour from currentColor so that STAGE_TONE
// stays the single map and a bar cannot drift from its own label.

export interface DayCount {
  day: string;
  sent: number;
}

/** A day, in the operator's zone, as the axis labels want it. */
function dayLabel(iso: string): string {
  const [, month, day] = iso.split("-");
  return `${Number(month)}/${Number(day)}`;
}

export function SendHistory({ series }: { series: DayCount[] }) {
  const max = Math.max(1, ...series.map((point) => point.sent));
  const total = series.reduce((sum, point) => sum + point.sent, 0);

  return (
    <div>
      <div className="flex items-baseline gap-2">
        <span className="text-[var(--color-ink-3)]">Sent, last {series.length} days</span>
        <span className="tabular text-[var(--color-ink)]">{total}</span>
      </div>

      <div className="mt-2 flex h-[64px] items-end gap-[3px]">
        {series.map((point) => (
          <div
            key={point.day}
            title={`${point.day}: ${point.sent} sent`}
            className="flex-1 bg-[var(--color-ink-3)]"
            style={{
              // A zero day still gets a hairline, so an empty stretch reads as
              // "nothing happened" rather than as a rendering gap.
              height: point.sent === 0 ? "1px" : `${(point.sent / max) * 100}%`,
              opacity: point.sent === 0 ? 0.4 : 1,
            }}
          />
        ))}
      </div>

      {/* First and last only. At fourteen bars in a 13px UI a full axis is more
          pixels than data. */}
      <div className="mt-1 flex justify-between text-[var(--color-ink-3)]">
        <span className="tabular">{dayLabel(series[0]?.day ?? "")}</span>
        <span className="tabular">
          {dayLabel(series[series.length - 1]?.day ?? "")}
        </span>
      </div>
    </div>
  );
}

export interface FunnelRow {
  key: string;
  label: string;
  /** The tone class for this row; the bar inherits it via currentColor. */
  tone: string;
  count: number;
  detail?: string;
  /**
   * Count it, but do not draw it and do not let it set the scale.
   *
   * For Prospect, which is 512 against a live stage's 4. Sharing a scale with
   * it renders every stage anybody is actually working as a one-pixel stub,
   * which is a chart that hides its own subject. Prospect is already out of
   * every money figure for the same kind of reason, so this is consistent
   * rather than a special case invented here.
   */
  unscaled?: boolean;
}

export function Funnel({ rows }: { rows: FunnelRow[] }) {
  const max = Math.max(
    1,
    ...rows.filter((row) => !row.unscaled).map((row) => row.count),
  );

  return (
    <div className="space-y-0.5">
      {rows.map((row) => (
        // The tone sets `color` on the wrapper and the bar is bg-current, so
        // one map drives both the label and its bar.
        <div key={row.key} className={"flex items-center gap-2 " + row.tone}>
          <span className="w-[104px] shrink-0 truncate">{row.label}</span>
          <span className="flex h-[10px] min-w-0 flex-1 items-center">
            {!row.unscaled && (
              <span
                className="h-full bg-current opacity-70"
                // Clamped: a row can exceed the scale once one is excluded.
                style={{ width: `${Math.min(100, (row.count / max) * 100)}%` }}
              />
            )}
          </span>
          <span className="tabular w-[52px] shrink-0 text-right">{row.count}</span>
          {row.detail !== undefined && (
            <span className="tabular w-[72px] shrink-0 text-right text-[var(--color-ink-3)]">
              {row.detail}
            </span>
          )}
        </div>
      ))}
    </div>
  );
}

/** A labelled number. The app's stat idiom, lifted off the board's stat strip. */
export function Stat({
  label,
  value,
  tone,
  detail,
}: {
  label: string;
  value: string | number;
  tone?: string;
  detail?: string;
}) {
  return (
    <div className="min-w-[124px]">
      <p className="text-[var(--color-ink-3)]">{label}</p>
      {/* One colour class, never two. Tailwind utilities for the same property
          have equal specificity, so a base plus an override is decided by the
          order rules land in the stylesheet rather than by the order they are
          written here -- which had Failed rendering in ink instead of danger. */}
      <p className={"tabular " + (tone || "text-[var(--color-ink)]")}>{value}</p>
      {detail && <p className="text-[var(--color-ink-3)]">{detail}</p>}
    </div>
  );
}
