// The dispatcher. The only thing in this repo that puts an email in front of a
// human being.
//
// Order of operations is the whole design, and each step exists because the
// obvious shortcut past it is wrong:
//
//   claim      caps are counted and rows are locked in the database, not here
//   suppress   re-checked NOW, not at plan time: a "take us off your list"
//              reply that arrived after the slot was booked has to win
//   render     a template variable with nothing behind it skips the send
//              rather than mailing "Hi , I texted at ."
//   sending    marked BEFORE the Gmail call, so a process killed mid-request
//              leaves a visibly stuck row instead of a claimable one
//   sent       one transaction: the row, the event carrying Gmail's message id
//              as its dedupe token, and the mailbox stamp
//
// A row carrying `composed_body` is an email a human wrote, and it skips the
// render step entirely: the words are already final, there are no variables in
// them, and therefore there is nothing that can be missing. Every other step
// above still applies to it, unchanged. That is the point of composed sends
// being rows in this table rather than a second pipeline; suppression, caps,
// threading, stall reaping and the dry-run switch are written once.
//
// work_email is the only address a lead has. The reference columns that used to
// sit beside it were dropped in 0034 precisely so this file cannot pick wrong.
//
// Service role: no user session exists, and it must reach every org.

import type { SupabaseClient } from "@supabase/supabase-js";

import { requireBearer } from "@/lib/cronAuth";
import { serverEnv } from "@/lib/env";
import { GmailSendError, generateMessageId, sendMessage } from "@/lib/gmail/send";
import { getMailboxAccessToken, MailboxDisconnectedError } from "@/lib/gmail/token";
import {
  buildTemplateValues,
  renderTemplate,
  type EvidenceForRender,
  type LeadForRender,
} from "@/lib/templates/render";
import { createAdminSupabase } from "@/lib/supabase/admin";

export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * Sends per invocation. Deliberately smaller than a day's capacity: a
 * serverless function has a wall-clock budget, and a batch that times out
 * halfway leaves rows in `sending` that the reaper then has to fail. Run the
 * cron more often rather than making this bigger.
 */
const DEFAULT_BATCH = 20;

interface ClaimedSend {
  id: string;
  org_id: string;
  lead_id: string;
  mailbox_id: string | null;
  template_id: string | null;
  step_number: number;
  claim_token: string;
  /** Set when an operator wrote this one by hand. Sent verbatim. */
  composed_subject: string | null;
  composed_body: string | null;
}

interface DispatchReport {
  org_id: string;
  claimed: number;
  sent: number;
  /** Of `sent`, how many were written by a person rather than a template. */
  composed: number;
  skipped: number;
  failed: number;
  reaped: number;
}

// ---------------------------------------------------------------------------

async function isSuppressed(
  supabase: SupabaseClient,
  orgId: string,
  emailNorm: string | null,
  domain: string | null,
): Promise<boolean> {
  // Two parameterized queries rather than one PostgREST `or=(...)` filter. The
  // or-syntax interpolates values into a string, and an address containing a
  // comma or a parenthesis would silently change the meaning of the filter —
  // in the direction of matching nothing, which here means sending anyway.
  const checks = await Promise.all([
    emailNorm
      ? supabase
          .from("suppressions")
          .select("id")
          .eq("org_id", orgId)
          .eq("email_norm", emailNorm)
          .limit(1)
      : Promise.resolve({ data: [] as { id: string }[] }),
    domain
      ? supabase
          .from("suppressions")
          .select("id")
          .eq("org_id", orgId)
          .eq("domain", domain)
          .limit(1)
      : Promise.resolve({ data: [] as { id: string }[] }),
  ]);

  return checks.some((check) => (check.data?.length ?? 0) > 0);
}

async function raiseAlert(
  supabase: SupabaseClient,
  alert: {
    org_id: string;
    kind: string;
    message: string;
    lead_id?: string | null;
    dedupe_token: string;
  },
) {
  await supabase.from("alerts").upsert(
    {
      org_id: alert.org_id,
      kind: alert.kind,
      message: alert.message,
      lead_id: alert.lead_id ?? null,
      dedupe_token: alert.dedupe_token,
    },
    { onConflict: "org_id,kind,dedupe_token", ignoreDuplicates: true },
  );
}

// ---------------------------------------------------------------------------

