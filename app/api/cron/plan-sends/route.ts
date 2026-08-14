// The planner.
//
// Decides WHEN each lead's next touch should go out, and books it. It sends
// nothing: the row it writes is `planned`, and the dispatcher is the only thing
// that ever turns one into an email.
//
// Everything here is prospect-local except the capacity arithmetic, which is
// mailbox-local, and the split is the whole point. A slot is chosen in the
// prospect's morning; whether there is room for it is a question about the
// operator's day, because a daily cap is a Gmail reputation limit on the
// sending account.
//
// Service role: this runs from pg_cron with no user session and must see every
// org's leads.

import type { SupabaseClient } from "@supabase/supabase-js";
import { DateTime } from "luxon";

import { requireBearer } from "@/lib/cronAuth";
import { serverEnv } from "@/lib/env";
import {
  buildCapacity,
  pickMailbox,
  reserve,
  type BookingMailbox,
  type Capacity,
} from "@/lib/scheduler/book";
import {
  buildMailboxSenders,
  mailboxesForSend,
  pinnedMailboxIdFor,
} from "@/lib/scheduler/routing";
import {
  CADENCE_BUSINESS_DAYS,
  MAX_STEP,
  nextSlot,
  windowsFromSettings,
} from "@/lib/scheduler/slots";
import { createAdminSupabase } from "@/lib/supabase/admin";
import { addBusinessDays } from "@/lib/timezone/businessDays";
import { holidaySet } from "@/lib/timezone/holidays";

export const runtime = "nodejs";
export const maxDuration = 60;

/** Statuses from which a lead may still receive its next touch. */
const SENDABLE_STATUSES: string[] = [
  "audited",
  "queued",
  "sent",
  "delivered",
  "opened",
];

/** A send that is booked, in flight, or already out. */
const LIVE_STATUSES: string[] = [
  "planned",
  "blocked",
  "claimed",
  "sending",
  "sent",
];

interface Settings {
  org_id: string;
  morning_start_hour: number;
  morning_end_hour: number;
  afternoon_start_hour: number;
  afternoon_end_hour: number;
  max_lookahead_days: number;
  slot_grace_minutes: number;
  first_touch_weekdays: number[];
  followup_weekdays: number[];
}

interface Mailbox {
  id: string;
  /** The operator this mailbox belongs to. Decides who it may send for. */
  user_id: string | null;
  timezone: string;
  daily_cap: number;
}

interface Template {
  id: string;
  step_number: number;
  angle_type: string | null;
  requires_demo: boolean;
}

interface Lead {
  id: string;
  angle_type: string | null;
  timezone: string | null;
  work_email_norm: string | null;
  website_domain: string | null;
  demo_ready_at: string | null;
  status: string;
  /** Whose lead it is, and therefore whose mailbox its touches go out from. */
  claimed_by: string | null;
}

interface Send {
  id: string;
  lead_id: string;
  mailbox_id: string | null;
  step_number: number;
  status: string;
  scheduled_at: string;
  sent_at: string | null;
  plan_attempt: number;
  /**
   * Set when an operator wrote this touch by hand. The planner never composes
   * one, but it does re-time one whose slot passed, and it must not put a
   * template back over the words while doing it.
   */
  composed_body: string | null;
}

export interface PlanReport {
  org_id: string;
  planned: number;
  rolled_forward: number;
  blocked: number;
  cancelled: number;
  skipped_no_template: number;
  skipped_no_demo: number;
  skipped_suppressed: number;
  /**
   * Owner has no sendable mailbox, or the thread's mailbox went away. Counted
   * rather than silently skipped: it means somebody's leads have quietly
   * stopped, which is invisible if it only shows up as a smaller `planned`.
   */
  skipped_no_mailbox: number;
}

// ---------------------------------------------------------------------------

