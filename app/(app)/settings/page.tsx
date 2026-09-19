import { ArrowRight, CircleCheck, TriangleAlert } from "lucide-react";
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
import { selectAll } from "@/lib/supabase/paginate";

import { PANEL } from "../ui";
import { OpsPanel, type ScheduledJob } from "./OpsPanel";
import { type OrgSettingsRow, SettingsForm } from "./SettingsForm";

import { Badge } from "@/components/ui/Badge";
import { LoadError } from "@/components/ui/LoadError";
import { Page, PageHeader } from "@/components/ui/PageShell";
import { buttonClasses } from "@/components/ui/Button";

export const dynamic = "force-dynamic";

interface Check {
  ok: boolean;
  label: string;
  detail: string;
  href?: Route;
  linkLabel?: string;
}

function CheckLine({ check }: { check: Check }) {
  const Icon = check.ok ? CircleCheck : TriangleAlert;
  return (
    <li className="flex items-center gap-3 border-b border-line py-2 last:border-0">
      <Icon
        size={15}
        aria-hidden="true"
        className={check.ok ? "shrink-0 text-ok" : "shrink-0 text-warn"}
      />
      <span className="w-64 shrink-0 font-medium text-ink">{check.label}</span>
      <span className="min-w-0 flex-1 text-ink-2">{check.detail}</span>
      {check.href && !check.ok && (
        <Link
          href={check.href}
          className={buttonClasses("secondary", "sm", "ml-auto shrink-0")}
        >
          {check.linkLabel ?? "Fix"}
          <ArrowRight size={12} />
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
    { data: bookedRows },
  ] = await Promise.all([
    supabase
      .from("org_settings")
      .select(
        "dry_run, operator_timezone, morning_start_hour, morning_end_hour, afternoon_start_hour, afternoon_end_hour, first_touch_weekdays, followup_weekdays, max_lookahead_days, slot_grace_minutes, stall_minutes, send_gap_min_minutes, send_gap_max_minutes",
      )
      .eq("org_id", orgId)
      .maybeSingle(),
    supabase
      .from("mailboxes")
      .select("email, display_name, is_sendable, disconnected_at, timezone"),
    supabase.from("templates").select("name, step_number, is_active, requires_demo"),
    // Every lead, in pages: PostgREST stops at 1000 rows per response, and
    // "what is still between you and the first email" is a count.
    selectAll<BlockerLead & { id: string }>(() =>
      supabase
        .from("leads")
        // One string literal on purpose; see the note in leads/page.tsx.
        .select(
          "id, status, claimed_by, timezone, is_qualified, halted_at, terminal_outcome, work_email_norm, website_domain",
        )
        .is("archived_at", null),
    ),
    selectAll<{ id: string; email_norm: string | null; domain: string | null }>(() =>
      supabase.from("suppressions").select("id, email_norm, domain"),
    ),
    // pg_cron's tables are unreadable by `authenticated`; 0020 exposes exactly
    // this summary through a definer function. An empty result means nothing is
    // scheduled, which is a real answer rather than a missing one.
    supabase.rpc("background_jobs_status"),
    // Leads with an email already booked or on its way. They are not "ready"
    // any more, but they are certainly not a reason to say nothing can send.
    selectAll<{ id: string; lead_id: string }>(() =>
      supabase
        .from("scheduled_sends")
        .select("id, lead_id")
        .in("status", ["planned", "blocked", "claimed", "sending"]),
    ),
  ]);

  const settings = settingsRow as OrgSettingsRow | null;
  const mailboxes = mailboxRows ?? [];
  const templates = templateRows ?? [];
  const leads = (leadRows ?? []) as (BlockerLead & { id: string })[];

  const schedule = new Map<string, ScheduledJob>(
    ((scheduleRows ?? []) as ScheduledJob[]).map((row) => [row.job, row]),
  );

  const suppressions = suppressionIndex(suppressionRows);
  const pending = leads.filter((lead) => !IN_FLIGHT.has(lead.status));
  const bookedIds = new Set((bookedRows ?? []).map((row) => row.lead_id));
  const blockers = pending.map((lead) =>
    classifyLead(lead, suppressions, bookedIds.has(lead.id)),
  );
  const ready = blockers.filter((blocker) => blocker === "ready").length;
  const booked = blockers.filter((blocker) => blocker === "booked").length;
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
      ok: ready + booked > 0,
      label: "At least one lead ready or booked",
      detail:
        ready + booked > 0
          ? `${ready} ready to plan${booked > 0 ? `, ${booked} with a first email already booked` : ""}. Ready means claimed, qualified, zoned, not suppressed, and either audited or queued without one.${noTimezone > 0 ? ` ${noTimezone} more are waiting on a timezone.` : ""}`
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
    <Page>
      <PageHeader
        title="Settings"
        actions={
          <Badge tone={blocking === 0 ? "ok" : "warn"}>
            {blocking === 0
              ? "Ready to send"
              : `${blocking} thing${blocking === 1 ? "" : "s"} between here and the first email`}
          </Badge>
        }
      />

      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        <div className="max-w-[1100px] space-y-4">
          <div className={PANEL}>
            <h2 className="text-xl font-semibold text-ink">Before the first send</h2>
            <ul className="mt-2">
              {checks.map((check) => (
                <CheckLine key={check.label} check={check} />
              ))}
            </ul>
          </div>

          {settingsError && (
            <LoadError compact what="the settings" message={settingsError.message} />
          )}

          {settings ? (
            <SettingsForm settings={settings} canEdit={role === "admin"} />
          ) : (
            !settingsError && (
              <p className={PANEL + " text-danger"}>
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
    </Page>
  );
}
