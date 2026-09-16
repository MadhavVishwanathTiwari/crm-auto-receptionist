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

import { DateTime } from "luxon";

import { accountsOf, type OperatorGroup } from "@/lib/dashboard/operators";
import { requireOrgContext, type OrgContext } from "@/lib/org";
import { bookSlot, reserve } from "@/lib/scheduler/book";
import { mailboxesForSend, pinnedMailboxIdFor } from "@/lib/scheduler/routing";
import { selectAll } from "@/lib/supabase/paginate";
import { buildTemplateValues, type EvidenceForRender } from "@/lib/templates/render";
import {
  earliestDayFor,
  loadWriteContext,
  nextStepFor,
  routingBlockMessage,
  replySubjectFor,
} from "@/lib/write/context";

import { PAGE, PAGE_HEADER, PANEL } from "../ui";
import {
  WriteClient,
  type Draft,
  type StarterTemplate,
  type WriteNotice,
} from "./WriteClient";

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
  /** Mine, but possibly as my other account. The routing owner. */
  claimed_by: string | null;
}

export default async function WritePage({
  searchParams,
}: {
  searchParams: Promise<{ lead?: string }>;
}) {
  const { supabase, userId } = await requireOrgContext();
  // A deep link from the lead drawer: open on that lead, or say why it is not
  // here. Silently opening a different one read as the app losing it.
  const { lead: requestedLeadId = null } = await searchParams;

  // The roster rides along with the schedule read rather than after it, so
  // resolving "which accounts are me" costs no extra round trip.
  const [write, { data: operatorRows, error: operatorError }] = await Promise.all([
    loadWriteContext(supabase),
    supabase.rpc("org_operators"),
  ]);
  const myAccounts = accountsOf(userId, (operatorRows ?? []) as OperatorGroup[]);

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
  //
  // Me is every account of mine, not the one I signed in with. madhav claimed
  // the sheet's leads as madhav@tryautoreceptionist.com and signs in as
  // madhav@autoreceptionist.io, and `claimed_by = userId` hid all 30 of them
  // from the only screen that writes to them (0048).
  //
  // Every one of them, not the oldest few hundred. A lead whose sequence has
  // finished stays claimed and live, and those are the oldest, so the
  // .limit(300) this used to have filled up with them over time and the newest
  // claims dropped off the worklist without a word.
  const { data: leadRows, error } = await selectAll<LeadRow>(() =>
    supabase
      .from("leads")
      // One string literal on purpose; see the note in leads/page.tsx.
      .select(
        "id, company_name, first_name, last_name, title, work_email, work_email_norm, website, website_domain, phone, city, state, industry, rating, reviews_count, timezone, status, angle_type, demo_txt_url, demo_web_url, created_at, claimed_by",
      )
      .in("claimed_by", myAccounts)
      .eq("is_qualified", true)
      .is("archived_at", null)
      .is("halted_at", null)
      .is("terminal_outcome", null)
      .not("timezone", "is", null)
      .not("work_email", "is", null),
  );

  // Oldest claim first, as before. Sorted here because selectAll pages by id.
  const leads = [...leadRows].sort((a, b) => a.created_at.localeCompare(b.created_at));

  // Which of them the worklist offers, decided before the evidence read so that
  // read names at most WORKLIST_LIMIT leads: PostgREST puts `in` values in the
  // URL.
  const worklist: {
    lead: LeadRow;
    sends: Parameters<typeof nextStepFor>[0];
    step: Extract<ReturnType<typeof nextStepFor>, { ok: true }>;
  }[] = [];

  // A lead asked for by ?lead= goes first, so the worklist limit is never the
  // reason it is missing.
  const requested = requestedLeadId
    ? leads.find((lead) => lead.id === requestedLeadId)
    : undefined;
  const ordered = requested
    ? [requested, ...leads.filter((lead) => lead !== requested)]
    : leads;
  // Why the loop passed the requested lead over, if it did, in its own terms.
  let requestedSkip: SkipReason | null = null;

  for (const lead of ordered) {
    if (worklist.length >= WORKLIST_LIMIT) break;

    if (
      (lead.work_email_norm && write.suppressedEmails.has(lead.work_email_norm)) ||
      (lead.website_domain && write.suppressedDomains.has(lead.website_domain))
    ) {
      if (lead === requested) requestedSkip = "suppressed";
      continue;
    }

    const sends = write.sendsByLead.get(lead.id) ?? [];
    const step = nextStepFor(sends, write.unresolvedLeadIds.has(lead.id));
    if (!step.ok) {
      if (lead === requested) requestedSkip = step.reason;
      continue;
    }

    worklist.push({ lead, sends, step });
  }

  const notice =
    requestedLeadId && !worklist.some((item) => item.lead.id === requestedLeadId)
      ? await whyNotOnTheList(
          supabase,
          requestedLeadId,
          requested ?? null,
          requestedSkip,
          myAccounts,
        )
      : null;

  // Leads on the worklist with no demo, whose refusals are worth a line: a
  // writer about to send T2 should know there is no link to offer, and why.
  const demoless = worklist
    .filter((item) => !item.lead.demo_txt_url && !item.lead.demo_web_url)
    .map((item) => item.lead.id);

  const [{ data: templateRows }, { data: evidenceRows }, { data: demoFailureRows }] = await Promise.all([
    supabase
      .from("templates")
      .select("id, name, step_number, angle_type, subject, body, requires_demo, is_active")
      .order("step_number", { ascending: true })
      .order("name", { ascending: true }),
    worklist.length > 0
      ? supabase
          .from("lead_evidence")
          .select(
            "lead_id, audited_at_local, audit_timezone, outcome, response_delay_seconds, notes, created_at",
          )
          .in(
            "lead_id",
            worklist.map((item) => item.lead.id),
          )
          .order("created_at", { ascending: false })
      : Promise.resolve({ data: [] }),
    // Only the fields the line shows. The builder posts one per lead per night
    // at most, so newest-first over a short worklist is a handful of rows.
    demoless.length > 0
      ? supabase
          .from("lead_events")
          .select("lead_id, payload, occurred_at")
          .eq("type", "demo_failed")
          .in("lead_id", demoless)
          .order("occurred_at", { ascending: false })
      : Promise.resolve({ data: [] }),
  ]);

  // Newest refusal per lead, same first-wins rule as the evidence below.
  const demoFailures = new Map<string, { reason: string; at: string }>();
  for (const row of demoFailureRows ?? []) {
    const key = row.lead_id as string;
    if (demoFailures.has(key)) continue;
    const payload = (row.payload ?? {}) as { reason?: unknown };
    demoFailures.set(key, {
      reason: String(payload.reason ?? "no reason given"),
      at: row.occurred_at as string,
    });
  }

  // Newest audit per lead: the rows come back newest first, so the first wins.
  const evidence = new Map<string, EvidenceForRender & { notes: string | null }>();
  for (const row of evidenceRows ?? []) {
    const key = row.lead_id as string;
    if (!evidence.has(key)) {
      evidence.set(key, row as unknown as EvidenceForRender & { notes: string | null });
    }
  }

  // YOUR mailboxes, and nobody else's. This used to be "the first mailbox that
  // has a display name", which on Ojas's screen rendered every {{sender_name}}
  // as "Madhav" -- he would have signed somebody else's name on his own email.
  const myMailboxes = mailboxesForSend(write.mailboxes, {
    ownerId: userId,
    pinnedMailboxId: null,
    senders: write.senders,
  });

  // The From name every {{sender_name}} renders to. One mailbox per operator in
  // practice; with several the preview uses the first and the action re-picks by
  // capacity, which cannot change whose name it is.
  const senderName = myMailboxes.ok
    ? (myMailboxes.mailboxes.find((m) => m.display_name)?.display_name ?? null)
    : null;

  const drafts: Draft[] = [];

  for (const { lead, sends, step } of worklist) {
    const zone = lead.timezone as string;

    // Same call the action makes, with the same owner -- the lead's claimed_by,
    // which may be the operator's other account -- so the address shown in the
    // footer is the one the send actually leaves from.
    const routed = mailboxesForSend(write.mailboxes, {
      ownerId: lead.claimed_by,
      pinnedMailboxId: pinnedMailboxIdFor(sends),
      senders: write.senders,
    });

    // A written email already booked keeps its slot, because revising never
    // re-times it. So the worklist shows that slot and reserves nothing: the
    // booked row is already in the capacity index. Booking a fresh preview for
    // it showed every queued lead at a time it was not leaving at, and held a
    // second seat that pushed every later lead's preview back.
    const kept =
      step.replaces?.status === "planned" && step.replaces.composed_body != null
        ? step.replaces
        : null;

    const slot =
      routed.ok && !kept
        ? bookSlot({
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
            mailboxes: routed.mailboxes,
            capacity: write.capacity,
            holidays: write.holidays,
          })
        : null;

    // Hold the seat, so the next lead's preview is the time it would really
    // get rather than the same one this lead just took.
    if (slot?.ok) reserve(write.capacity, slot.mailbox.id, slot.capDate, slot.at);

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
      demoFailure: demoFailures.get(lead.id) ?? null,
      step: step.step,
      // A step the planner had already booked from a template. Saying so is
      // what stops "why is there already an email queued for this one?".
      replacesSendId: step.replaces?.id ?? null,
      replacesWasWritten: step.replaces?.composed_body != null,
      existingSubject: step.replaces?.composed_subject ?? null,
      existingBody: step.replaces?.composed_body ?? null,
      replySubject: replySubjectFor(sends),
      slot: kept
        ? {
            at: kept.scheduled_at,
            local: DateTime.fromISO(kept.scheduled_at, { zone }).toFormat(
              "yyyy-MM-dd'T'HH:mm:ss",
            ),
            mailbox: kept.mailbox_id ?? "",
            mailboxEmail:
              write.mailboxes.find((m) => m.id === kept.mailbox_id)?.email ?? "",
            pinned: routed.ok && routed.reason === "pinned",
          }
        : slot?.ok && routed.ok
          ? {
              at: slot.at.toUTC().toISO()!,
              local: slot.scheduledLocal,
              mailbox: slot.mailbox.id,
              mailboxEmail:
                write.mailboxes.find((m) => m.id === slot.mailbox.id)?.email ?? "",
              // Saying so is what makes a colleague's address in the From line
              // read as deliberate rather than as the bug it used to be.
              pinned: routed.reason === "pinned",
            }
          : null,
      slotProblem: !routed.ok
        ? routingBlockMessage(routed.blocked, null)
        : kept || slot?.ok
          ? null
          : slot?.reason === "no_mailbox"
            ? "No sendable mailbox is connected."
            : routed.reason === "pinned"
              ? `${routed.pinnedTo?.email ?? "That mailbox"} is at its cap for the next ${write.settings.max_lookahead_days} days, and this thread has to stay on it.`
              : `Your mailbox is full for the next ${write.settings.max_lookahead_days} days.`,
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
      // Yours, not the org's. An org with a mailbox you cannot send from is
      // the state this whole change exists to stop being invisible.
      mailboxCount={myMailboxes.ok ? myMailboxes.mailboxes.length : 0}
      myMailboxEmail={
        myMailboxes.ok ? (myMailboxes.mailboxes[0]?.email ?? null) : null
      }
      senderName={senderName}
      initialLeadId={requestedLeadId}
      notice={notice}
      // A roster that failed to load narrows the list to this account's own
      // claims. That hides leads rather than mis-sending any, but say so.
      loadError={error?.message ?? operatorError?.message ?? null}
    />
  );
}

