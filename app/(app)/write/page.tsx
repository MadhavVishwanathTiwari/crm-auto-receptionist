// The composer.
//
// This is the screen the app exists for. Everything else in the repo either
// feeds it (import, dedupe, claim, timezone resolution, audit) or carries out
// what it decides (plan, claim, dispatch, poll). An operator opens it, reads one
// business, writes one email to that business, presses send, and moves to the
// next. They never pick a time, never think about a daily cap, and never see a
// timezone they have to convert in their head.
//
// The slot next to each lead is computed here, on the server, by the same
// functions the action uses to book it. Capacity is reserved as the list is
// walked, so the twentieth lead does not claim the same seat as the first: what
// the operator sees is what would happen if they wrote to all of them in order.

import { requireOrgContext } from "@/lib/org";
import { bookSlot, reserve } from "@/lib/scheduler/book";
import { buildTemplateValues, type EvidenceForRender } from "@/lib/templates/render";
import {
  earliestDayFor,
  loadWriteContext,
  nextStepFor,
} from "@/lib/write/context";

import { PAGE, PAGE_HEADER, PANEL } from "../ui";
import { WriteClient, type Draft, type StarterTemplate } from "./WriteClient";

export const dynamic = "force-dynamic";

/** How many leads the worklist offers at once. */
const WORKLIST_LIMIT = 150;

interface LeadRow {
  id: string;
  company_name: string | null;
  first_name: string | null;
  last_name: string | null;
  title: string | null;
  work_email: string | null;
  work_email_norm: string | null;
  website: string | null;
  website_domain: string | null;
  phone: string | null;
  city: string | null;
  state: string | null;
  industry: string | null;
  rating: number | null;
  reviews_count: number | null;
  timezone: string | null;
  status: string;
  angle_type: string | null;
  demo_txt_url: string | null;
  demo_web_url: string | null;
  created_at: string;
}

