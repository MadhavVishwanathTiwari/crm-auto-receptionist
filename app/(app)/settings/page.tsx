import type { Route } from "next";
import Link from "next/link";

import { requireOrgContext } from "@/lib/org";
import { JOBS } from "@/lib/ops/jobs";
import {
  type BlockerLead,
  classifyLead,
  IN_FLIGHT,
  suppressionIndex,
} from "@/lib/queue/blockers";

import { PAGE, PAGE_HEADER, PANEL } from "../ui";
import { OpsPanel, type ScheduledJob } from "./OpsPanel";
import { type OrgSettingsRow, SettingsForm } from "./SettingsForm";

export const dynamic = "force-dynamic";

interface Check {
  ok: boolean;
  label: string;
  detail: string;
  href?: Route;
  linkLabel?: string;
}

function CheckLine({ check }: { check: Check }) {
  return (
    <li className="flex gap-3 py-0.5">
      <span
        aria-hidden
        className={
          "w-4 shrink-0 " +
          (check.ok ? "text-[var(--color-ok)]" : "text-[var(--color-warn)]")
        }
      >
        {check.ok ? "+" : "!"}
      </span>
      <span className="w-64 shrink-0 text-[var(--color-ink)]">{check.label}</span>
      <span className="text-[var(--color-ink-2)]">{check.detail}</span>
      {check.href && !check.ok && (
        <Link
          href={check.href}
          className="ml-auto shrink-0 text-[var(--color-info)] hover:underline"
        >
          {check.linkLabel ?? "fix"}
        </Link>
      )}
    </li>
  );
}

