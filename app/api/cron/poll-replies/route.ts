// Replies, bounces and unsubscribes.
//
// Polling rather than Pub/Sub, deliberately. Pub/Sub needs a public endpoint
// Google can reach, a topic, an IAM binding and a watch renewed every seven
// days; polling needs a cron entry. At two operators and forty sends a day the
// latency difference is minutes, and minutes do not change what anyone does.
// The historyId cursor means a poll costs one request when nothing has arrived.
//
// Everything here is READ-ONLY against Gmail. The app never had gmail.modify,
// so it cannot archive, label or mark anything read even by mistake, which is
// what keeps Instantly's warmup mail sitting untouched in the same inbox.
//
// The cursor only ever moves past what has been settled. For four weeks one
// mailbox's poll threw on every run and reported a row of zeros, the cron job
// said "succeeded", and nothing said the mailbox was not being read. Every way
// that happened is closed here:
//
//   - a message deleted before it could be read is skipped, not thrown on, so
//     it cannot wedge the cursor behind it forever;
//   - a reply whose event failed to record stops the run WITHOUT moving past
//     it, because the event is what halts the sequence;
//   - a run that runs out of time or pages stores how far it got, rather than
//     either nothing (the same backlog forever) or the mailbox's current
//     history id (silently skipping the rest);
//   - a failure is in the response body and, once it has lasted an hour, an
//     alert.
//
// Service role: no user session, and mailbox_secrets is unreadable without it.

import type { SupabaseClient } from "@supabase/supabase-js";

import { requireBearer } from "@/lib/cronAuth";
import { serverEnv } from "@/lib/env";
import { classifyInbound, eventTypeFor } from "@/lib/gmail/classify";
import {
  addressFromHeader,
  fetchMessage,
  GmailReadError,
  listHistory,
  referencedMessageIds,
  type GmailMessage,
  type HistoryRecord,
} from "@/lib/gmail/messages";
import { fetchProfile } from "@/lib/gmail/oauth";
import { getMailboxAccessToken, MailboxDisconnectedError } from "@/lib/gmail/token";
import { normalizeEmail } from "@/lib/normalize";
import { pushAlert } from "@/lib/notify/push";
import { createAdminSupabase } from "@/lib/supabase/admin";
import { selectAll } from "@/lib/supabase/paginate";

export const runtime = "nodejs";
export const maxDuration = 60;

/** Pages of history per mailbox per run. A backlog drains over several runs. */
const MAX_PAGES = 5;

/**
 * When a run stops starting new work, measured from its start. The function is
 * killed at 60 seconds, and a run killed before it stores the cursor re-reads
 * the same backlog next time and is killed at the same place, indefinitely.
 */
const RUN_BUDGET_MS = 40_000;

/** A mailbox with no complete poll for this long raises an alert. */
const FAILING_AFTER_MS = 60 * 60 * 1000;

/** How far back to look for the send an inbound message is answering. */
const THREAD_MEMORY_DAYS = 120;

interface Mailbox {
  id: string;
  org_id: string;
  email: string;
  last_history_id: string | null;
  last_polled_at: string | null;
}

interface PollReport {
  mailbox: string;
  examined: number;
  replies: number;
  bounces: number;
  unsubscribes: number;
  ignored: number;
  unmatched: number;
  /** Deleted from the mailbox before this run could read them. */
  vanished: number;
  rebaselined: boolean;
  /** Everything since the stored cursor was read and settled. */
  caught_up: boolean;
  /** Why the run stopped short of caught_up, when it did. */
  stopped?: string;
  /** What failed, verbatim. The line that was missing for four weeks. */
  error?: string;
}