export default async function WritePage() {
  const { supabase, userId } = await requireOrgContext();

  const write = await loadWriteContext(supabase);

  if (!write) {
    return (
      <div className={PAGE}>
        <header className={PAGE_HEADER}>
          <h1 className="text-[var(--color-ink)]">Write</h1>
        </header>
        <div className="p-4">
          <p className={PANEL + " text-[var(--color-danger)]"}>
            This org has no settings row, so nothing can be scheduled.
          </p>
        </div>
      </div>
    );
  }

  // Claimed by ME. Two operators sharing one outbox is the collision the claim
  // exists to prevent, and it matters more here than anywhere else: writing a
  // personal email to somebody else's lead wastes the writing, not just a click.
  const { data: leadRows, error } = await supabase
    .from("leads")
    // One string literal on purpose; see the note in leads/page.tsx.
    .select(
      "id, company_name, first_name, last_name, title, work_email, work_email_norm, website, website_domain, phone, city, state, industry, rating, reviews_count, timezone, status, angle_type, demo_txt_url, demo_web_url, created_at",
    )
    .eq("claimed_by", userId)
    .eq("is_qualified", true)
    .is("archived_at", null)
    .is("halted_at", null)
    .is("terminal_outcome", null)
    .not("timezone", "is", null)
    .not("work_email", "is", null)
    .order("created_at", { ascending: true })
    .limit(WORKLIST_LIMIT * 2);

  const leads = (leadRows ?? []) as LeadRow[];

  const [{ data: templateRows }, { data: evidenceRows }] = await Promise.all([
    supabase
      .from("templates")
      .select("id, name, step_number, angle_type, subject, body, requires_demo, is_active")
      .order("step_number", { ascending: true })
      .order("name", { ascending: true }),
    leads.length > 0
      ? supabase
          .from("lead_evidence")
          .select(
            "lead_id, audited_at_local, audit_timezone, outcome, response_delay_seconds, notes, created_at",
          )
          .in(
            "lead_id",
            leads.map((l) => l.id),
          )
          .order("created_at", { ascending: false })
      : Promise.resolve({ data: [] }),
  ]);

  // Newest audit per lead: the rows come back newest first, so the first wins.
  const evidence = new Map<string, EvidenceForRender & { notes: string | null }>();
  for (const row of evidenceRows ?? []) {
    const key = row.lead_id as string;
    if (!evidence.has(key)) {
      evidence.set(key, row as unknown as EvidenceForRender & { notes: string | null });
    }
  }

  // The From name every {{sender_name}} would render to. One mailbox in
  // practice; if there are several, the preview uses the first, and the action
  // re-picks by capacity anyway.
  const senderName = write.mailboxes.find((m) => m.display_name)?.display_name ?? null;

  const drafts: Draft[] = [];

  for (const lead of leads) {
    if (drafts.length >= WORKLIST_LIMIT) break;

    const zone = lead.timezone as string;

    if (
      (lead.work_email_norm && write.suppressedEmails.has(lead.work_email_norm)) ||
      (lead.website_domain && write.suppressedDomains.has(lead.website_domain))
    ) {
      continue;
    }

    const sends = write.sendsByLead.get(lead.id) ?? [];
    const step = nextStepFor(sends);
    if (!step.ok) continue;

    const slot = bookSlot({
      now: write.now,
      zone,
      earliestDay: earliestDayFor(
        step.step,
        step.lastSentAt,
        zone,
        write.now,
        write.holidays,
      ),
      step: step.step,
      seed: `${lead.id}:${step.step}:${(step.replaces?.step_number ?? 0) + sends.length}`,
      settings: write.settings,
      mailboxes: write.mailboxes,
      capacity: write.capacity,
      holidays: write.holidays,
    });

    // Hold the seat, so the next lead's preview is the time it would really
    // get rather than the same one this lead just took.
    if (slot.ok) reserve(write.capacity, slot.mailbox.id, slot.capDate);

    const leadEvidence = evidence.get(lead.id) ?? null;

    drafts.push({
      leadId: lead.id,
      company: lead.company_name,
      contactName: [lead.first_name, lead.last_name].filter(Boolean).join(" ") || null,
      title: lead.title,
      workEmail: lead.work_email!,
      website: lead.website,
      phone: lead.phone,
      city: lead.city,
      state: lead.state,
      industry: lead.industry,
      rating: lead.rating,
      reviewsCount: lead.reviews_count,
      timezone: zone,
      status: lead.status,
      angleType: lead.angle_type,
      demoUrl: lead.demo_txt_url ?? lead.demo_web_url,
      step: step.step,
      // A step the planner had already booked from a template. Saying so is
      // what stops "why is there already an email queued for this one?".
      replacesSendId: step.replaces?.id ?? null,
      replacesWasWritten: step.replaces?.composed_body != null,
      existingSubject: step.replaces?.composed_subject ?? null,
      existingBody: step.replaces?.composed_body ?? null,
      slot: slot.ok
        ? {
            at: slot.at.toUTC().toISO()!,
            local: slot.scheduledLocal,
            mailbox: slot.mailbox.id,
            mailboxEmail:
              write.mailboxes.find((m) => m.id === slot.mailbox.id)?.email ?? "",
          }
        : null,
      slotProblem: slot.ok
        ? null
        : slot.reason === "no_mailbox"
          ? "No sendable mailbox is connected."
          : `Every mailbox is full for the next ${write.settings.max_lookahead_days} days.`,
      audit: leadEvidence
        ? {
            outcome: leadEvidence.outcome,
            notes: leadEvidence.notes,
            localTime: leadEvidence.audited_at_local,
            timezone: leadEvidence.audit_timezone,
            responseDelaySeconds: leadEvidence.response_delay_seconds,
          }
        : null,
      // Rendered in the browser rather than here: eight starter bodies per lead
      // times a hundred and fifty leads is most of a megabyte of duplicated
      // prose down the wire, and the values object is a dozen short strings.
      values: buildTemplateValues({
        lead: {
          first_name: lead.first_name,
          last_name: lead.last_name,
          company_name: lead.company_name,
          city: lead.city,
          state: lead.state,
          industry: lead.industry,
          demo_txt_url: lead.demo_txt_url,
          demo_web_url: lead.demo_web_url,
        },
        evidence: leadEvidence,
        senderName,
      }),
    });
  }

  const templates = ((templateRows ?? []) as StarterTemplate[]).filter(
    (t) => t.subject && t.body,
  );

  return (
    <WriteClient
      drafts={drafts}
      templates={templates}
      dryRun={write.settings.dry_run}
      mailboxCount={write.mailboxes.length}
      senderName={senderName}
      loadError={error?.message ?? null}
    />
  );
}