async function dispatchOrg(
  supabase: SupabaseClient,
  orgId: string,
  batch: number,
): Promise<DispatchReport> {
  const report: DispatchReport = {
    org_id: orgId,
    claimed: 0,
    sent: 0,
    composed: 0,
    skipped: 0,
    failed: 0,
    reaped: 0,
  };

  const { data: reaped } = await supabase.rpc("reap_stalled_sends", {
    p_org_id: orgId,
  });
  report.reaped = (reaped as number | null) ?? 0;

  // Caps, the grace window and the dry_run kill switch all live inside this
  // call. If dry_run is on it returns nothing at all, which is why there is no
  // second check for it here: the switch has to sit below the layer that could
  // have a bug in it.
  const { data: claimedRows, error: claimError } = await supabase.rpc(
    "claim_due_sends",
    { p_org_id: orgId, p_limit: batch },
  );

  if (claimError) throw new Error(`claim_due_sends: ${claimError.message}`);

  const claimed = (claimedRows ?? []) as ClaimedSend[];
  report.claimed = claimed.length;
  if (claimed.length === 0) return report;

  const leadIds = [...new Set(claimed.map((s) => s.lead_id))];
  const mailboxIds = [...new Set(claimed.map((s) => s.mailbox_id).filter(Boolean))];
  const templateIds = [...new Set(claimed.map((s) => s.template_id).filter(Boolean))];

  const [
    { data: leadRows },
    { data: mailboxRows },
    { data: templateRows },
    { data: evidenceRows },
    { data: priorRows },
  ] = await Promise.all([
    supabase
      .from("leads")
      // One string literal on purpose: supabase-js parses the select list as a
      // template literal type, and concatenating it collapses the result to an
      // error type. Same note as leads/page.tsx.
      .select(
        "id, first_name, last_name, company_name, city, state, industry, work_email, work_email_norm, website_domain, demo_txt_url, demo_web_url",
      )
      .in("id", leadIds),
    supabase
      .from("mailboxes")
      .select("id, org_id, email, display_name, is_sendable")
      .in("id", mailboxIds as string[]),
    supabase
      .from("templates")
      .select("id, subject, body")
      .in("id", templateIds as string[]),
    supabase
      .from("lead_evidence")
      .select(
        "lead_id, audited_at_local, audit_timezone, outcome, response_delay_seconds, created_at",
      )
      .in("lead_id", leadIds)
      .order("created_at", { ascending: false }),
    // Everything already sent to these leads, for threading. A follow-up that
    // starts a new thread reads as a different sender and loses the context the
    // first touch established.
    supabase
      .from("scheduled_sends")
      .select("lead_id, step_number, provider_thread_id, rfc822_message_id")
      .in("lead_id", leadIds)
      .eq("status", "sent")
      .order("step_number", { ascending: true }),
  ]);

  const leads = new Map((leadRows ?? []).map((l) => [l.id as string, l]));
  const mailboxes = new Map((mailboxRows ?? []).map((m) => [m.id as string, m]));
  const templates = new Map((templateRows ?? []).map((t) => [t.id as string, t]));

  const evidence = new Map<string, EvidenceForRender>();
  for (const row of evidenceRows ?? []) {
    // Ordered newest first, so the first one wins.
    if (!evidence.has(row.lead_id as string)) {
      evidence.set(row.lead_id as string, row as unknown as EvidenceForRender);
    }
  }

  const priorByLead = new Map<
    string,
    { threadId: string | null; messageIds: string[] }
  >();
  for (const row of priorRows ?? []) {
    const key = row.lead_id as string;
    const entry = priorByLead.get(key) ?? { threadId: null, messageIds: [] };
    if (row.provider_thread_id) entry.threadId = row.provider_thread_id as string;
    if (row.rfc822_message_id) entry.messageIds.push(row.rfc822_message_id as string);
    priorByLead.set(key, entry);
  }

  // One access token per mailbox, minted lazily. A dispatch run of twenty sends
  // from one account should not mint twenty.
  const tokens = new Map<string, string>();
  const deadMailboxes = new Set<string>();

  for (const send of claimed) {
    const lead = leads.get(send.lead_id);
    const mailbox = send.mailbox_id ? mailboxes.get(send.mailbox_id) : undefined;
    const template = send.template_id ? templates.get(send.template_id) : undefined;

    // A hand-written email carries its own words and needs no template, even
    // though it may still name the one it was started from.
    const written =
      send.composed_body !== null && send.composed_subject !== null;

    if (!lead || !mailbox || (!written && !template)) {
      await supabase.rpc("mark_send_skipped", {
        p_send_id: send.id,
        p_reason: "the lead, mailbox or template went away after this was claimed",
      });
      report.skipped += 1;
      continue;
    }

    if (deadMailboxes.has(mailbox.id as string) || !mailbox.is_sendable) {
      await supabase.rpc("mark_send_failed", {
        p_send_id: send.id,
        p_code: "mailbox_unavailable",
        p_detail: "the mailbox is paused or needs reconnecting",
      });
      report.failed += 1;
      continue;
    }

    // work_email, and only work_email.
    if (!lead.work_email) {
      await supabase.rpc("mark_send_skipped", {
        p_send_id: send.id,
        p_reason: "the lead has no work_email",
      });
      report.skipped += 1;
      continue;
    }

    // Immediately before the send, never at plan time.
    if (
      await isSuppressed(
        supabase,
        orgId,
        lead.work_email_norm as string | null,
        lead.website_domain as string | null,
      )
    ) {
      await supabase.rpc("mark_send_skipped", {
        p_send_id: send.id,
        p_reason: "on the do-not-contact list",
      });
      report.skipped += 1;
      continue;
    }

    // The words. Either a person's, verbatim, or a template's, rendered.
    let subjectText: string;
    let bodyText: string;

    if (written) {
      // No substitution pass at all. The composer resolved every variable
      // against the real lead before the operator ever saw the draft, so what
      // is stored here is finished prose. Running it through renderTemplate
      // would only give a prospect who wrote "{{" in their company name a way
      // to break their own email.
      subjectText = send.composed_subject as string;
      bodyText = send.composed_body as string;
    } else {
      const values = buildTemplateValues({
        lead: lead as unknown as LeadForRender,
        evidence: evidence.get(send.lead_id) ?? null,
        senderName: (mailbox.display_name as string | null) ?? null,
      });

      const subject = renderTemplate(template!.subject as string, values);
      const body = renderTemplate(template!.body as string, values);
      const missing = [...new Set([...subject.missing, ...body.missing])];

      if (missing.length > 0) {
        await supabase.rpc("mark_send_skipped", {
          p_send_id: send.id,
          p_reason: `nothing to put in ${missing.join(", ")}`,
        });
        await raiseAlert(supabase, {
          org_id: orgId,
          kind: "pre_send_review",
          lead_id: send.lead_id,
          message: `A send was skipped: no value for ${missing.join(", ")}.`,
          dedupe_token: `missing-vars:${missing.sort().join(",")}`,
        });
        report.skipped += 1;
        continue;
      }

      subjectText = subject.text;
      bodyText = body.text;
    }

    let accessToken = tokens.get(mailbox.id as string);
    if (!accessToken) {
      try {
        const token = await getMailboxAccessToken(supabase, {
          id: mailbox.id as string,
          org_id: mailbox.org_id as string,
          email: mailbox.email as string,
        });
        accessToken = token.accessToken;
        tokens.set(mailbox.id as string, accessToken);
      } catch (error) {
        // A dead grant fails every send queued behind it. Stop working this
        // mailbox for the rest of the run rather than failing twenty in a row.
        if (error instanceof MailboxDisconnectedError) {
          deadMailboxes.add(mailbox.id as string);
        }
        await supabase.rpc("mark_send_failed", {
          p_send_id: send.id,
          p_code: "no_access_token",
          p_detail: error instanceof Error ? error.message : String(error),
        });
        report.failed += 1;
        continue;
      }
    }

    const prior = priorByLead.get(send.lead_id);
    const messageId = generateMessageId(mailbox.email as string);

    // The point of no return. Marked first so a process killed inside the
    // Gmail call leaves a row that is visibly stuck rather than one the next
    // run would claim and send a second time.
    const { data: locked } = await supabase.rpc("mark_send_sending", {
      p_send_id: send.id,
      p_claim_token: send.claim_token,
    });

    if (locked !== true) {
      // Another dispatcher owns it. Not ours to send.
      continue;
    }

    try {
      const result = await sendMessage({
        accessToken,
        threadId: prior?.threadId ?? null,
        message: {
          from: {
            name: (mailbox.display_name as string | null) ?? null,
            email: mailbox.email as string,
          },
          to: {
            name:
              [lead.first_name, lead.last_name].filter(Boolean).join(" ") || null,
            email: lead.work_email as string,
          },
          subject: subjectText,
          body: bodyText,
          messageId,
          inReplyTo: prior?.messageIds.at(-1) ?? null,
          references: prior?.messageIds ?? [],
        },
      });

      // One transaction: the row, the `sent` event carrying Gmail's message id
      // as its dedupe token, and the mailbox stamp. Nothing here writes
      // leads.status; the trigger on lead_events derives it.
      await supabase.rpc("mark_send_sent", {
        p_send_id: send.id,
        p_message_id: result.providerMessageId,
        p_thread_id: result.providerThreadId,
        p_rfc822_id: result.rfc822MessageId,
        p_subject: subjectText,
        p_body: bodyText,
      });

      report.sent += 1;
      if (written) report.composed += 1;
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      await supabase.rpc("mark_send_failed", {
        p_send_id: send.id,
        p_code: error instanceof GmailSendError ? `gmail_${error.status}` : "send_failed",
        p_detail: detail,
      });
      await supabase.from("mailbox_events").insert({
        org_id: orgId,
        mailbox_id: mailbox.id,
        kind: "send_failure",
        detail: detail.slice(0, 500),
      });
      report.failed += 1;
    }
  }

  return report;
}

// ---------------------------------------------------------------------------

export async function POST(request: Request) {
  const denied = requireBearer(request, serverEnv().cronSecret);
  if (denied) return denied;

  const url = new URL(request.url);
  const requested = Number(url.searchParams.get("limit"));
  const batch =
    Number.isFinite(requested) && requested > 0 && requested <= 100
      ? Math.floor(requested)
      : DEFAULT_BATCH;

  const supabase = createAdminSupabase();

  // Optional scope, same reasoning as the planner: a test must never dispatch
  // for an org it did not create.
  const onlyOrg = url.searchParams.get("org");

  let query = supabase.from("org_settings").select("org_id");
  if (onlyOrg) query = query.eq("org_id", onlyOrg);

  const { data: orgs, error } = await query;
  if (error) return Response.json({ error: error.message }, { status: 500 });

  const reports: DispatchReport[] = [];
  for (const row of orgs ?? []) {
    reports.push(await dispatchOrg(supabase, row.org_id as string, batch));
  }

  return Response.json({ orgs: reports.length, reports });
}