async function raiseAlert(
  supabase: SupabaseClient,
  alert: {
    org_id: string;
    kind: string;
    message: string;
    lead_id?: string | null;
    mailbox_id?: string | null;
    dedupe_token: string;
    payload?: Record<string, unknown>;
  },
) {
  // ignoreDuplicates, because a planner on a ten-minute schedule would
  // otherwise produce a hundred and forty identical rows a day for one stuck
  // lead, and an alert list nobody can read is an alert list nobody reads.
  await supabase.from("alerts").upsert(
    {
      org_id: alert.org_id,
      kind: alert.kind,
      message: alert.message,
      lead_id: alert.lead_id ?? null,
      mailbox_id: alert.mailbox_id ?? null,
      dedupe_token: alert.dedupe_token,
      payload: alert.payload ?? {},
    },
    { onConflict: "org_id,kind,dedupe_token", ignoreDuplicates: true },
  );
}

/** The active template for a step, preferring one pinned to the lead's angle. */
function templateFor(
  templates: Template[],
  step: number,
  angle: string | null,
): Template | null {
  const forStep = templates.filter((t) => t.step_number === step);
  return (
    forStep.find((t) => t.angle_type !== null && t.angle_type === angle) ??
    forStep.find((t) => t.angle_type === null) ??
    null
  );
}

// ---------------------------------------------------------------------------

