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
} from "@/lib/gmail/messages";
import { fetchProfile } from "@/lib/gmail/oauth";
import { getMailboxAccessToken, MailboxDisconnectedError } from "@/lib/gmail/token";
import { normalizeEmail } from "@/lib/normalize";
import { createAdminSupabase } from "@/lib/supabase/admin";

export const runtime = "nodejs";
export const maxDuration = 60;

/** Pages of history per mailbox per run. A backlog drains over several runs. */
const MAX_PAGES = 5;

/** How far back to look for the send an inbound message is answering. */
const THREAD_MEMORY_DAYS = 120;

interface Mailbox {
  id: string;
  org_id: string;
  email: string;
  last_history_id: string | null;
}

interface PollReport {
  mailbox: string;
  examined: number;
  replies: number;
  bounces: number;
  unsubscribes: number;
  ignored: number;
  unmatched: number;
  rebaselined: boolean;
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

  const { data: sends } = await supabase
    .from("scheduled_sends")
    .select("lead_id, provider_thread_id, rfc822_message_id")
    .eq("org_id", orgId)
    .eq("status", "sent")
    .gte("sent_at", since);

  const byThread = new Map<string, string>();
  const byMessageId = new Map<string, string>();

  for (const send of sends ?? []) {
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
    const { data: leads } = await supabase
      .from("leads")
      .select("id, work_email_norm")
      .in("id", leadIds.slice(i, i + 200));
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

async function pollMailbox(
  supabase: SupabaseClient,
  mailbox: Mailbox,
  index: LeadIndex,
): Promise<PollReport> {
  const report: PollReport = {
    mailbox: mailbox.email,
    examined: 0,
    replies: 0,
    bounces: 0,
    unsubscribes: 0,
    ignored: 0,
    unmatched: 0,
    rebaselined: false,
  };

  const { accessToken } = await getMailboxAccessToken(supabase, mailbox);

  // No cursor yet, or one Gmail has aged out. Either way the honest move is to
  // baseline from the profile and start reporting from now: inventing a
  // starting point would either miss messages silently or re-scan the entire
  // mailbox, and the mailbox is full of warmup mail.
  async function rebaseline(reason: string) {
    const profile = await fetchProfile(accessToken);
    await supabase
      .from("mailboxes")
      .update({
        last_history_id: profile.historyId || null,
        last_polled_at: new Date().toISOString(),
      })
      .eq("id", mailbox.id);
    await supabase.from("mailbox_events").insert({
      org_id: mailbox.org_id,
      mailbox_id: mailbox.id,
      kind: "auth_error",
      detail: `history cursor rebaselined: ${reason}`,
    });
    report.rebaselined = true;
  }

  if (!mailbox.last_history_id) {
    await rebaseline("no cursor stored");
    return report;
  }

  let cursor = mailbox.last_history_id;
  let pageToken: string | null = null;
  const messageIds: string[] = [];

  try {
    for (let page = 0; page < MAX_PAGES; page++) {
      const result = await listHistory({
        accessToken,
        startHistoryId: mailbox.last_history_id,
        pageToken,
      });
      messageIds.push(...result.messageIds);
      cursor = result.historyId;
      pageToken = result.nextPageToken;
      if (!pageToken) break;
    }
  } catch (error) {
    if (error instanceof GmailReadError && error.historyExpired) {
      await rebaseline("Gmail no longer has history from that point");
      return report;
    }
    throw error;
  }

  for (const messageId of [...new Set(messageIds)]) {
    report.examined += 1;

    const message = await fetchMessage(accessToken, messageId);
    const classification = classifyInbound(message);

    if (classification.kind === "ignore") {
      report.ignored += 1;
      continue;
    }

    const leadId = matchLead(index, message);
    if (!leadId) {
      // Ordinary mailbox traffic, or warmup. Not ours to interpret.
      report.unmatched += 1;
      continue;
    }

    const type = eventTypeFor(classification.kind);
    if (!type) continue;

    // The Gmail message id as dedupe_token, against the unique
    // (lead_id, type, dedupe_token) on lead_events. A redelivered notification,
    // an overlapping history page or a re-run after a crash all insert nothing
    // the second time. Inserting the event is also what recomputes the lead's
    // status and halts the rest of the sequence; nothing here writes
    // leads.status.
    await supabase.from("lead_events").upsert(
      {
        org_id: mailbox.org_id,
        lead_id: leadId,
        type,
        actor_id: null,
        payload: {
          mailbox_id: mailbox.id,
          gmail_message_id: message.id,
          gmail_thread_id: message.threadId,
          from: message.headers["from"] ?? null,
          subject: message.headers["subject"] ?? null,
          snippet: message.snippet.slice(0, 500),
          classification: classification.reason,
          hard: classification.hard,
        },
        dedupe_token: message.id,
      },
      { onConflict: "lead_id,type,dedupe_token", ignoreDuplicates: true },
    );

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
        // the rest of the run.
        if (error && error.code !== "23505") {
          console.error(`suppression insert failed for ${leadId}: ${error.message}`);
        }
      }
    }

    await supabase.from("alerts").upsert(
      {
        org_id: mailbox.org_id,
        lead_id: leadId,
        mailbox_id: mailbox.id,
        kind:
          classification.kind === "reply"
            ? "reply"
            : classification.kind === "bounce"
              ? "bounce"
              : "unsubscribe",
        message: `${message.headers["from"] ?? "someone"}: ${message.snippet.slice(0, 160)}`,
        dedupe_token: message.id,
      },
      { onConflict: "org_id,kind,dedupe_token", ignoreDuplicates: true },
    );
  }

  await supabase
    .from("mailboxes")
    .update({ last_history_id: cursor, last_polled_at: new Date().toISOString() })
    .eq("id", mailbox.id);

  return report;
}

// ---------------------------------------------------------------------------

export async function POST(request: Request) {
  const denied = requireBearer(request, serverEnv().cronSecret);
  if (denied) return denied;

  const supabase = createAdminSupabase();

  // Paused mailboxes are polled too. Pausing stops SENDING; a reply to
  // something already sent still has to halt the sequence.
  const { data: mailboxRows, error } = await supabase
    .from("mailboxes")
    .select("id, org_id, email, last_history_id")
    .is("disconnected_at", null);

  if (error) return Response.json({ error: error.message }, { status: 500 });

  const mailboxes = (mailboxRows ?? []) as Mailbox[];
  const indexes = new Map<string, LeadIndex>();
  const reports: PollReport[] = [];

  for (const mailbox of mailboxes) {
    let index = indexes.get(mailbox.org_id);
    if (!index) {
      index = await buildLeadIndex(supabase, mailbox.org_id);
      indexes.set(mailbox.org_id, index);
    }

    try {
      reports.push(await pollMailbox(supabase, mailbox, index));
    } catch (error) {
      // One dead mailbox must not stop the others from being polled.
      if (!(error instanceof MailboxDisconnectedError)) {
        console.error(`poll failed for ${mailbox.email}:`, error);
      }
      reports.push({
        mailbox: mailbox.email,
        examined: 0,
        replies: 0,
        bounces: 0,
        unsubscribes: 0,
        ignored: 0,
        unmatched: 0,
        rebaselined: false,
      });
    }
  }

  return Response.json({ mailboxes: reports.length, reports });
}
