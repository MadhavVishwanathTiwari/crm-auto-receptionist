// The assistant that answers when nobody else has.
//
// Five minutes after a prospect's reply lands, if neither operator has written
// back, this reads the thread, decides whether there is anything worth saying,
// and says it. The five minutes is measured from when Gmail received the mail,
// not from when poll-replies got round to recording it -- those are the same on
// a quiet afternoon and hours apart after a backlog, and gating on the wrong
// one makes a whole day's replies eligible in a single tick.
//
// It cannot answer a stranger, and that is structural rather than careful. Its
// candidates are `replied` lead_events, and poll-replies only writes one for
// mail matchLead() resolved to a lead in this org; everything else is counted
// `unmatched` and dropped before it could become an event. This route narrows
// further: matchLead() will attribute a thread to a lead by its References
// chain no matter who sent the message, so the address that actually wrote has
// to be the lead's own before anything is written back to it.
//
// It cannot spend tokens for nothing. With the mode off it returns before the
// first Gmail call. Every outcome, including every refusal, writes an
// ai_replies row, so the next tick two minutes later skips the same event
// rather than paying to re-decide it.
//
// It cannot send twice. claim_ai_reply() writes the row BEFORE Gmail is called,
// under a per-mailbox advisory lock, and the unique index on
// (org_id, inbound_message_id) arbitrates between two overlapping ticks. Same
// rule as the dispatcher marking `sending` before it calls Gmail, for the same
// reason: a function killed mid-request must leave a visibly stuck row rather
// than a claimable one.
//
// Service role: no user session exists, and mailbox_secrets is unreadable
// without it.

import type { SupabaseClient } from "@supabase/supabase-js";
import { DateTime } from "luxon";

import { anthropicIsConfigured } from "@/lib/ai/client";
import { decideReply } from "@/lib/ai/reply/decide";
import { checkDraft } from "@/lib/ai/reply/guard";
import type { KbEntry, ReplyLead } from "@/lib/ai/reply/prompt";
import { requireBearer } from "@/lib/cronAuth";
import { serverEnv } from "@/lib/env";
import { classifyInbound, newText } from "@/lib/gmail/classify";
import {
  addressFromHeader,
  fetchThread,
  referencedMessageIds,
} from "@/lib/gmail/messages";
import { generateMessageId, GmailSendError, sendMessage } from "@/lib/gmail/send";
import { replySubject } from "@/lib/gmail/thread";
import {
  findMessage,
  humanRepliedAfter,
  newerInboundAfter,
  transcriptFor,
} from "@/lib/gmail/threadState";
import { getMailboxAccessToken, MailboxDisconnectedError } from "@/lib/gmail/token";
import { normalizeEmail } from "@/lib/normalize";
import { pushAlert } from "@/lib/notify/push";
import { createAdminSupabase } from "@/lib/supabase/admin";
import { selectAll } from "@/lib/supabase/paginate";

export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * When a run stops starting new work. A model call at effort high can take
 * tens of seconds, so this leaves room for one to finish rather than being
 * killed with a row claimed and no idea whether Gmail was reached.
 */
const RUN_BUDGET_MS = 40_000;

/** Candidates per run. The cadence is two minutes; there is no hurry. */
const MAX_PER_RUN = 3;

/**
 * How far back a reply can be and still be answered. Past a day the moment has
 * gone and an assistant answering anyway is worse than silence.
 */
const LOOKBACK_HOURS = 24;

/** Messages of a thread handed to the model, and how much of each. */
const TRANSCRIPT_LIMIT = 6;
const TRANSCRIPT_CHARS = 2000;

interface OrgSettings {
  org_id: string;
  ai_reply_mode: "off" | "draft" | "send";
  ai_reply_delay_minutes: number;
  ai_reply_daily_cap: number;
  ai_reply_enabled_at: string | null;
  booking_url: string | null;
  business_context: string;
  operator_timezone: string;
}

interface Report {
  org: string;
  mode: string;
  /** Replied events inside the window that nothing had considered yet. */
  candidates: number;
  considered: number;
  sent: number;
  drafted: number;
  skipped: number;
  failed: number;
  stalled: number;
  /** Left for the next run: a paused mailbox, a token that would not refresh. */
  deferred: number;
  stopped?: string;
  error?: string;
}

