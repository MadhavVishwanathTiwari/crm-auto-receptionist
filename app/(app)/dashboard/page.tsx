import Link from "next/link";

import {
  operatorFor,
  operatorIndex,
  operatorNames,
  type OperatorGroup,
} from "@/lib/dashboard/operators";
import { requireOrgContext } from "@/lib/org";
import {
  BOARD_COLUMNS,
  COLUMN_LABEL,
  columnFor,
  dealValue,
  formatMoney,
  isOverdue,
  pipelineValue,
  weightedValue,
  wonValue,
  type BoardColumn,
  type BoardLead,
} from "@/lib/pipeline/stages";
import {
  classifyLead,
  IN_FLIGHT,
  suppressionIndex,
  type Blocker,
  type BlockerLead,
} from "@/lib/queue/blockers";

import { PAGE, PAGE_HEADER, PANEL, STAGE_TONE } from "../ui";
import { Funnel, SendHistory, Stat, type DayCount } from "./Charts";

export const dynamic = "force-dynamic";

const MAX_ROWS = 5000;

/** Everything the RPC answers that TypeScript cannot. */
interface Activity {
  zone: string;
  days: number;
  series: DayCount[];
  sends: {
    planned: number;
    blocked: number;
    failed: number;
    sent: number;
    written: number;
  };
  mailboxes: {
    mailbox_id: string;
    email: string;
    user_id: string | null;
    timezone: string;
    daily_cap: number;
    sendable: boolean;
    used_today: number;
    sent_window: number;
  }[];
  events: {
    replied: number;
    bounced: number;
    unsubscribed: number;
    closed: number;
  };
  stage_moves: Record<string, number>;
  open_alerts: number;
  operators: OperatorGroup[];
  sent_by_operator: Record<string, number>;
}

/** The lead columns every figure on this page is derived from. */
interface DashboardLead extends BlockerLead, BoardLead {
  claimed_by: string | null;
  next_action_at: string | null;
}

const BLOCKER_LABEL: Record<Blocker, string> = {
  ready: "Ready to send",
  not_audited: "Not audited or queued",
  not_claimed: "Nobody has claimed it",
  no_timezone: "No timezone",
  not_qualified: "No work email",
  suppressed: "Suppressed",
  halted: "Halted or closed",
};

const BLOCKER_TONE: Record<Blocker, string> = {
  ready: "text-[var(--color-ok)]",
  not_audited: "text-[var(--color-info)]",
  not_claimed: "text-[var(--color-info)]",
  no_timezone: "text-[var(--color-warn)]",
  not_qualified: "text-[var(--color-warn)]",
  suppressed: "text-[var(--color-ink-3)]",
  halted: "text-[var(--color-ink-3)]",
};

/** A rate, or a dash when the denominator is too small to mean anything. */
function rate(numerator: number, denominator: number): string {
  if (denominator < 20) return "—";
  return `${Math.round((numerator / denominator) * 100)}%`;
}