export default async function SettingsPage() {
  const { supabase, orgId, role } = await requireOrgContext();

  const [
    { data: settingsRow, error: settingsError },
    { data: mailboxRows },
    { data: templateRows },
    { data: leadRows },
    { data: suppressionRows },
    { data: scheduleRows },
  ] = await Promise.all([
    supabase
      .from("org_settings")
      .select(
        "dry_run, operator_timezone, morning_start_hour, morning_end_hour, afternoon_start_hour, afternoon_end_hour, first_touch_weekdays, followup_weekdays, max_lookahead_days, slot_grace_minutes, stall_minutes",
      )
      .eq("org_id", orgId)
      .maybeSingle(),
    supabase
      .from("mailboxes")
      .select("email, display_name, is_sendable, disconnected_at, timezone"),
    supabase.from("templates").select("name, step_number, is_active, requires_demo"),
    supabase
      .from("leads")
      // One string literal on purpose; see the note in leads/page.tsx.
      .select(
        "status, claimed_by, timezone, is_qualified, halted_at, terminal_outcome, work_email_norm, website_domain",
      )
      .is("archived_at", null)
      .limit(5000),
    supabase.from("suppressions").select("email_norm, domain"),
    // pg_cron's tables are unreadable by `authenticated`; 0020 exposes exactly
    // this summary through a definer function. An empty result means nothing is
    // scheduled, which is a real answer rather than a missing one.
    supabase.rpc("background_jobs_status"),
  ]);

  const settings = settingsRow as OrgSettingsRow | null;
  const mailboxes = mailboxRows ?? [];
  const templates = templateRows ?? [];
  const leads = (leadRows ?? []) as BlockerLead[];

  const schedule = new Map<string, ScheduledJob>(
    ((scheduleRows ?? []) as ScheduledJob[]).map((row) => [row.job, row]),
  );

  const suppressions = suppressionIndex(suppressionRows);
  const pending = leads.filter((lead) => !IN_FLIGHT.has(lead.status));
  const ready = pending.filter(
    (lead) => classifyLead(lead, suppressions) === "ready",
  ).length;
  const noTimezone = pending.filter((lead) => !lead.timezone).length;

  const sendable = mailboxes.filter((m) => m.is_sendable);
  const unnamed = sendable.filter((m) => !m.display_name?.trim());
  const activeSteps = new Set(
    templates.filter((t) => t.is_active).map((t) => t.step_number as number),
  );
  const missingSteps = [1, 2, 3, 4].filter((step) => !activeSteps.has(step));

  // Ordered the way they block: no mailbox stops everything, no template stops
  // planning, no ready lead means there is nothing to plan, and dry run is last
  // because it is the switch you throw once the three above are green.
  const checks: Check[] = [
    {
      ok: sendable.length > 0,
      label: "A mailbox that can send",
      detail:
        sendable.length > 0
          ? `${sendable.map((m) => m.email).join(", ")}`
          : "Nothing is connected, or every mailbox is paused or disconnected.",
      href: "/mailboxes",
      linkLabel: "connect",
    },
    {
      ok: sendable.length > 0 && unnamed.length === 0,
      label: "Each mailbox has a display name",
      detail:
        unnamed.length === 0
          ? "Set, so the From header carries a human name."
          : `${unnamed.map((m) => m.email).join(", ")} has none. It is the From header and {{sender_name}}, and a template using that variable refuses to send rather than putting an address where a name belongs.`,
      href: "/mailboxes",
      linkLabel: "name it",
    },
    {
      ok: activeSteps.has(1),
      label: "An active first-touch template, for the automated touches",
      detail: activeSteps.has(1)
        ? missingSteps.length === 0
          ? "All four touches are live."
          : `T1 is live. Still drafts: ${missingSteps.map((s) => `T${s}`).join(", ")}. The planner skips a step with no active template, and T2 is the one carrying the demo link.`
        : "None, so the planner skips every lead as skipped_no_template. This does not block the Write screen: an email you type yourself carries its own words and needs no template at all.",
      href: "/templates",
      linkLabel: "write one",
    },
    {
      ok: ready > 0,
      label: "At least one lead ready",
      detail:
        ready > 0
          ? `${ready} claimed, qualified, zoned, not suppressed, and either audited or queued without one.${noTimezone > 0 ? ` ${noTimezone} more are waiting on a timezone.` : ""}`
          : `Nothing the planner can pick up. It wants a lead that is claimed, zoned, and either audited or explicitly queued without one. The Write screen is looser: anything claimed, qualified and zoned can be written to by hand, and writing it is what queues it.${noTimezone > 0 ? ` ${noTimezone} have no zone.` : ""}`,
      href: "/queue",
      linkLabel: "see why",
    },
    {
      ok: settings ? !settings.dry_run : false,
      label: "Dry run off",
      detail: settings?.dry_run
        ? "On, so claim_due_sends() returns nothing and the dispatcher has nothing to send. This is the last switch."
        : "Off. Mail goes out.",
    },
  ];

  const blocking = checks.filter((check) => !check.ok).length;

  return (
    <div className={PAGE}>
      <header className={PAGE_HEADER}>
        <h1 className="text-[var(--color-ink)]">Settings</h1>
        <span
          className={
            blocking === 0
              ? "text-[var(--color-ok)]"
              : "text-[var(--color-warn)]"
          }
        >
          {blocking === 0
            ? "ready to send"
            : `${blocking} thing${blocking === 1 ? "" : "s"} between here and the first email`}
        </span>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        <div className="max-w-[1100px] space-y-4">
          <div className={PANEL}>
            <h2 className="text-[var(--color-ink)]">Before the first send</h2>
            <ul className="mt-2">
              {checks.map((check) => (
                <CheckLine key={check.label} check={check} />
              ))}
            </ul>
          </div>

          {settingsError && (
            <p role="alert" className={PANEL + " text-[var(--color-danger)]"}>
              Could not load the settings: {settingsError.message}
            </p>
          )}

          {settings ? (
            <SettingsForm settings={settings} canEdit={role === "admin"} />
          ) : (
            !settingsError && (
              <p className={PANEL + " text-[var(--color-danger)]"}>
                This org has no settings row, so the planner has no window to
                place slots in. That row is created with the org; its absence is
                a provisioning bug rather than something to fix here.
              </p>
            )
          )}

          <OpsPanel
            jobs={JOBS.map((job) => ({
              ...job,
              scheduled: schedule.get(job.name) ?? null,
            }))}
          />
        </div>
      </div>
    </div>
  );
}