function emptyReport(org: string, mode: string): Report {
  return {
    org,
    mode,
    candidates: 0,
    considered: 0,
    sent: 0,
    drafted: 0,
    skipped: 0,
    failed: 0,
    stalled: 0,
    deferred: 0,
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
    console.error(`ai-replies: raising a ${alert.kind} alert failed: ${error.message}`);
    return false;
  }
  return (data?.length ?? 0) > 0;
}

// ---------------------------------------------------------------------------

interface Candidate {
  leadId: string;
  messageId: string;
  threadId: string;
  mailboxId: string;
  /** Gmail's internalDate, or the event's occurred_at when it predates 0053. */
  receivedAt: Date;
}

/**
 * Replied events old enough to answer and new enough to be worth answering,
 * minus everything already considered.
 *
 * Both reads go through selectAll(): PostgREST clamps a response to 1000 rows
 * whatever the limit says, and a short read of ai_replies makes older events
 * look un-answered, which is a second email to somebody.
 */
async function findCandidates(
  supabase: SupabaseClient,
  settings: OrgSettings,
  now: number,
): Promise<Candidate[]> {
  const since = new Date(now - LOOKBACK_HOURS * 60 * 60 * 1000);
  // Switching the feature on must not answer a day of backlog at once.
  const floor = settings.ai_reply_enabled_at
    ? new Date(
        Math.max(since.getTime(), new Date(settings.ai_reply_enabled_at).getTime()),
      )
    : since;

  const { data: events, error: eventError } = await selectAll<{
    id: string;
    lead_id: string;
    occurred_at: string;
    dedupe_token: string | null;
    payload: Record<string, unknown> | null;
  }>(() =>
    supabase
      .from("lead_events")
      .select("id, lead_id, occurred_at, dedupe_token, payload")
      .eq("org_id", settings.org_id)
      .eq("type", "replied")
      .gte("occurred_at", floor.toISOString()),
  );
  if (eventError) {
    throw new Error(`reading replies to answer failed: ${eventError.message}`);
  }

  const { data: considered, error: consideredError } = await selectAll<{
    id: string;
    inbound_message_id: string;
  }>(() =>
    supabase
      .from("ai_replies")
      .select("id, inbound_message_id")
      .eq("org_id", settings.org_id)
      .gte("created_at", since.toISOString()),
  );
  if (consideredError) {
    throw new Error(`reading what was already considered failed: ${consideredError.message}`);
  }

  const seen = new Set(considered.map((row) => row.inbound_message_id));
  const deadline = now - settings.ai_reply_delay_minutes * 60 * 1000;

  const candidates: Candidate[] = [];
  for (const event of events) {
    // poll-replies stores Gmail's message id as the dedupe token. An event
    // without one was not written by the poller and has no message to read.
    const messageId = event.dedupe_token;
    if (!messageId || seen.has(messageId)) continue;

    const payload = (event.payload ?? {}) as Record<string, unknown>;
    const mailboxId = payload["mailbox_id"];
    const threadId = payload["gmail_thread_id"];
    if (typeof mailboxId !== "string" || typeof threadId !== "string") continue;

    // internal_date arrived with 0053. An older event falls back to
    // occurred_at, which is late rather than wrong.
    const internal = payload["internal_date"];
    const receivedAt =
      typeof internal === "string" && internal.trim() !== ""
        ? new Date(Number(internal))
        : new Date(event.occurred_at);
    if (!Number.isFinite(receivedAt.getTime())) continue;

    if (receivedAt.getTime() > deadline) continue;
    if (receivedAt.getTime() < floor.getTime()) continue;

    candidates.push({
      leadId: event.lead_id,
      messageId,
      threadId,
      mailboxId,
      receivedAt,
    });
  }

  // Oldest first: the one who has waited longest gets answered first.
  candidates.sort((a, b) => a.receivedAt.getTime() - b.receivedAt.getTime());
  return candidates;
}

interface Lead {
  id: string;
  company_name: string | null;
  first_name: string | null;
  last_name: string | null;
  city: string | null;
  state: string | null;
  website: string | null;
  work_email: string | null;
  work_email_norm: string | null;
  website_domain: string | null;
  demo_txt_url: string | null;
  demo_web_url: string | null;
  status: string;
  terminal_outcome: string | null;
  archived_at: string | null;
}

