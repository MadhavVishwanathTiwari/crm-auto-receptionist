// The assistant writes first touches to leads nobody has picked up.
//
// Every 30 minutes, per org, while `ai_outbound_mode` is not `off`:
//
//   candidates   unclaimed, qualified, zoned, with a work email and a
//                website, never emailed, never considered, not suppressed;
//                leads with a demo first, because T2 is waiting on one
//   per lead     read the website -> write (or skip) -> guard ->
//                record_ai_outbound(), which claims the lead for the owner of
//                `ai_outbound_mailbox_id` and, in send mode, hands a blocked
//                step-1 row to the planner
//
// until `ai_outbound_daily` emails exist for today in the operator's zone.
// See 0056 for why draft mode books nothing and why send mode books through
// the planner rather than here.
//
// Every decision writes an `ai_outbound` row -- a skip, an unreadable site, a
// draft the guard refused twice -- so no lead is ever paid for twice. Only a
// transient failure (the model API down, rate limited) writes nothing, and
// stops the run so the next one tries again.

import type { SupabaseClient } from "@supabase/supabase-js";
import { DateTime } from "luxon";

import { modelIsConfigured } from "@/lib/ai/client";
import type { OutboundLead } from "@/lib/ai/outbound/prompt";
import { readWebsite } from "@/lib/ai/outbound/website";
import { writeFirstTouch } from "@/lib/ai/outbound/write";
import { requireBearer } from "@/lib/cronAuth";
import { serverEnv } from "@/lib/env";
import { createAdminSupabase } from "@/lib/supabase/admin";
import { selectAll } from "@/lib/supabase/paginate";

export const runtime = "nodejs";
export const maxDuration = 120;

/** Leaves room for the last model call to finish inside maxDuration. */
const RUN_BUDGET_MS = 75_000;

/**
 * A fuse on attempts, not emails. Skips do not count toward the daily number,
 * so a pool full of non-fits could otherwise spend a model call on every lead
 * in one day.
 */
const ATTEMPTS_PER_EMAIL = 4;

interface OrgSettings {
  org_id: string;
  ai_outbound_mode: "off" | "draft" | "send";
  ai_outbound_daily: number;
  ai_outbound_mailbox_id: string | null;
  business_context: string;
  operator_timezone: string;
}

interface Report {
  org_id: string;
  mode: string;
  written: number;
  skipped: number;
  failed: number;
  today: number;
  capped?: boolean;
  error?: string;
}

interface Lead {
  id: string;
  company_name: string | null;
  first_name: string | null;
  last_name: string | null;
  industry: string | null;
  city: string | null;
  state: string | null;
  rating: number | null;
  reviews_count: number | null;
  website: string | null;
  website_domain: string | null;
  work_email_norm: string | null;
  verification: string | null;
  demo_ready_at: string | null;
  created_at: string;
}

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (error && typeof error === "object" && "message" in error) {
    return String((error as { message: unknown }).message);
  }
  return String(error);
}

/**
 * Leads the assistant may write to, best first.
 *
 * Every read is complete or the run stops: a short read of scheduled_sends
 * makes an emailed lead look fresh, and the RPC would refuse it, but only
 * after a model call had been paid for.
 */