function emptyReport(mailbox: string): PollReport {
  return {
    mailbox,
    examined: 0,
    replies: 0,
    bounces: 0,
    unsubscribes: 0,
    ignored: 0,
    unmatched: 0,
    vanished: 0,
    rebaselined: false,
    caught_up: false,
  };
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Returns whether the alert was new, which is the only time a phone buzzes. */
async function raiseAlert(
  supabase: SupabaseClient,
  alert: {
    org_id: string;
    kind: string;
    message: string;
    dedupe_token: string;
    lead_id?: string | null;
    mailbox_id?: string | null;
  },
): Promise<boolean> {
  const { data, error } = await supabase
    .from("alerts")
    .upsert(
      { ...alert, lead_id: alert.lead_id ?? null, mailbox_id: alert.mailbox_id ?? null },
      { onConflict: "org_id,kind,dedupe_token", ignoreDuplicates: true },
    )
    .select("id");

  if (error) {
    console.error(`poll-replies: raising a ${alert.kind} alert failed: ${error.message}`);
    return false;
  }
  // With ignoreDuplicates the select returns nothing on conflict, which is
  // exactly the signal needed: overlapping history pages and re-runs re-see the
  // same message, and a second notification for one reply teaches people to
  // ignore the first.
  return (data?.length ?? 0) > 0;
}

// ---------------------------------------------------------------------------

interface LeadIndex {
  byThread: Map<string, string>;
  byMessageId: Map<string, string>;
  byEmail: Map<string, string>;
}

/**
 * Everything needed to attribute an inbound message to a lead.
 *
 * Three keys, in falling order of confidence. The Gmail thread id is exact when
 * the prospect replies in place. The RFC 5322 Message-ID chain survives clients
 * that start a new thread. The sender address is the last resort and is the one
 * that catches a reply sent from a different mailbox at the same company.
 */
async function buildLeadIndex(
  supabase: SupabaseClient,
  orgId: string,
): Promise<LeadIndex> {
  const since = new Date(
    Date.now() - THREAD_MEMORY_DAYS * 24 * 60 * 60 * 1000,
  ).toISOString();

  // In pages, and a failed read throws. A lead missing from this index cannot
  // be matched, so its reply is filed as ordinary mail and the cursor moves
  // past it for good. PostgREST's 1000-row cap would have done exactly that,
  // silently, once enough had been sent.
  const { data: sends, error: sendError } = await selectAll<{
    id: string;
    lead_id: string;
    provider_thread_id: string | null;
    rfc822_message_id: string | null;
  }>(() =>
    supabase
      .from("scheduled_sends")
      .select("id, lead_id, provider_thread_id, rfc822_message_id")
      .eq("org_id", orgId)
      .eq("status", "sent")
      .gte("sent_at", since),
  );
  if (sendError) {
    throw new Error(`reading sent emails for reply matching failed: ${sendError.message}`);
  }

  const byThread = new Map<string, string>();
  const byMessageId = new Map<string, string>();

  for (const send of sends) {
    const leadId = send.lead_id as string;
    if (send.provider_thread_id) {
      byThread.set(send.provider_thread_id as string, leadId);
    }
    if (send.rfc822_message_id) {
      byMessageId.set(send.rfc822_message_id as string, leadId);
    }
  }

  const leadIds = [...new Set([...byThread.values(), ...byMessageId.values()])];
  const byEmail = new Map<string, string>();

  // Chunked: PostgREST puts `in` values in the URL, and a few hundred uuids is
  // already a long one.
  for (let i = 0; i < leadIds.length; i += 200) {
    const { data: leads, error: leadError } = await supabase
      .from("leads")
      .select("id, work_email_norm")
      .in("id", leadIds.slice(i, i + 200));
    if (leadError) {
      throw new Error(`reading lead addresses for reply matching failed: ${leadError.message}`);
    }
    for (const lead of leads ?? []) {
      if (lead.work_email_norm) {
        byEmail.set(lead.work_email_norm as string, lead.id as string);
      }
    }
  }

  return { byThread, byMessageId, byEmail };
}

function matchLead(
  index: LeadIndex,
  message: {
    threadId: string;
    headers: Record<string, string>;
  },
): string | null {
  const referenced = referencedMessageIds(message.headers);
  for (const id of referenced) {
    const leadId = index.byMessageId.get(id);
    if (leadId) return leadId;
  }

  const byThread = index.byThread.get(message.threadId);
  if (byThread) return byThread;

  // A bounce names the address that failed rather than being from it.
  const failed = addressFromHeader(message.headers["x-failed-recipients"]);
  const sender = addressFromHeader(message.headers["from"]);
  for (const candidate of [failed, sender]) {
    const norm = normalizeEmail(candidate ?? null);
    if (norm) {
      const leadId = index.byEmail.get(norm);
      if (leadId) return leadId;
    }
  }

  return null;
}

// ---------------------------------------------------------------------------

type Settled = { ok: true } | { ok: false; error: string };

/**
 * One message, from Gmail to the event log. `ok` means the cursor may move
 * past it: either it is recorded, or there was nothing of ours to record.
 */
async function settleMessage(
  supabase: SupabaseClient,
  mailbox: Mailbox,
  index: LeadIndex,
  accessToken: string,
  messageId: string,
  report: PollReport,
): Promise<Settled> {
  let message: GmailMessage;
  try {
    message = await fetchMessage(accessToken, messageId);
  } catch (error) {
    // Deleted for good between arriving and this run. There is nothing left to
    // classify, and throwing here is what wedged a mailbox: every later run
    // met the same 404 and the cursor never moved past it.
    if (error instanceof GmailReadError && error.status === 404) {
      report.vanished += 1;
      return { ok: true };
    }
    return { ok: false, error: `reading message ${messageId}: ${errorText(error)}` };
  }

  report.examined += 1;
  const classification = classifyInbound(message);

  if (classification.kind === "ignore") {
    report.ignored += 1;
    return { ok: true };
  }

  const leadId = matchLead(index, message);
  if (!leadId) {
    // Ordinary mailbox traffic, or warmup. Not ours to interpret.
    report.unmatched += 1;
    return { ok: true };
  }

  const type = eventTypeFor(classification.kind);
  if (!type) return { ok: true };

  const from = message.headers["from"] ?? null;

  // The Gmail message id as dedupe_token, against the unique
  // (lead_id, type, dedupe_token) on lead_events. A redelivered notification,
  // an overlapping history page or a re-run after a crash all insert nothing
  // the second time. Inserting the event is also what recomputes the lead's
  // status and halts the rest of the sequence; nothing here writes
  // leads.status.
  const { error: eventError } = await supabase.from("lead_events").upsert(
    {
      org_id: mailbox.org_id,
      lead_id: leadId,
      type,
      actor_id: null,
      payload: {
        mailbox_id: mailbox.id,
        gmail_message_id: message.id,
        gmail_thread_id: message.threadId,
        from,
        subject: message.headers["subject"] ?? null,
        snippet: message.snippet.slice(0, 500),
        classification: classification.reason,
        hard: classification.hard,
      },
      dedupe_token: message.id,
    },
    { onConflict: "lead_id,type,dedupe_token", ignoreDuplicates: true },
  );

  if (eventError) {
    // This event is what halts the sequence. Moving the cursor past a reply
    // that was not recorded loses it for good, and the next touch goes to
    // somebody who answered. So the run stops here and the next one retries,
    // and the alert is so a person knows it is holding.
    await raiseAlert(supabase, {
      org_id: mailbox.org_id,
      kind: "pre_send_review",
      lead_id: leadId,
      mailbox_id: mailbox.id,
      message: `A ${classification.kind} from ${from ?? "this lead"} could not be recorded (${eventError.message}). Reading ${mailbox.email} is held at it and retried every run.`,
      dedupe_token: `unrecorded-inbound:${message.id}`,
    });
    return {
      ok: false,
      error: `recording ${classification.kind} ${message.id}: ${eventError.message}`,
    };
  }

  if (classification.kind === "reply") report.replies += 1;
  if (classification.kind === "bounce") report.bounces += 1;
  if (classification.kind === "unsubscribe") report.unsubscribes += 1;

  // A hard bounce or an explicit unsubscribe earns a do-not-contact entry. A
  // SOFT bounce does not: a full mailbox on one afternoon must not take a
  // prospect off the list permanently.
  if (classification.hard) {
    const { data: lead } = await supabase
      .from("leads")
      .select("work_email_norm")
      .eq("id", leadId)
      .maybeSingle();

    if (lead?.work_email_norm) {
      // The suppressions columns are plain text, not generated, so the value
      // has to arrive already normalized or it will never match the lead it
      // was meant to stop. work_email_norm IS the generated column, so it is
      // normalized by definition.
      const { error } = await supabase.from("suppressions").insert({
        org_id: mailbox.org_id,
        email_norm: lead.work_email_norm,
        reason:
          classification.kind === "unsubscribe" ? "unsubscribed" : "bounced_hard",
        lead_id: leadId,
        notes: classification.reason,
      });
      // 23505 is the partial unique index: already suppressed, which is the
      // desired state. Anything else is worth knowing about but must not stop
      // the rest of the run: the event above already halted the sequence, and
      // the dispatcher reads the lead's halt before it reads suppressions.
      if (error && error.code !== "23505") {
        console.error(`suppression insert failed for ${leadId}: ${error.message}`);
      }
    }
  }

  const kind =
    classification.kind === "reply"
      ? "reply"
      : classification.kind === "bounce"
        ? "bounce"
        : "unsubscribe";

  const isNew = await raiseAlert(supabase, {
    org_id: mailbox.org_id,
    lead_id: leadId,
    mailbox_id: mailbox.id,
    kind,
    message: `${from ?? "someone"}: ${message.snippet.slice(0, 160)}`,
    dedupe_token: message.id,
  });

  if (isNew) {
    const site = serverEnv().siteUrl;
    await pushAlert({
      title:
        kind === "reply"
          ? `Reply from ${from ?? "a prospect"}`
          : `${kind} on ${mailbox.email}`,
      body: message.snippet.slice(0, 300) || "(no preview)",
      url: site ? `${site}/leads?lead=${leadId}` : null,
    });
  }

  return { ok: true };
}

// ---------------------------------------------------------------------------

async function pollMailbox(
  supabase: SupabaseClient,
  mailbox: Mailbox,
  index: LeadIndex,
  deadline: number,
): Promise<PollReport> {
  const report = emptyReport(mailbox.email);

  const { accessToken } = await getMailboxAccessToken(supabase, mailbox);

  // No cursor yet, or one Gmail has aged out. Either way the move is to
  // baseline from the profile and start reporting from now: inventing a
  // starting point would either miss messages silently or re-scan the entire
  // mailbox, and the mailbox is full of warmup mail. When the cursor aged out,
  // though, whatever arrived in between was never read, and somebody has to be
  // told: the one-off script reads it back.
  async function rebaseline(reason: string, lostSince: string | null) {
    const profile = await fetchProfile(accessToken);
    const { error } = await supabase
      .from("mailboxes")
      .update({
        last_history_id: profile.historyId || null,
        last_polled_at: new Date().toISOString(),
      })
      .eq("id", mailbox.id);
    if (error) throw new Error(`storing the rebaselined cursor failed: ${error.message}`);

    await supabase.from("mailbox_events").insert({
      org_id: mailbox.org_id,
      mailbox_id: mailbox.id,
      kind: "auth_error",
      detail: `history cursor rebaselined: ${reason}`,
    });

    if (lostSince !== null) {
      const message = `Nothing that reached ${mailbox.email} between ${lostSince} and now was read for replies: Gmail no longer keeps history that far back. Run scripts/reconcile-mailbox-history.mjs to recover replies, bounces and unsubscribes from that gap.`;
      if (
        await raiseAlert(supabase, {
          org_id: mailbox.org_id,
          kind: "mailbox_auth",
          mailbox_id: mailbox.id,
          message,
          dedupe_token: `history-gap:${mailbox.id}:${mailbox.last_history_id}`,
        })
      ) {
        await pushAlert({ title: `Replies to ${mailbox.email} may have been missed`, body: message });
      }
    }

    report.rebaselined = true;
    report.caught_up = true;
  }

  if (!mailbox.last_history_id) {
    await rebaseline("no cursor stored", null);
    return report;
  }

  // --- read the history ------------------------------------------------------
  const records: HistoryRecord[] = [];
  /** The mailbox's current history id, known only once the LAST page is read. */
  let endOfHistory: string | null = null;
  let pageToken: string | null = null;

  try {
    for (let page = 0; page < MAX_PAGES; page++) {
      const result = await listHistory({
        accessToken,
        startHistoryId: mailbox.last_history_id,
        pageToken,
      });
      records.push(...result.records);
      pageToken = result.nextPageToken;
      if (!pageToken) {
        endOfHistory = result.historyId;
        break;
      }
    }
  } catch (error) {
    if (error instanceof GmailReadError && error.historyExpired) {
      await rebaseline(
        "Gmail no longer has history from that point",
        mailbox.last_polled_at ?? "the last poll",
      );
      return report;
    }
    throw error;
  }

  // --- settle it, record by record --------------------------------------------
  // The cursor moves past a record only once every message in it is settled,
  // and is stored below whatever happened, so progress made before a failure
  // or the time budget is kept and the next run starts after it.
  let cursor = mailbox.last_history_id;
  const settled = new Set<string>();

  history: for (const record of records) {
    for (const messageId of record.messageIds) {
      if (settled.has(messageId)) continue;

      if (Date.now() > deadline) {
        report.stopped = "out of time; the next run continues from here";
        break history;
      }

      const outcome = await settleMessage(
        supabase,
        mailbox,
        index,
        accessToken,
        messageId,
        report,
      );
      if (!outcome.ok) {
        report.stopped = "a message could not be settled; the next run retries it";
        report.error = outcome.error;
        break history;
      }
      settled.add(messageId);
    }
    cursor = record.id;
  }

  if (!report.stopped) {
    if (endOfHistory) {
      // Read to the end with nothing left over: jump to the mailbox's current
      // id, past trailing records that added nothing we look at.
      cursor = endOfHistory;
      report.caught_up = true;
    } else {
      report.stopped = `more than ${MAX_PAGES} pages of history; the next run continues from here`;
    }
  }

  const { error: cursorError } = await supabase
    .from("mailboxes")
    .update({
      last_history_id: cursor,
      // Only a run that met no error counts as a poll. A mailbox failing on
      // every run has to look stale, not freshly polled.
      ...(report.error ? {} : { last_polled_at: new Date().toISOString() }),
    })
    .eq("id", mailbox.id);

  if (cursorError) {
    report.error ??= `storing the cursor failed: ${cursorError.message}`;
  }

  return report;
}

/**
 * One failed run is weather: a Google 503, a slow token endpoint. An hour of
 * them is a mailbox nobody is reading, and that has to reach a person, once a
 * day, not every ten minutes.
 */
async function alertIfFailing(
  supabase: SupabaseClient,
  mailbox: Mailbox,
  error: string,
): Promise<void> {
  const lastPolled = mailbox.last_polled_at ? Date.parse(mailbox.last_polled_at) : 0;
  if (Date.now() - lastPolled < FAILING_AFTER_MS) return;

  const since = mailbox.last_polled_at ?? "it was connected";
  const message = `Replies to ${mailbox.email} are not being read. The last complete poll was ${since}, and every run since fails with: ${error}`;

  const isNew = await raiseAlert(supabase, {
    org_id: mailbox.org_id,
    kind: "mailbox_auth",
    mailbox_id: mailbox.id,
    message,
    dedupe_token: `poll-failing:${mailbox.id}:${new Date().toISOString().slice(0, 10)}`,
  });

  if (isNew) {
    await pushAlert({ title: `Replies to ${mailbox.email} are not being read`, body: message });
  }
}

// ---------------------------------------------------------------------------

export async function POST(request: Request) {
  const denied = requireBearer(request, serverEnv().cronSecret);
  if (denied) return denied;

  const deadline = Date.now() + RUN_BUDGET_MS;
  const supabase = createAdminSupabase();

  // Paused mailboxes are polled too. Pausing stops SENDING; a reply to
  // something already sent still has to halt the sequence.
  let query = supabase
    .from("mailboxes")
    .select("id, org_id, email, last_history_id, last_polled_at")
    .is("disconnected_at", null)
    // Least recently polled first, so a mailbox working through a backlog
    // cannot spend every run's budget and starve the other one.
    .order("last_polled_at", { ascending: true, nullsFirst: true });

  // Optional scope, same reasoning as the other jobs: a test must never read
  // or write for an org it did not create.
  const onlyOrg = new URL(request.url).searchParams.get("org");
  if (onlyOrg) query = query.eq("org_id", onlyOrg);

  const { data: mailboxRows, error } = await query;
  if (error) return Response.json({ error: error.message }, { status: 500 });

  const mailboxes = (mailboxRows ?? []) as Mailbox[];
  const indexes = new Map<string, LeadIndex>();
  const reports: PollReport[] = [];

  for (const mailbox of mailboxes) {
    if (Date.now() > deadline) {
      reports.push({ ...emptyReport(mailbox.email), stopped: "no time left in this run" });
      continue;
    }

    let report: PollReport;
    try {
      let index = indexes.get(mailbox.org_id);
      if (!index) {
        index = await buildLeadIndex(supabase, mailbox.org_id);
        indexes.set(mailbox.org_id, index);
      }
      report = await pollMailbox(supabase, mailbox, index, deadline);
    } catch (caught) {
      report = { ...emptyReport(mailbox.email), error: errorText(caught) };
      // A dead grant has already disconnected the mailbox and raised its own
      // alert inside getMailboxAccessToken(); the next run will not poll it.
      if (caught instanceof MailboxDisconnectedError) {
        reports.push(report);
        continue;
      }
    }

    if (report.error) {
      console.error(`poll-replies: ${mailbox.email}: ${report.error}`);
      await alertIfFailing(supabase, mailbox, report.error);
    }
    reports.push(report);
  }

  return Response.json({ mailboxes: reports.length, reports });
}