/**
 * Null when nothing is suppressed, true/false otherwise.
 *
 * A read that errored is NEVER "not suppressed" -- the dispatcher's rule, and
 * the caller here defers rather than sending on a read it could not make.
 */
async function isSuppressed(
  supabase: SupabaseClient,
  orgId: string,
  emailNorm: string | null,
  domain: string | null,
): Promise<boolean | null> {
  const checks: PromiseLike<{ hit: boolean } | null>[] = [];

  if (emailNorm) {
    checks.push(
      supabase
        .from("suppressions")
        .select("id")
        .eq("org_id", orgId)
        .eq("email_norm", emailNorm)
        .limit(1)
        .then(({ data, error }) => (error ? null : { hit: (data?.length ?? 0) > 0 })),
    );
  }
  if (domain) {
    checks.push(
      supabase
        .from("suppressions")
        .select("id")
        .eq("org_id", orgId)
        .eq("domain", domain)
        .limit(1)
        .then(({ data, error }) => (error ? null : { hit: (data?.length ?? 0) > 0 })),
    );
  }

  const results = await Promise.all(checks);
  if (results.some((result) => result === null)) return null;
  return results.some((result) => result?.hit);
}

/** A row for a candidate we decided about without ever claiming it. */
async function recordSkip(
  supabase: SupabaseClient,
  orgId: string,
  candidate: Candidate,
  reason: string,
  intent: string | null = null,
): Promise<void> {
  const { error } = await supabase.from("ai_replies").upsert(
    {
      org_id: orgId,
      lead_id: candidate.leadId,
      mailbox_id: candidate.mailboxId,
      inbound_message_id: candidate.messageId,
      inbound_thread_id: candidate.threadId,
      inbound_received_at: candidate.receivedAt.toISOString(),
      outcome: "skipped",
      reason,
      intent,
    },
    { onConflict: "org_id,inbound_message_id", ignoreDuplicates: true },
  );
  if (error) {
    // Not fatal: the worst case is this candidate is reconsidered next run,
    // which costs one thread read. Losing the run over it would cost the rest.
    console.error(`ai-replies: recording a skip failed: ${error.message}`);
  }
}

// ---------------------------------------------------------------------------

type Settled =
  | { kind: "sent" | "drafted" | "skipped" | "failed" | "stalled" }
  | { kind: "deferred"; why: string };