export default async function DashboardPage() {
  const { supabase } = await requireOrgContext();

  // Four round trips, one Promise.all. Compare /settings at six and /queue at
  // four. mailboxes and alerts are folded into the RPC rather than fetched
  // separately, which is where two of the savings come from.
  const [leadRows, suppressionRows, settings, activityResult] = await Promise.all([
    supabase
      .from("leads")
      // One string literal on purpose; see the note in leads/page.tsx.
      .select(
        "status, claimed_by, timezone, is_qualified, halted_at, terminal_outcome, work_email_norm, website_domain, stage, deal_value, next_action_at",
      )
      .is("archived_at", null)
      .limit(MAX_ROWS),
    supabase.from("suppressions").select("email_norm, domain"),
    supabase.from("org_settings").select("default_deal_value, dry_run").maybeSingle(),
    supabase.rpc("dashboard_activity", { p_days: 14 }),
  ]);

  const leads = (leadRows.data ?? []) as DashboardLead[];
  const activity = activityResult.data as Activity | null;
  const defaultDealValue = Number(settings.data?.default_deal_value ?? 997);

  // --- pipeline, computed by the same code the board uses -------------------
  const open = pipelineValue(leads, defaultDealValue);
  const weighted = weightedValue(leads, defaultDealValue);
  const won = wonValue(leads, defaultDealValue);

  const byColumn = new Map<string, DashboardLead[]>();
  for (const column of BOARD_COLUMNS) byColumn.set(column, []);
  for (const lead of leads) byColumn.get(columnFor(lead))?.push(lead);

  const wonCount = byColumn.get("closed_won")?.length ?? 0;
  const lostCount = byColumn.get("closed_lost")?.length ?? 0;

  // --- work to do, computed by the same code /queue and /settings use -------
  const suppressions = suppressionIndex(suppressionRows.data);
  const pending = leads.filter((lead) => !IN_FLIGHT.has(lead.status));

  const buckets = new Map<Blocker, number>();
  for (const lead of pending) {
    const blocker = classifyLead(lead, suppressions);
    buckets.set(blocker, (buckets.get(blocker) ?? 0) + 1);
  }

  const overdue = leads.filter(
    (lead) => !lead.terminal_outcome && isOverdue(lead),
  ).length;
  const unclaimed = pending.filter((lead) => lead.claimed_by === null).length;

  // --- per operator ---------------------------------------------------------
  const groups = activity?.operators ?? [];
  const index = operatorIndex(groups);
  const names = operatorNames(groups);

  const perOperator = names.map((name) => {
    const theirs = leads.filter((lead) => operatorFor(lead.claimed_by, index) === name);
    const live = theirs.filter((lead) => !lead.terminal_outcome);
    return {
      name,
      claimed: theirs.length,
      pipeline: pipelineValue(theirs, defaultDealValue),
      won: theirs.filter((lead) => lead.terminal_outcome === "closed_won").length,
      overdue: live.filter((lead) => isOverdue(lead)).length,
      sent: activity?.sent_by_operator?.[name] ?? 0,
    };
  });

  const sentWindow = activity?.sends.sent ?? 0;

  return (
    <div className={PAGE}>
      <header className={PAGE_HEADER}>
        <h1 className="text-[var(--color-ink)]">Dashboard</h1>
        {activity && (
          <span className="text-[var(--color-ink-3)]">
            Last {activity.days} days, counted in {activity.zone}
          </span>
        )}
        {settings.data?.dry_run && (
          <span className="text-[var(--color-warn)]">
            Dry run is on, so nothing is actually sending
          </span>
        )}
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {activityResult.error ? (
          <p role="alert" className="px-1 py-4 text-[var(--color-danger)]">
            Could not load activity: {activityResult.error.message}
          </p>
        ) : null}

        <div className="grid grid-cols-2 gap-3">
          {/* --- outbound activity ------------------------------------------ */}
          <section className={PANEL}>
            <h2 className="mb-3 text-[var(--color-ink)]">Outbound</h2>

            {activity && <SendHistory series={activity.series} />}

            <div className="mt-4 flex flex-wrap gap-4">
              <Stat
                label="Sent"
                value={sentWindow}
                detail={`${activity?.sends.written ?? 0} hand-written`}
              />
              <Stat label="Planned" value={activity?.sends.planned ?? 0} />
              <Stat
                label="Blocked"
                value={activity?.sends.blocked ?? 0}
                tone={
                  (activity?.sends.blocked ?? 0) > 0 ? "text-[var(--color-warn)]" : ""
                }
              />
              <Stat
                label="Failed"
                value={activity?.sends.failed ?? 0}
                tone={
                  (activity?.sends.failed ?? 0) > 0 ? "text-[var(--color-danger)]" : ""
                }
              />
            </div>

            <div className="mt-4 flex flex-wrap gap-4">
              {/* Rates are shown only once the denominator can carry one. Two
                  replies out of three sends is not a 67% reply rate. */}
              <Stat
                label="Replied"
                value={activity?.events.replied ?? 0}
                tone="text-[var(--color-ok)]"
                detail={rate(activity?.events.replied ?? 0, sentWindow)}
              />
              <Stat
                label="Bounced"
                value={activity?.events.bounced ?? 0}
                tone={
                  (activity?.events.bounced ?? 0) > 0
                    ? "text-[var(--color-danger)]"
                    : ""
                }
                detail={rate(activity?.events.bounced ?? 0, sentWindow)}
              />
              <Stat
                label="Unsubscribed"
                value={activity?.events.unsubscribed ?? 0}
              />
            </div>
          </section>

          {/* --- mailbox headroom ------------------------------------------- */}
          <section className={PANEL}>
            <h2 className="mb-3 text-[var(--color-ink)]">Mailboxes</h2>
            {(activity?.mailboxes.length ?? 0) === 0 ? (
              <p className="text-[var(--color-ink-3)]">
                No mailbox connected.{" "}
                <Link href="/mailboxes" className="underline">
                  Connect one
                </Link>
                .
              </p>
            ) : (
              <Funnel
                rows={(activity?.mailboxes ?? []).map((mailbox) => ({
                  key: mailbox.mailbox_id,
                  label: mailbox.email.split("@")[0],
                  tone: !mailbox.sendable
                    ? "text-[var(--color-ink-3)]"
                    : mailbox.used_today >= mailbox.daily_cap
                      ? "text-[var(--color-warn)]"
                      : "text-[var(--color-info)]",
                  count: mailbox.used_today,
                  // Counted on cap_date in the MAILBOX's zone, which is the day
                  // the cap actually resets in. /mailboxes reads it the same
                  // way, so these two screens agree by construction.
                  detail: `of ${mailbox.daily_cap}`,
                }))}
              />
            )}
            <p className="mt-3 text-[var(--color-ink-3)]">
              Used today, in each mailbox&apos;s own timezone.
            </p>
          </section>

          {/* --- pipeline ---------------------------------------------------- */}
          <section className={PANEL}>
            <h2 className="mb-3 text-[var(--color-ink)]">Pipeline</h2>

            <div className="mb-4 flex flex-wrap gap-4">
              {/* Computed by lib/pipeline/stages.ts, the same functions the
                  board's stat strip calls, so the two cannot disagree. */}
              <Stat label="Open" value={formatMoney(open)} />
              <Stat
                label="Weighted"
                value={formatMoney(weighted)}
                tone="text-[var(--color-ink-2)]"
              />
              <Stat
                label="Won"
                value={formatMoney(won)}
                tone="text-[var(--color-ok)]"
              />
              <Stat
                label="Win rate"
                value={rate(wonCount, wonCount + lostCount)}
                detail={`${wonCount} won, ${lostCount} lost`}
              />
            </div>

            <Funnel
              rows={BOARD_COLUMNS.map((column) => {
                const rows = byColumn.get(column) ?? [];
                return {
                  key: column,
                  label: COLUMN_LABEL[column],
                  tone: STAGE_TONE[column] ?? "",
                  count: rows.length,
                  // Counted, not drawn: see FunnelRow.unscaled.
                  unscaled: column === "prospect",
                  // Prospect never shows a value, on this screen as on the
                  // board: thousands of unworked leads times the default is a
                  // number nobody believes.
                  detail:
                    column === "prospect"
                      ? ""
                      : formatMoney(
                          rows.reduce(
                            (total, lead) => total + dealValue(lead, defaultDealValue),
                            0,
                          ),
                        ),
                };
              })}
            />

            {activity && Object.keys(activity.stage_moves).length > 0 && (
              <p className="mt-3 text-[var(--color-ink-3)]">
                Moved in the last {activity.days} days:{" "}
                {Object.entries(activity.stage_moves)
                  .map(
                    ([stage, n]) =>
                      `${n} to ${COLUMN_LABEL[stage as BoardColumn] ?? stage}`,
                  )
                  .join(", ")}
                .
              </p>
            )}
          </section>

          {/* --- work to do now ---------------------------------------------- */}
          <section className={PANEL}>
            <h2 className="mb-3 text-[var(--color-ink)]">Now</h2>

            <div className="mb-4 flex flex-wrap gap-4">
              <Stat
                label="Overdue follow-ups"
                value={overdue}
                tone={overdue > 0 ? "text-[var(--color-danger)]" : ""}
              />
              <Stat
                label="Open alerts"
                value={activity?.open_alerts ?? 0}
                tone={
                  (activity?.open_alerts ?? 0) > 0 ? "text-[var(--color-ok)]" : ""
                }
              />
              <Stat label="Unclaimed" value={unclaimed} />
            </div>

            {/* classifyLead from lib/queue/blockers.ts: the same seven-way
                precedence /queue lists by and /settings counts "ready" from. */}
            <Funnel
              rows={(Object.keys(BLOCKER_LABEL) as Blocker[])
                .filter((blocker) => (buckets.get(blocker) ?? 0) > 0)
                .map((blocker) => ({
                  key: blocker,
                  label: BLOCKER_LABEL[blocker],
                  tone: BLOCKER_TONE[blocker],
                  count: buckets.get(blocker) ?? 0,
                }))}
            />

            <p className="mt-3 text-[var(--color-ink-3)]">
              Grouped on{" "}
              <Link href="/queue" className="underline">
                Queue
              </Link>
              .
            </p>
          </section>

          {/* --- per operator ------------------------------------------------ */}
          <section className={PANEL + " col-span-2"}>
            <h2 className="mb-3 text-[var(--color-ink)]">By operator</h2>
            {perOperator.length === 0 ? (
              <p className="text-[var(--color-ink-3)]">Nobody in this org yet.</p>
            ) : (
              <div className="space-y-1">
                <div className="flex gap-4 text-[var(--color-ink-3)]">
                  <span className="w-[140px] shrink-0">Operator</span>
                  <span className="w-[80px] text-right">Claimed</span>
                  <span className="w-[80px] text-right">Sent</span>
                  <span className="w-[80px] text-right">Won</span>
                  <span className="w-[80px] text-right">Overdue</span>
                  <span className="w-[100px] text-right">Pipeline</span>
                </div>
                {perOperator.map((row) => (
                  <div key={row.name} className="flex gap-4 text-[var(--color-ink)]">
                    <span className="w-[140px] shrink-0 truncate">{row.name}</span>
                    <span className="tabular w-[80px] text-right">{row.claimed}</span>
                    <span className="tabular w-[80px] text-right">{row.sent}</span>
                    <span className="tabular w-[80px] text-right text-[var(--color-ok)]">
                      {row.won}
                    </span>
                    <span
                      className={
                        "tabular w-[80px] text-right " +
                        (row.overdue > 0 ? "text-[var(--color-danger)]" : "")
                      }
                    >
                      {row.overdue}
                    </span>
                    <span className="tabular w-[100px] text-right">
                      {formatMoney(row.pipeline)}
                    </span>
                  </div>
                ))}
              </div>
            )}
            {/* Both of madhav's accounts collapse to one row here, resolved in
                SQL through app.operator_aliases -- which is revoked from
                `authenticated`, so this is the only way to know. Sends are
                attributed by the mailbox they left from rather than by who owns
                the lead now, because a pinned thread keeps going out of the
                original account after a reassignment. */}
            <p className="mt-3 text-[var(--color-ink-3)]">
              Sends are counted against the mailbox they left from, over the last{" "}
              {activity?.days ?? 14} days. Everything else is current.
            </p>
          </section>
        </div>

        {/* The thing this screen deliberately does not draw. */}
        <p className="mt-3 px-1 text-[var(--color-ink-3)]">
          There is no pipeline-value-over-time line here on purpose: nothing
          snapshots it, and deal_value edits are plain updates that leave no
          event, so any such line would be a guess drawn confidently.
        </p>
      </div>
    </div>
  );
}