async function planOrg(
  supabase: SupabaseClient,
  settings: Settings,
): Promise<PlanReport> {
  const orgId = settings.org_id;
  const report: PlanReport = {
    org_id: orgId,
    planned: 0,
    rolled_forward: 0,
    blocked: 0,
    cancelled: 0,
    skipped_no_template: 0,
    skipped_no_demo: 0,
    skipped_suppressed: 0,
    skipped_no_mailbox: 0,
  };

  const now = DateTime.now();

  const [
    { data: mailboxRows },
    { data: senderRows },
    { data: templateRows },
    { data: suppressionRows },
  ] = await Promise.all([
    supabase
      .from("mailboxes")
      .select("id, user_id, timezone, daily_cap")
      .eq("org_id", orgId)
      .eq("is_sendable", true)
      .order("id"),
    // Which accounts may send from which mailbox. The org is explicit because
    // this runs as the service role, which has no auth.uid() for
    // app.current_org_id() to resolve.
    supabase.rpc("mailbox_senders", { p_org: orgId }),
    supabase
      .from("templates")
      .select("id, step_number, angle_type, requires_demo")
      .eq("org_id", orgId)
      .eq("is_active", true),
    supabase.from("suppressions").select("email_norm, domain").eq("org_id", orgId),
  ]);

  const mailboxes = (mailboxRows ?? []) as Mailbox[];
  const senders = buildMailboxSenders(
    (senderRows ?? []) as { mailbox_id: string; user_id: string }[],
  );
  const templates = (templateRows ?? []) as Template[];

  const suppressedEmails = new Set(
    (suppressionRows ?? []).map((s) => s.email_norm).filter(Boolean) as string[],
  );
  const suppressedDomains = new Set(
    (suppressionRows ?? []).map((s) => s.domain).filter(Boolean) as string[],
  );

  // --- every live send, and the capacity it already consumes ----------------

  const { data: sendRows } = await supabase
    .from("scheduled_sends")
    .select(
      "id, lead_id, mailbox_id, step_number, status, scheduled_at, sent_at, plan_attempt, composed_body",
    )
    .eq("org_id", orgId)
    .in("status", LIVE_STATUSES);

  const sends = (sendRows ?? []) as Send[];

  const byLead = new Map<string, Send[]>();
  for (const send of sends) {
    const list = byLead.get(send.lead_id);
    if (list) list.push(send);
    else byLead.set(send.lead_id, [send]);
  }

  // How much of each mailbox's day is already spoken for. Shared with the
  // composer, which asks the same question about one lead at a time: two copies
  // of cap arithmetic would eventually disagree about whether there is room,
  // and the disagreement would show up as over-sending.
  const capacity: Capacity = buildCapacity(mailboxes, sends, now);

  // --- candidate leads ------------------------------------------------------

  const { data: leadRows } = await supabase
    .from("leads")
    .select(
      "id, angle_type, timezone, work_email_norm, website_domain, demo_ready_at, status, claimed_by",
    )
    .eq("org_id", orgId)
    .eq("is_qualified", true)
    .is("archived_at", null)
    .is("halted_at", null)
    .is("terminal_outcome", null)
    .not("claimed_by", "is", null)
    // A lead with no resolvable IANA zone is NEVER scheduled. This is the
    // filter that enforces it, and the reason there is no state-to-timezone
    // fallback anywhere in this repo.
    .not("timezone", "is", null)
    .in("status", SENDABLE_STATUSES)
    .limit(2000);

  const leads = (leadRows ?? []) as Lead[];

  // --- cancel what should never go out --------------------------------------
  // A lead that replied, bounced, was closed or got suppressed after its next
  // touch was booked. The claimer already refuses halted leads, so this is
  // tidiness rather than safety, but a queue full of sends that will never
  // fire is a queue nobody trusts.

  const candidateIds = new Set(leads.map((l) => l.id));

  const stale = sends.filter(
    (send) =>
      (send.status === "planned" || send.status === "blocked") &&
      !candidateIds.has(send.lead_id),
  );

  if (stale.length > 0) {
    const { data: cancelled } = await supabase
      .from("scheduled_sends")
      .update({
        status: "cancelled",
        outcome_reason: "the lead stopped being sendable after this was booked",
      })
      .in(
        "id",
        stale.map((s) => s.id),
      )
      .in("status", ["planned", "blocked"])
      .select("id");
    report.cancelled = cancelled?.length ?? 0;
  }

  if (mailboxes.length === 0) {
    await raiseAlert(supabase, {
      org_id: orgId,
      kind: "mailbox_auth",
      message: "No sendable mailbox is connected, so nothing can be planned.",
      dedupe_token: "no-sendable-mailbox",
    });
    return report;
  }

  // --- plan -----------------------------------------------------------------

  const holidays = holidaySet(now.year, now.year + 2);
  const graceCutoff = now.minus({ minutes: settings.slot_grace_minutes });
  const windows = windowsFromSettings(settings);

  for (const lead of leads) {
    const zone = lead.timezone!;
    const leadSends = byLead.get(lead.id) ?? [];

    // Already on its way. Nothing to decide until it lands.
    if (leadSends.some((s) => s.status === "claimed" || s.status === "sending")) {
      continue;
    }

    const suppressed =
      (lead.work_email_norm && suppressedEmails.has(lead.work_email_norm)) ||
      (lead.website_domain && suppressedDomains.has(lead.website_domain));

    if (suppressed) {
      report.skipped_suppressed += 1;
      const booked = leadSends.filter(
        (s) => s.status === "planned" || s.status === "blocked",
      );
      if (booked.length > 0) {
        await supabase
          .from("scheduled_sends")
          .update({
            status: "cancelled",
            outcome_reason: "suppressed after the send was booked",
          })
          .in(
            "id",
            booked.map((s) => s.id),
          )
          .in("status", ["planned", "blocked"]);
        report.cancelled += booked.length;
      }
      continue;
    }

    // A slot that has already come and gone. Roll it forward rather than
    // sending it late: the claimer cannot see it any more, and the window it
    // was chosen for is the whole reason it was chosen.
    const missed = leadSends.find(
      (s) =>
        s.status === "planned" && DateTime.fromISO(s.scheduled_at) < graceCutoff,
    );

    const existingPlanned = leadSends.find((s) => s.status === "planned");
    const existingBlocked = leadSends.find((s) => s.status === "blocked");

    if (existingPlanned && !missed) continue; // booked and still in the future

    // Which touch is next. Counted from the highest step actually SENT, so a
    // failed or cancelled attempt does not advance the sequence.
    const sentSteps = leadSends.filter((s) => s.status === "sent");
    const lastSent = sentSteps.reduce<Send | null>(
      (best, s) => (best === null || s.step_number > best.step_number ? s : best),
      null,
    );

    const rollingForward = missed ?? existingBlocked ?? null;
    const step = rollingForward
      ? rollingForward.step_number
      : (lastSent?.step_number ?? 0) + 1;

    if (step > MAX_STEP) continue;

    // A written email that missed its slot. It already has its words, so
    // neither the template lookup nor the demo gate applies to it: this pass is
    // only choosing a new instant. Requiring a template here would strand a
    // hand-written send forever the moment its step had no active template,
    // which is precisely the situation composing exists to work around.
    const written = rollingForward?.composed_body != null;

    const template = written
      ? null
      : templateFor(templates, step, lead.angle_type);

    if (!written && !template) {
      report.skipped_no_template += 1;
      await raiseAlert(supabase, {
        org_id: orgId,
        kind: "pre_send_review",
        message: `No active template for step ${step}. Nothing can be planned for it.`,
        dedupe_token: `no-template:${step}:${lead.angle_type ?? "any"}`,
        payload: { step, angle_type: lead.angle_type },
      });
      continue;
    }

    // demo_ready deliberately does not advance status (see the rank table in
    // 0004), so this is the only thing that can hold a step back for it.
    if (template && template.requires_demo && !lead.demo_ready_at) {
      report.skipped_no_demo += 1;
      await raiseAlert(supabase, {
        org_id: orgId,
        kind: "demo_missing",
        lead_id: lead.id,
        message: `Step ${step} needs a built demo and this lead has none.`,
        dedupe_token: `demo:${lead.id}:${step}`,
        payload: { step },
      });
      continue;
    }

    // The earliest prospect-local day this touch may land on. For a follow-up
    // that is counted in business days from the previous step's ACTUAL send.
    let earliestDay: DateTime = now.setZone(zone).startOf("day");
    if (step > 1) {
      if (!lastSent?.sent_at) continue; // no previous send: nothing to count from
      const offset = CADENCE_BUSINESS_DAYS[step] ?? 0;
      earliestDay = addBusinessDays(
        DateTime.fromISO(lastSent.sent_at).setZone(zone).startOf("day"),
        offset,
        holidays,
      );
    }

    const allowedWeekdays =
      step === 1 ? settings.first_touch_weekdays : settings.followup_weekdays;

    const attempt = (rollingForward?.plan_attempt ?? -1) + 1;

    // Whose mailbox this touch may use. The lead's owner, or -- once a touch has
    // gone out -- the account that already holds the thread, because the Gmail
    // threadId dispatch-sends reuses only exists inside that one mailbox.
    const routed = mailboxesForSend(mailboxes, {
      ownerId: lead.claimed_by,
      pinnedMailboxId: pinnedMailboxIdFor(leadSends),
      senders,
    });

    if (!routed.ok) {
      report.skipped_no_mailbox += 1;

      await raiseAlert(supabase, {
        org_id: orgId,
        kind: "mailbox_auth",
        lead_id: lead.id,
        message:
          routed.blocked === "pin_unavailable"
            ? "This lead's thread started on a mailbox that is now paused or disconnected, so its follow-up cannot go out."
            : "This lead's owner has no sendable mailbox, so nothing can be planned for it.",
        dedupe_token: `no-owner-mailbox:${lead.id}`,
      });

      continue;
    }

    // Walk forward until a day has both a slot and a mailbox with room on it.
    let cursor: DateTime = earliestDay;
    // BookingMailbox, not Mailbox: pickMailbox returns what book.ts knows about
    // a mailbox, and only the id is read from it here.
    let placed: { at: DateTime; mailbox: BookingMailbox; capDate: string } | null =
      null;

    for (let tries = 0; tries <= settings.max_lookahead_days; tries++) {
      const slot = nextSlot({
        notBefore: now,
        earliestDay: cursor,
        zone,
        windows,
        holidays,
        allowedWeekdays: allowedWeekdays ?? [],
        maxLookaheadDays: settings.max_lookahead_days,
        seed: `${lead.id}:${step}:${attempt}`,
      });

      if (!slot.ok) break;

      const chosen = pickMailbox(capacity, routed.mailboxes, slot.at);
      if (chosen) {
        placed = { at: slot.at, mailbox: chosen.mailbox, capDate: chosen.capDate };
        break;
      }

      // Every mailbox is full on this day. Try the next one.
      cursor = slot.at.plus({ days: 1 }).startOf("day");
      if (cursor.diff(earliestDay, "days").days > settings.max_lookahead_days) break;
    }

    if (!placed) {
      report.blocked += 1;

      const blockedRow = {
        status: "blocked" as const,
        outcome_reason: `no mailbox capacity within ${settings.max_lookahead_days} days`,
        plan_attempt: attempt,
      };

      if (rollingForward) {
        await supabase
          .from("scheduled_sends")
          .update(blockedRow)
          .eq("id", rollingForward.id);
      } else {
        await supabase.from("scheduled_sends").insert({
          org_id: orgId,
          lead_id: lead.id,
          // Not composed: `written` requires a row to roll forward, and this
          // branch is the one where there is none.
          template_id: template!.id,
          step_number: step,
          touch_kind: step === 1 ? "first" : "followup",
          prospect_timezone: zone,
          // A blocked row still has to carry a slot: the column is NOT NULL,
          // and the honest value is the first instant we could not fit it into.
          scheduled_at: now.toUTC().toISO(),
          scheduled_local: now.setZone(zone).toFormat("yyyy-MM-dd'T'HH:mm:ss"),
          ...blockedRow,
        });
      }

      await raiseAlert(supabase, {
        org_id: orgId,
        kind: "cap_exhausted",
        lead_id: lead.id,
        message: `Step ${step} could not be fitted into the next ${settings.max_lookahead_days} days. Raise a daily cap or connect another mailbox.`,
        dedupe_token: `cap:${lead.id}:${step}`,
        payload: { step },
      });
      continue;
    }

    const row = {
      mailbox_id: placed.mailbox.id,
      // A written send keeps whatever template it was started from, if any.
      // Overwriting it would misreport where the words came from, and the
      // dispatcher prefers composed_body regardless.
      ...(written ? {} : { template_id: template!.id }),
      status: "planned" as const,
      scheduled_at: placed.at.toUTC().toISO(),
      // The prospect-local wall clock, stored so the queue screen never has to
      // do timezone arithmetic to show what an operator actually cares about.
      scheduled_local: placed.at.toFormat("yyyy-MM-dd'T'HH:mm:ss"),
      prospect_timezone: zone,
      plan_attempt: attempt,
      outcome_reason: null,
    };

    if (rollingForward) {
      const { data: updated } = await supabase
        .from("scheduled_sends")
        .update(row)
        .eq("id", rollingForward.id)
        .in("status", ["planned", "blocked"])
        .select("id");
      if (updated && updated.length > 0) {
        report.rolled_forward += 1;
        reserve(capacity, placed.mailbox.id, placed.capDate);
      }
    } else {
      const { data: inserted, error } = await supabase
        .from("scheduled_sends")
        .insert({
          org_id: orgId,
          lead_id: lead.id,
          step_number: step,
          touch_kind: step === 1 ? "first" : "followup",
          ...row,
        })
        .select("id");

      // 23505 is scheduled_sends_lead_step_live: something else booked this
      // step between our read and our write. That is the index doing its job.
      if (!error && inserted && inserted.length > 0) {
        report.planned += 1;
        reserve(capacity, placed.mailbox.id, placed.capDate);
      }
    }
  }

  return report;
}

// ---------------------------------------------------------------------------

export async function POST(request: Request) {
  const denied = requireBearer(request, serverEnv().cronSecret);
  if (denied) return denied;

  const supabase = createAdminSupabase();

  // Optional scope. Every scheduled run plans every org; naming one is for
  // re-planning after a settings change, and for tests, which must never touch
  // an org they did not create.
  const onlyOrg = new URL(request.url).searchParams.get("org");

  let query = supabase
    .from("org_settings")
    // One string literal: concatenating a select list collapses supabase-js's
    // result type to an error type.
    .select(
      "org_id, morning_start_hour, morning_end_hour, afternoon_start_hour, afternoon_end_hour, max_lookahead_days, slot_grace_minutes, first_touch_weekdays, followup_weekdays",
    );

  if (onlyOrg) query = query.eq("org_id", onlyOrg);

  const { data: settingsRows, error } = await query;

  if (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }

  const reports: PlanReport[] = [];
  for (const settings of (settingsRows ?? []) as Settings[]) {
    reports.push(await planOrg(supabase, settings));
  }

  return Response.json({ orgs: reports.length, reports });
}