async function settleCandidate(
  supabase: SupabaseClient,
  settings: OrgSettings,
  kbEntries: KbEntry[],
  candidate: Candidate,
): Promise<Settled> {
  const orgId = settings.org_id;

  // --- the lead ------------------------------------------------------------
  const { data: leadRow, error: leadError } = await supabase
    .from("leads")
    .select(
      "id, company_name, first_name, last_name, city, state, website, work_email, " +
        "work_email_norm, website_domain, demo_txt_url, demo_web_url, status, " +
        "terminal_outcome, archived_at",
    )
    .eq("id", candidate.leadId)
    .eq("org_id", orgId)
    .maybeSingle();

  if (leadError) return { kind: "deferred", why: `reading the lead: ${leadError.message}` };
  if (!leadRow) {
    await recordSkip(supabase, orgId, candidate, "the lead is gone");
    return { kind: "skipped" };
  }
  const lead = leadRow as unknown as Lead;

  if (lead.terminal_outcome || lead.archived_at) {
    await recordSkip(
      supabase,
      orgId,
      candidate,
      `this lead is closed (${lead.terminal_outcome ?? "archived"})`,
    );
    return { kind: "skipped" };
  }

  const suppressed = await isSuppressed(
    supabase,
    orgId,
    lead.work_email_norm,
    lead.website_domain,
  );
  if (suppressed === null) {
    // A suppression list that could not be read is never "not suppressed".
    return { kind: "deferred", why: "the suppression list could not be read" };
  }
  if (suppressed) {
    await recordSkip(supabase, orgId, candidate, "this address is suppressed");
    return { kind: "skipped" };
  }

  // --- the mailbox ---------------------------------------------------------
  const { data: mailboxRow, error: mailboxError } = await supabase
    .from("mailboxes")
    .select("id, email, display_name, is_sendable")
    .eq("id", candidate.mailboxId)
    .eq("org_id", orgId)
    .maybeSingle();

  if (mailboxError) {
    return { kind: "deferred", why: `reading the mailbox: ${mailboxError.message}` };
  }
  if (!mailboxRow) {
    await recordSkip(supabase, orgId, candidate, "the mailbox it arrived in is gone");
    return { kind: "skipped" };
  }
  const mailbox = mailboxRow as unknown as {
    id: string;
    email: string;
    display_name: string | null;
    is_sendable: boolean;
  };

  // Pausing a mailbox is an operator saying stop sending from this account.
  // Deferred rather than skipped: unpause within the day and the reply still
  // goes, and past the lookback window it falls away quietly.
  if (!mailbox.is_sendable && settings.ai_reply_mode === "send") {
    return { kind: "deferred", why: `${mailbox.email} is paused` };
  }

  let accessToken: string;
  try {
    const token = await getMailboxAccessToken(supabase, {
      id: mailbox.id,
      org_id: orgId,
      email: mailbox.email,
    });
    accessToken = token.accessToken;
  } catch (error) {
    if (error instanceof MailboxDisconnectedError) {
      // Its own alert was already raised inside getMailboxAccessToken.
      return { kind: "deferred", why: `${mailbox.email} is disconnected` };
    }
    return { kind: "deferred", why: `token for ${mailbox.email}: ${errorText(error)}` };
  }

  // --- the thread ----------------------------------------------------------
  let thread;
  try {
    thread = await fetchThread(accessToken, candidate.threadId);
  } catch (error) {
    return { kind: "deferred", why: `reading the thread: ${errorText(error)}` };
  }

  const inbound = findMessage(thread.messages, candidate.messageId);
  if (!inbound) {
    await recordSkip(supabase, orgId, candidate, "the message was deleted before this ran");
    return { kind: "skipped" };
  }

  // The whole point of the feature: somebody got there first.
  if (humanRepliedAfter(thread.messages, candidate.messageId)) {
    await recordSkip(supabase, orgId, candidate, "a person had already replied");
    return { kind: "skipped" };
  }

  if (newerInboundAfter(thread.messages, candidate.messageId)) {
    await recordSkip(
      supabase,
      orgId,
      candidate,
      "they wrote again before this ran, so it is a conversation now",
    );
    return { kind: "skipped" };
  }

  // matchLead() will attribute a thread to a lead by its References chain no
  // matter who sent the message: a forward, a colleague, a ticketing address.
  // Answering one of those is answering somebody who is not the prospect.
  const sender = addressFromHeader(inbound.headers["from"]);
  const senderNorm = normalizeEmail(sender);
  const senderDomain = senderNorm?.split("@")[1] ?? null;
  const knownAddress =
    senderNorm !== null &&
    (senderNorm === lead.work_email_norm ||
      (lead.website_domain !== null && senderDomain === lead.website_domain));

  if (!knownAddress) {
    await recordSkip(
      supabase,
      orgId,
      candidate,
      `${sender ?? "the sender"} is not this lead's address, so a person should read it`,
    );
    await raiseAlert(supabase, {
      org_id: orgId,
      lead_id: lead.id,
      mailbox_id: mailbox.id,
      kind: "ai_reply",
      message: `Left for you: ${sender ?? "someone"} replied on ${lead.company_name ?? "this lead"}'s thread from an address that is not theirs.`,
      dedupe_token: `unknown-sender:${candidate.messageId}`,
    });
    return { kind: "skipped" };
  }

  // A belt over the poller's decision. It must never answer a bounce.
  const classification = classifyInbound({
    labelIds: inbound.labelIds,
    headers: inbound.headers,
    text: inbound.text,
    snippet: inbound.snippet,
  });
  if (classification.kind !== "reply") {
    await recordSkip(
      supabase,
      orgId,
      candidate,
      `this reads as ${classification.kind}, not a reply (${classification.reason})`,
    );
    return { kind: "skipped" };
  }

  // --- the model -----------------------------------------------------------
  const demoUrl = lead.demo_txt_url ?? lead.demo_web_url ?? null;
  const senderName = (mailbox.display_name ?? "").trim();
  const bookingUrl = (settings.booking_url ?? "").trim();

  const replyLead: ReplyLead = {
    companyName: lead.company_name,
    personName: [lead.first_name, lead.last_name].filter(Boolean).join(" ") || null,
    city: lead.city,
    state: lead.state,
    website: lead.website,
    demoUrl,
  };

  const decision = await decideReply({
    system: { businessContext: settings.business_context, kbEntries, senderName, bookingUrl, demoUrl },
    lead: replyLead,
    transcript: transcriptFor(thread.messages, {
      limit: TRANSCRIPT_LIMIT,
      maxChars: TRANSCRIPT_CHARS,
      stripQuotes: newText,
    }),
  });

  if (!decision.ok) {
    if (decision.retryable) return { kind: "deferred", why: decision.reason };

    await recordSkip(supabase, orgId, candidate, decision.reason);
    await raiseAlert(supabase, {
      org_id: orgId,
      lead_id: lead.id,
      mailbox_id: mailbox.id,
      kind: "ai_reply",
      message: `Left for you: the assistant could not answer ${lead.company_name ?? "this lead"} (${decision.reason}).`,
      dedupe_token: `undecided:${candidate.messageId}`,
    });
    return { kind: "failed" };
  }

  const { decision: answer } = decision;

  if (answer.action === "skip") {
    await recordSkip(supabase, orgId, candidate, answer.reason, answer.intent);
    return { kind: "skipped" };
  }

  const body = (answer.body ?? "").trim();
  const guard = checkDraft(body, {
    bookingUrl,
    demoUrl,
    mailboxEmail: mailbox.email,
  });

  // --- claiming ------------------------------------------------------------
  const willSend = settings.ai_reply_mode === "send" && guard.ok;

  const { data: claimRows, error: claimError } = await supabase.rpc("claim_ai_reply", {
    p_org_id: orgId,
    p_lead_id: lead.id,
    p_mailbox_id: mailbox.id,
    p_inbound_message_id: candidate.messageId,
    p_inbound_thread_id: candidate.threadId,
    p_inbound_received_at: candidate.receivedAt.toISOString(),
    p_will_send: willSend,
  });

  if (claimError) {
    return { kind: "deferred", why: `claiming the reply: ${claimError.message}` };
  }

  const claim = (claimRows as { reply_id: string | null; refused: string | null }[] | null)?.[0];
  if (!claim || !claim.reply_id) {
    const refused = claim?.refused ?? "the claim returned nothing";
    // Mailbox-state refusals are transient: the gap passes, the cap resets,
    // somebody unpauses. Anything else means another tick has it.
    const transient =
      refused === "gap_not_elapsed" ||
      refused === "mailbox_at_cap" ||
      refused === "mailbox_paused";
    if (transient) return { kind: "deferred", why: refused };
    return { kind: "skipped" };
  }

  const replyId = claim.reply_id;

  const subject = replySubject(inbound.headers["subject"] ?? "");
  const shared = {
    p_reply_id: replyId,
    p_intent: answer.intent,
    p_needs_human: answer.needs_human,
    p_subject: subject,
    p_body: body,
    p_model: decision.model,
    p_input_tokens: decision.inputTokens,
    p_output_tokens: decision.outputTokens,
  };

  if (!guard.ok) {
    await supabase.rpc("finish_ai_reply", {
      ...shared,
      p_outcome: "failed",
      p_reason: `refused before sending: ${guard.reason}`,
      p_error: guard.reason,
    });
    await raiseAlert(supabase, {
      org_id: orgId,
      lead_id: lead.id,
      mailbox_id: mailbox.id,
      kind: "ai_reply",
      message: `Left for you: the assistant wrote a reply to ${lead.company_name ?? "this lead"} that was refused before sending (${guard.reason}).`,
      dedupe_token: `refused:${candidate.messageId}`,
    });
    return { kind: "failed" };
  }

  // --- draft mode ----------------------------------------------------------
  if (settings.ai_reply_mode !== "send") {
    await supabase.rpc("finish_ai_reply", {
      ...shared,
      p_outcome: "drafted",
      p_reason: answer.reason,
    });
    const isNew = await raiseAlert(supabase, {
      org_id: orgId,
      lead_id: lead.id,
      mailbox_id: mailbox.id,
      kind: "ai_reply",
      message: `Draft for ${lead.company_name ?? "this lead"}: ${body.slice(0, 300)}`,
      dedupe_token: candidate.messageId,
    });
    if (isNew) {
      await pushAlert({
        title: `Draft reply for ${lead.company_name ?? "a lead"}`,
        body: body.slice(0, 300),
        url: `${serverEnv().siteUrl}/leads?lead=${lead.id}`,
      });
    }
    return { kind: "drafted" };
  }

  // --- sending -------------------------------------------------------------
  const references = referencedMessageIds(inbound.headers);
  const inReplyTo = inbound.headers["message-id"]?.trim() || null;

  let result;
  try {
    result = await sendMessage({
      accessToken,
      threadId: inbound.threadId || candidate.threadId,
      message: {
        from: { name: senderName, email: mailbox.email },
        to: { name: null, email: sender ?? lead.work_email ?? "" },
        subject,
        body,
        messageId: generateMessageId(mailbox.email),
        inReplyTo,
        references,
        autoReply: true,
      },
    });
  } catch (error) {
    // Only a 4xx that is not 429 is a failure. Everything else may be an email
    // that already went out, so the row is parked for a person rather than
    // being offered again. A wrong guess here is a second email.
    const retryable = error instanceof GmailSendError ? error.retryable : true;
    const outcome = retryable ? "stalled" : "failed";

    await supabase.rpc("finish_ai_reply", {
      ...shared,
      p_outcome: outcome,
      p_reason: retryable
        ? "Gmail did not say whether it took this. Check the Sent folder."
        : `Gmail refused it: ${errorText(error)}`,
      p_error: errorText(error),
    });

    await raiseAlert(supabase, {
      org_id: orgId,
      lead_id: lead.id,
      mailbox_id: mailbox.id,
      kind: "ai_reply",
      message: retryable
        ? `Check ${mailbox.email}'s Sent folder: a reply to ${lead.company_name ?? "a lead"} may or may not have gone out.`
        : `The assistant's reply to ${lead.company_name ?? "a lead"} was refused by Gmail: ${errorText(error)}`,
      dedupe_token: `send:${candidate.messageId}`,
    });

    return { kind: retryable ? "stalled" : "failed" };
  }

  const { error: finishError } = await supabase.rpc("finish_ai_reply", {
    ...shared,
    p_outcome: "sent",
    p_reason: answer.reason,
    p_provider_message_id: result.providerMessageId,
    p_provider_thread_id: result.providerThreadId,
    p_rfc822_message_id: result.rfc822MessageId,
  });

  if (finishError) {
    // The email has left. Not recording that is the one state that must never
    // be quiet, so it is parked and alerted with Gmail's own id in the message.
    await raiseAlert(supabase, {
      org_id: orgId,
      lead_id: lead.id,
      mailbox_id: mailbox.id,
      kind: "ai_reply",
      message: `An assistant reply to ${lead.company_name ?? "a lead"} left ${mailbox.email} as Gmail message ${result.providerMessageId} but could not be recorded (${finishError.message}).`,
      dedupe_token: `unrecorded:${candidate.messageId}`,
    });
    return { kind: "stalled" };
  }

  const isNew = await raiseAlert(supabase, {
    org_id: orgId,
    lead_id: lead.id,
    mailbox_id: mailbox.id,
    kind: "ai_reply",
    message: `Replied to ${lead.company_name ?? "a lead"}: ${body.slice(0, 250)}`,
    dedupe_token: candidate.messageId,
  });
  if (isNew) {
    await pushAlert({
      title: `Assistant replied to ${lead.company_name ?? "a lead"}`,
      body: body.slice(0, 300),
      url: `${serverEnv().siteUrl}/leads?lead=${lead.id}`,
    });
  }

  return { kind: "sent" };
}