async function findCandidates(supabase: SupabaseClient, orgId: string): Promise<Lead[]> {
  const [leads, sends, considered, suppressions] = await Promise.all([
    selectAll<Lead>(() =>
      supabase
        .from("leads")
        .select(
          "id, company_name, first_name, last_name, industry, city, state, rating, " +
            "reviews_count, website, website_domain, work_email_norm, verification, demo_ready_at, created_at",
        )
        .eq("org_id", orgId)
        .is("claimed_by", null)
        .is("archived_at", null)
        .is("halted_at", null)
        .is("terminal_outcome", null)
        .eq("is_qualified", true)
        .not("timezone", "is", null)
        .not("work_email", "is", null)
        .not("website", "is", null)
        // RFC 2606 fixtures (0037). They are halted anyway; this says so.
        .or("source.is.null,source.neq.demo"),
    ),
    selectAll<{ id: string; lead_id: string }>(() =>
      supabase.from("scheduled_sends").select("id, lead_id").eq("org_id", orgId),
    ),
    selectAll<{ id: string; lead_id: string }>(() =>
      supabase.from("ai_outbound").select("id, lead_id").eq("org_id", orgId),
    ),
    selectAll<{ id: string; email_norm: string | null; domain: string | null }>(() =>
      supabase.from("suppressions").select("id, email_norm, domain").eq("org_id", orgId),
    ),
  ]);

  for (const read of [leads, sends, considered, suppressions]) {
    if (read.error) throw new Error(`reading candidates: ${read.error.message}`);
  }

  const touched = new Set([...sends.data, ...considered.data].map((row) => row.lead_id));
  const emails = new Set(suppressions.data.map((s) => s.email_norm).filter(Boolean));
  const domains = new Set(suppressions.data.map((s) => s.domain).filter(Boolean));

  return leads.data
    .filter(
      (lead) =>
        !touched.has(lead.id) &&
        // In code, not `.neq()`: PostgREST's neq drops a null with it.
        lead.verification !== "invalid" &&
        !(lead.work_email_norm && emails.has(lead.work_email_norm)) &&
        !(lead.website_domain && domains.has(lead.website_domain)),
    )
    .sort((a, b) => {
      // A lead with a demo can have its T2 the moment T1 lands.
      const demo = Number(Boolean(b.demo_ready_at)) - Number(Boolean(a.demo_ready_at));
      return demo !== 0 ? demo : a.created_at.localeCompare(b.created_at);
    });
}

async function recordOutcome(
  supabase: SupabaseClient,
  row: {
    org_id: string;
    lead_id: string;
    mailbox_id: string;
    outcome: "skipped" | "failed";
    reason: string;
    subject?: string | null;
    body?: string | null;
    website_chars: number;
    model?: string | null;
    input_tokens?: number | null;
    output_tokens?: number | null;
  },
): Promise<void> {
  // ignoreDuplicates: a second run that got here first has already decided.
  const { error } = await supabase
    .from("ai_outbound")
    .upsert(row, { onConflict: "org_id,lead_id", ignoreDuplicates: true });
  if (error) throw new Error(`recording ${row.outcome}: ${error.message}`);
}