/** The loop's reasons for passing over a lead that is otherwise yours. */
type SkipReason = "suppressed" | "in_flight" | "outcome_unknown" | "sequence_finished";

const SKIP_MESSAGE: Record<SkipReason, string> = {
  suppressed: "is on the do-not-contact list, so nothing more goes to it.",
  in_flight:
    "has an email on its way out right now. It comes back here once that one has landed.",
  outcome_unknown:
    "has an earlier email that may have gone out without being recorded. Say whether it did on the lead before writing another.",
  sequence_finished: "has had all four emails.",
};

/**
 * Why a lead asked for by ?lead= is not on this operator's list, in words.
 *
 * `listed` is the lead when it passed the page's own query and the loop then
 * skipped it; otherwise it is read once more to find which condition failed.
 * Only ever reached from a deep link, so the extra read is not on the path of
 * an ordinary visit.
 */
async function whyNotOnTheList(
  supabase: OrgContext["supabase"],
  leadId: string,
  listed: LeadRow | null,
  skip: SkipReason | null,
  mine: string[],
): Promise<WriteNotice> {
  if (listed) {
    const name = listed.company_name ?? "That lead";
    return {
      leadId,
      message: `${name} ${skip ? SKIP_MESSAGE[skip] : "is not on your list."}`,
    };
  }

  const { data } = await supabase
    .from("leads")
    .select(
      "company_name, claimed_by, is_qualified, archived_at, halted_at, terminal_outcome, timezone, work_email",
    )
    .eq("id", leadId)
    .maybeSingle();

  if (!data) return { leadId, message: "That lead is not available." };

  const name = (data.company_name as string | null) ?? "That lead";
  const why = data.archived_at
    ? "is archived."
    : data.terminal_outcome
      ? "is closed."
      : data.halted_at
        ? "stopped after a reply, a bounce or an unsubscribe, so nothing more is sent to it."
        : !data.claimed_by
          ? "is not claimed by anyone. Claim it on the Leads screen to write to it."
          : !mine.includes(data.claimed_by as string)
            ? "belongs to the other operator."
            : !data.work_email
              ? "has no work email, which is the only address the app sends to."
              : !data.is_qualified
                ? "is not qualified."
                : !data.timezone
                  ? "has no timezone, so it can never be scheduled. Set one on the lead."
                  : "is not on your list.";

  return { leadId, message: `${name} ${why}` };
}