// ---------------------------------------------------------------------------

async function runOrg(
  supabase: SupabaseClient,
  settings: OrgSettings,
  deadline: number,
): Promise<Report> {
  const report = emptyReport(settings.org_id, settings.ai_reply_mode);

  // Before anything costs anything.
  if (settings.ai_reply_mode === "off") return report;

  if (!anthropicIsConfigured()) {
    report.error = "ANTHROPIC_API_KEY is not set, so nothing can be written.";
    return report;
  }

  if (!(settings.booking_url ?? "").trim()) {
    report.error =
      "No booking link is set, so an interested prospect would have nowhere to go. /settings.";
    return report;
  }

  const now = Date.now();

  // The cost fuse, counted in the OPERATOR's day -- the person paying the bill
  // and reading the drafts -- rather than UTC or a prospect's zone. Separate
  // from mailboxes.daily_cap, which claim_ai_reply() enforces in the mailbox's
  // day because that one is Gmail's limit on an account.
  const dayStart =
    DateTime.now().setZone(settings.operator_timezone).startOf("day").toUTC().toISO() ??
    new Date(now - 24 * 60 * 60 * 1000).toISOString();

  const { count: todayCount, error: countError } = await supabase
    .from("ai_replies")
    .select("id", { count: "exact", head: true })
    .eq("org_id", settings.org_id)
    .gte("created_at", dayStart)
    .in("outcome", ["sending", "sent", "drafted", "stalled"]);

  if (countError) {
    report.error = `reading today's count failed: ${countError.message}`;
    return report;
  }
  if ((todayCount ?? 0) >= settings.ai_reply_daily_cap) {
    report.stopped = `at the daily cap of ${settings.ai_reply_daily_cap}`;
    return report;
  }

  const { data: kbRows, error: kbError } = await selectAll<{
    id: string;
    question: string;
    answer: string;
    sort_order: number;
  }>(() =>
    supabase
      .from("kb_entries")
      .select("id, question, answer, sort_order")
      .eq("org_id", settings.org_id)
      .eq("is_active", true),
  );
  if (kbError) {
    report.error = `reading the knowledge base failed: ${kbError.message}`;
    return report;
  }
  const kbEntries: KbEntry[] = [...kbRows]
    .sort((a, b) => a.sort_order - b.sort_order)
    .map((row) => ({ question: row.question, answer: row.answer }));

  const candidates = await findCandidates(supabase, settings, now);
  report.candidates = candidates.length;

  let room = settings.ai_reply_daily_cap - (todayCount ?? 0);

  for (const candidate of candidates) {
    if (report.considered >= MAX_PER_RUN) {
      report.stopped = `${MAX_PER_RUN} per run; the rest wait for the next tick`;
      break;
    }
    if (room <= 0) {
      report.stopped = `at the daily cap of ${settings.ai_reply_daily_cap}`;
      break;
    }
    if (Date.now() >= deadline) {
      report.stopped = "out of time; the rest wait for the next tick";
      break;
    }

    report.considered += 1;
    const settled = await settleCandidate(supabase, settings, kbEntries, candidate);

    switch (settled.kind) {
      case "sent":
        report.sent += 1;
        room -= 1;
        break;
      case "drafted":
        report.drafted += 1;
        room -= 1;
        break;
      case "skipped":
        report.skipped += 1;
        break;
      case "failed":
        report.failed += 1;
        break;
      case "stalled":
        report.stalled += 1;
        room -= 1;
        break;
      case "deferred":
        report.deferred += 1;
        report.stopped = report.stopped ?? settled.why;
        break;
    }
  }

  return report;
}

export async function POST(request: Request) {
  const denied = requireBearer(request, serverEnv().cronSecret);
  if (denied) return denied;

  const deadline = Date.now() + RUN_BUDGET_MS;
  const supabase = createAdminSupabase();

  let query = supabase
    .from("org_settings")
    .select(
      "org_id, ai_reply_mode, ai_reply_delay_minutes, ai_reply_daily_cap, " +
        "ai_reply_enabled_at, booking_url, business_context, operator_timezone",
    );

  // A test must never read or write for an org it did not create.
  const onlyOrg = new URL(request.url).searchParams.get("org");
  if (onlyOrg) query = query.eq("org_id", onlyOrg);

  const { data, error } = await query;
  if (error) return Response.json({ error: error.message }, { status: 500 });

  const orgs = (data ?? []) as unknown as OrgSettings[];
  const reports: Report[] = [];

  for (const settings of orgs) {
    try {
      reports.push(await runOrg(supabase, settings, deadline));
    } catch (error) {
      console.error(`ai-replies: ${settings.org_id} failed: ${errorText(error)}`);
      const report = emptyReport(settings.org_id, settings.ai_reply_mode);
      report.error = errorText(error);
      reports.push(report);
    }
  }

  return Response.json({ orgs: reports.length, reports });
}