async function runOrg(
  supabase: SupabaseClient,
  settings: OrgSettings,
  deadline: number,
): Promise<Report> {
  const orgId = settings.org_id;
  const report: Report = {
    org_id: orgId,
    mode: settings.ai_outbound_mode,
    written: 0,
    skipped: 0,
    failed: 0,
    today: 0,
  };

  // Off means off: no read, no fetch, no model call.
  if (settings.ai_outbound_mode === "off") return report;

  if (!modelIsConfigured()) {
    report.error = "OPENROUTER_KEY is not set, so the assistant cannot write.";
    return report;
  }

  if (!settings.ai_outbound_mailbox_id) {
    report.error = "No mailbox is chosen for the assistant to write as. Choose one on Settings.";
    return report;
  }

  const { data: mailbox, error: mailboxError } = await supabase
    .from("mailboxes")
    .select("id, email, display_name, user_id, is_sendable")
    .eq("id", settings.ai_outbound_mailbox_id)
    .maybeSingle();
  if (mailboxError) throw new Error(`reading the mailbox: ${mailboxError.message}`);
  if (!mailbox?.is_sendable || !mailbox.display_name?.trim() || !mailbox.user_id) {
    report.error = `${mailbox?.email ?? "The assistant's mailbox"} is not connected, is paused, or has no display name.`;
    return report;
  }
  const senderName = (mailbox.display_name as string).trim();

  const zone = settings.operator_timezone;
  const midnight = DateTime.now().setZone(zone).startOf("day").toUTC().toISO()!;
  const { data: todayRows, error: todayError } = await supabase
    .from("ai_outbound")
    .select("outcome")
    .eq("org_id", orgId)
    .gte("created_at", midnight);
  if (todayError) throw new Error(`counting today: ${todayError.message}`);

  report.today = (todayRows ?? []).filter((r) => r.outcome === "drafted" || r.outcome === "queued").length;
  let attempts = (todayRows ?? []).length;

  const daily = settings.ai_outbound_daily;
  if (report.today >= daily || attempts >= daily * ATTEMPTS_PER_EMAIL) {
    report.capped = true;
    return report;
  }

  const [candidates, templates] = await Promise.all([
    findCandidates(supabase, orgId),
    supabase
      .from("templates")
      .select("subject, body")
      .eq("org_id", orgId)
      .eq("step_number", 1)
      .eq("is_active", true),
  ]);
  if (templates.error) throw new Error(`reading templates: ${templates.error.message}`);

  const system = {
    businessContext: settings.business_context ?? "",
    senderName,
    houseFirstTouches: (templates.data ?? []) as { subject: string; body: string }[],
  };

  for (const lead of candidates) {
    if (report.today >= daily) {
      report.capped = true;
      break;
    }
    if (attempts >= daily * ATTEMPTS_PER_EMAIL || Date.now() > deadline) break;
    attempts += 1;

    const base = { org_id: orgId, lead_id: lead.id, mailbox_id: mailbox.id as string };

    const site = await readWebsite(lead.website);
    if (!site.ok) {
      // Nothing to write from is a reason to leave it to a person, not to
      // write blind in somebody's name.
      await recordOutcome(supabase, {
        ...base,
        outcome: "skipped",
        reason: `Could not read the website: ${site.reason}.`,
        website_chars: 0,
      });
      report.skipped += 1;
      continue;
    }

    const personName = [lead.first_name, lead.last_name].filter(Boolean).join(" ") || null;
    const prospect: OutboundLead = {
      companyName: lead.company_name,
      personName,
      industry: lead.industry,
      city: lead.city,
      state: lead.state,
      rating: lead.rating,
      reviewsCount: lead.reviews_count,
      website: site.url,
    };

    const result = await writeFirstTouch({ system, lead: prospect, websiteText: site.text });

    if (result.kind === "failed" && result.retryable) {
      // The model API is down or busy. Nothing about this lead was decided.
      report.error = result.reason;
      break;
    }

    if (result.kind !== "written") {
      await recordOutcome(supabase, {
        ...base,
        outcome: result.kind,
        reason: result.reason,
        website_chars: site.text.length,
        model: "model" in result ? result.model : null,
        input_tokens: result.inputTokens ?? null,
        output_tokens: result.outputTokens ?? null,
      });
      if (result.kind === "skipped") report.skipped += 1;
      else report.failed += 1;
      continue;
    }

    const { error } = await supabase.rpc("record_ai_outbound", {
      p_org: orgId,
      p_lead_id: lead.id,
      p_mailbox_id: mailbox.id,
      p_send: settings.ai_outbound_mode === "send",
      p_subject: result.subject,
      p_body: result.body,
      p_reason: result.reason,
      p_model: result.model,
      p_input_tokens: result.inputTokens,
      p_output_tokens: result.outputTokens,
      p_website_chars: site.text.length,
    });

    if (error) {
      // 55006 is a state that changed while the model wrote: somebody claimed
      // it, booked it, suppressed it, or the day filled up. The lead is not
      // the assistant's any more, or not today; move on. Anything else is
      // configuration, and repeating it per lead would be the same error N
      // times.
      if (error.code === "55006") {
        if (/written its/.test(error.message)) {
          report.capped = true;
          break;
        }
        continue;
      }
      throw new Error(`recording the draft: ${error.message}`);
    }

    report.written += 1;
    report.today += 1;
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
      "org_id, ai_outbound_mode, ai_outbound_daily, ai_outbound_mailbox_id, " +
        "business_context, operator_timezone",
    );

  // A test must never read or write for an org it did not create.
  const onlyOrg = new URL(request.url).searchParams.get("org");
  if (onlyOrg) query = query.eq("org_id", onlyOrg);

  const { data, error } = await query;
  if (error) return Response.json({ error: error.message }, { status: 500 });

  const reports: Report[] = [];
  for (const settings of (data ?? []) as unknown as OrgSettings[]) {
    try {
      reports.push(await runOrg(supabase, settings, deadline));
    } catch (err) {
      console.error(`ai-outbound: ${settings.org_id} failed: ${errorText(err)}`);
      reports.push({
        org_id: settings.org_id,
        mode: settings.ai_outbound_mode,
        written: 0,
        skipped: 0,
        failed: 0,
        today: 0,
        error: errorText(err),
      });
    }
  }

  return Response.json({ orgs: reports.length, reports });
}
