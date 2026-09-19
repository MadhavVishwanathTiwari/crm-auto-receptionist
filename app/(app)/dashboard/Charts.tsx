// The dashboard's chart vocabulary.
//
// This file used to argue that fourteen bars were not worth introducing SVG
// for, and while that was true of fourteen bare <div>s it stopped being true
// once the screen was meant to be read rather than merely consulted: a bar
// chart with no axis and no baseline cannot tell you whether a quiet stretch
// is a quiet stretch or a broken job. SendHistory is now SVG with a scale, a
// baseline and a hover target per day. It still themes from --color-*, because
// the fills are currentColor and var() rather than hardcoded hex.
//
// Funnel stays CSS: it is a labelled bar list, one row per stage, and the
// label and its bar have to stay on one baseline. It takes its colour from
// currentColor so STAGE_TONE remains the single map and a bar cannot drift
// from its own label.

import { cn } from "@/lib/cn";
import { TONE_TEXT, type Tone } from "@/lib/ui/tones";

export interface DayCount {
  day: string;
  sent: number;
}

/** A day, in the operator's zone, as the axis labels want it. */
function dayLabel(iso: string): string {
  const [, month, day] = iso.split("-");
  return `${Number(month)}/${Number(day)}`;
}

const CHART_W = 320;
const CHART_H = 72;

export function SendHistory({ series }: { series: DayCount[] }) {
  const max = Math.max(1, ...series.map((point) => point.sent));
  const total = series.reduce((sum, point) => sum + point.sent, 0);
  const step = series.length > 0 ? CHART_W / series.length : CHART_W;
  const barW = Math.max(2, step - 3);

  return (
    <div>
      <div className="flex items-baseline gap-2">
        <span className="text-xs tracking-wide text-ink-3 uppercase">
          Sent, last {series.length} days
        </span>
        <span className="tabular text-2xl font-semibold text-ink">{total}</span>
      </div>

      <svg
        viewBox={`0 0 ${CHART_W} ${CHART_H}`}
        preserveAspectRatio="none"
        role="img"
        aria-label={`${total} emails sent over the last ${series.length} days`}
        className="mt-2 h-[72px] w-full"
      >
        {/* Quarter gridlines, so a bar has something to be measured against. */}
        {[0.25, 0.5, 0.75].map((fraction) => (
          <line
            key={fraction}
            x1={0}
            x2={CHART_W}
            y1={CHART_H * fraction}
            y2={CHART_H * fraction}
            stroke="var(--color-line)"
            strokeWidth={1}
            vectorEffect="non-scaling-stroke"
          />
        ))}

        {series.map((point, index) => {
          // A zero day still gets a hairline, so an empty stretch reads as
          // "nothing happened" rather than as a rendering gap.
          const height = point.sent === 0 ? 1 : (point.sent / max) * CHART_H;
          return (
            <rect
              key={point.day}
              x={index * step}
              y={CHART_H - height}
              width={barW}
              height={height}
              rx={1}
              fill={
                point.sent === 0 ? "var(--color-line-2)" : "var(--color-accent)"
              }
            >
              <title>{`${point.day}: ${point.sent} sent`}</title>
            </rect>
          );
        })}

        <line
          x1={0}
          x2={CHART_W}
          y1={CHART_H}
          y2={CHART_H}
          stroke="var(--color-line-2)"
          strokeWidth={1}
          vectorEffect="non-scaling-stroke"
        />
      </svg>

      <div className="mt-1 flex justify-between text-xs text-ink-3">
        <span className="tabular">{dayLabel(series[0]?.day ?? "")}</span>
        <span className="tabular">peak {max}</span>
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
    <div className="space-y-1">
      {rows.map((row) => (
        // The tone sets `color` on the wrapper and the bar is bg-current, so
        // one map drives both the label and its bar.
        <div key={row.key} className={"flex items-center gap-2 " + row.tone}>
          <span className="w-[150px] shrink-0 truncate">{row.label}</span>
          <span className="flex h-2 min-w-0 flex-1 items-center overflow-hidden rounded-full bg-surface-2">
            {!row.unscaled && (
              <span
                className="h-full rounded-full bg-current opacity-80"
                // Clamped: a row can exceed the scale once one is excluded.
                style={{ width: `${Math.min(100, (row.count / max) * 100)}%` }}
              />
            )}
          </span>
          <span className="tabular w-[48px] shrink-0 text-right font-medium">
            {row.count}
          </span>
          {row.detail !== undefined && (
            <span className="tabular w-[68px] shrink-0 text-right text-ink-3">
              {row.detail}
            </span>
          )}
        </div>
      ))}
    </div>
  );
}

/**
 * A labelled number.
 *
 * The old version rendered its label, its value and its detail all at the same
 * 13px, so a panel of them read as a wall of sentences rather than as figures.
 * The value is what somebody came to the screen for, so it gets the size.
 *
 * `tone` stays a class string rather than a Tone, because the dashboard passes
 * STAGE_TONE entries straight through.
 */
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
    <div className="min-w-[112px]">
      <p className="text-xs tracking-wide text-ink-3 uppercase">{label}</p>
      {/* One colour class, never two. Tailwind utilities for the same property
          have equal specificity, so a base plus an override is decided by the
          order rules land in the stylesheet rather than by the order they are
          written here -- which had Failed rendering in ink instead of danger. */}
      <p className={cn("tabular mt-0.5 text-2xl font-semibold", tone || "text-ink")}>
        {value}
      </p>
      {detail && <p className="mt-0.5 text-xs text-ink-3">{detail}</p>}
    </div>
  );
}

/** A capacity ring, for "used 14 of 20 today". */
export function Gauge({
  used,
  cap,
  tone = "accent",
}: {
  used: number;
  cap: number;
  tone?: Tone;
}) {
  const fraction = cap > 0 ? Math.min(1, used / cap) : 0;
  const radius = 9;
  const circumference = 2 * Math.PI * radius;

  return (
    <span className={cn("inline-flex items-center gap-1.5", TONE_TEXT[tone])}>
      <svg viewBox="0 0 24 24" className="size-5 -rotate-90" aria-hidden="true">
        <circle
          cx="12"
          cy="12"
          r={radius}
          fill="none"
          stroke="var(--color-surface-3)"
          strokeWidth="3"
        />
        <circle
          cx="12"
          cy="12"
          r={radius}
          fill="none"
          stroke="currentColor"
          strokeWidth="3"
          strokeLinecap="round"
          strokeDasharray={`${circumference * fraction} ${circumference}`}
        />
      </svg>
      <span className="tabular">
        {used}
        <span className="text-ink-3">/{cap}</span>
      </span>
    </span>
  );
}
