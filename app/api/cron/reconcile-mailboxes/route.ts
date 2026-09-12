// The nightly catch-up: emails that left a mailbox without the app sending them.
//
// Everything the dispatcher sends is recorded the moment Gmail accepts it, and
// poll-replies picks up what comes back. What neither sees is an operator
// writing to a lead straight from Gmail. That email is real, the prospect has
// it, and until something records it /write offers a step the lead is already
// past. On 12 Sep that gap was 122 of Ojas's leads (0042).
//
// So once a night this reads the last few days of every connected mailbox's
// Sent folder and hands each lead it wrote to to record_mailbox_touches(), the
// same function the one-off script uses, with the same matching, renumbering
// and idempotency. The dispatcher's own sends already carry their Gmail id and
// are recognised, not doubled. Days rather than the whole folder: a full read
// is two thousand messages and this function has sixty seconds.
//
// Leads that have replied or been closed are skipped. After a reply the
// operator's emails are a conversation, not touches in a sequence, and there is
// no next step for them to move.
//
// Read-only against Gmail, like everything else here. Service role: no user
// session, and mailbox_secrets is unreadable without it.

import type { SupabaseClient } from "@supabase/supabase-js";

import { requireBearer } from "@/lib/cronAuth";
import { serverEnv } from "@/lib/env";
import { fetchMessageMetadata, listMessageIds } from "@/lib/gmail/messages";
import { getMailboxAccessToken, MailboxDisconnectedError } from "@/lib/gmail/token";
import {
  collapseToDays,
  recipientsOf,
  touchFrom,
  type SentTouch,
} from "@/lib/gmail/touches";
import { normalizeEmail } from "@/lib/normalize";
import { createAdminSupabase } from "@/lib/supabase/admin";

export const runtime = "nodejs";
export const maxDuration = 60;

/** How far back each run reads. Three days covers a missed night or two. */
const DEFAULT_DAYS = 3;
const MAX_DAYS = 14;

const METADATA_HEADERS = ["To", "Cc", "Bcc", "Subject", "Message-ID"];

/**
 * Outcomes another night will not fix on its own. Each raises one alert per
 * lead; the rest (recorded, already_present, in_flight) need nobody.
 */
const NEEDS_A_PERSON: Record<string, string> = {
  conflict:
    "This lead was written to from both mailboxes. A thread lives in one account, so its history was not recorded; decide whose conversation it is.",
  too_many_touches:
    "The Sent folders show more than four emails to this lead, more than the sequence has steps. Its history was not recorded.",
  inconsistent_existing:
    "This lead's recorded steps disagree with their dates, so the emails found in Gmail were not recorded.",
  outcome_unknown:
    "An earlier send to this lead is waiting on a decision in the lead drawer, so the emails found in Gmail were not recorded yet.",
  no_timezone:
    "An email was sent to this lead from Gmail, but it has no timezone, so it cannot be recorded. Assign one on the lead.",
  error: "Recording the emails sent to this lead from Gmail failed.",
};

interface Mailbox {
  id: string;
  org_id: string;
  email: string;
}

interface Lead {
  id: string;
  work_email_norm: string;
  timezone: string | null;
}

interface OrgReport {
  org_id: string;
  mailboxes: { mailbox: string; sent_read: number; error?: string }[];
  leads: number;
  outcomes: Record<string, number>;
}

// ---------------------------------------------------------------------------

async function pool<T, R>(
  items: T[],
  size: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(size, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index]!);
    }
  });
  await Promise.all(workers);
  return results;
}

async function reconcileOrg(
  supabase: SupabaseClient,
  orgId: string,
  mailboxes: Mailbox[],
  sinceSeconds: number,
): Promise<OrgReport> {
  const report: OrgReport = { org_id: orgId, mailboxes: [], leads: 0, outcomes: {} };

  // --- what each mailbox sent ------------------------------------------------
  const touchesByAddress = new Map<string, SentTouch[]>();

  for (const mailbox of mailboxes) {
    try {
      const { accessToken } = await getMailboxAccessToken(supabase, mailbox);
      const ids = await listMessageIds(accessToken, {
        labelIds: "SENT",
        q: `after:${sinceSeconds}`,
      });
      const messages = await pool(ids, 8, (id) =>
        fetchMessageMetadata(accessToken, id, METADATA_HEADERS),
      );

      for (const message of messages) {
        const touch = touchFrom(message, mailbox.id);
        if (!touch) continue;
        for (const address of recipientsOf(message.headers, normalizeEmail)) {
          const list = touchesByAddress.get(address) ?? [];
          list.push(touch);
          touchesByAddress.set(address, list);
        }
      }

      report.mailboxes.push({ mailbox: mailbox.email, sent_read: ids.length });
    } catch (error) {
      // One dead mailbox must not stop the other from being read. A revoked
      // grant has already raised its own alert inside getMailboxAccessToken().
      if (!(error instanceof MailboxDisconnectedError)) {
        console.error(`reconcile failed for ${mailbox.email}:`, error);
      }
      report.mailboxes.push({
        mailbox: mailbox.email,
        sent_read: 0,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // --- which of those addresses are leads still in a sequence ----------------
  // Everything else is warmup traffic or ordinary mail, and is not ours.
  const addresses = [...touchesByAddress.keys()];
  const leads: Lead[] = [];

  // Chunked: PostgREST puts `in` values in the URL.
  for (let i = 0; i < addresses.length; i += 200) {
    const { data, error } = await supabase
      .from("leads")
      .select("id, work_email_norm, timezone")
      .eq("org_id", orgId)
      .in("work_email_norm", addresses.slice(i, i + 200))
      .is("archived_at", null)
      .is("halted_at", null)
      .is("terminal_outcome", null);
    if (error) throw new Error(`leads: ${error.message}`);
    leads.push(...((data ?? []) as Lead[]));
  }

  report.leads = leads.length;

  // --- record ----------------------------------------------------------------
  await pool(leads, 4, async (lead) => {
    const raw = touchesByAddress.get(lead.work_email_norm) ?? [];
    let outcome: string;
    let detail: string | null = null;

    if (new Set(raw.map((touch) => touch.mailbox_id)).size > 1) {
      // A thread lives in one account; recording both would pin the follow-up
      // to whichever sorted last, which is a guess.
      outcome = "conflict";
    } else {
      const { data, error } = await supabase.rpc("record_mailbox_touches", {
        p_lead_id: lead.id,
        p_touches: collapseToDays(raw, lead.timezone),
        // The sheet is history the one-off script already carried across.
        p_sheet_zone: null,
        p_dry_run: false,
      });
      const row = (data as { outcome: string; detail: string | null }[] | null)?.[0];
      outcome = error ? "error" : (row?.outcome ?? "error");
      detail = error?.message ?? row?.detail ?? null;
    }

    report.outcomes[outcome] = (report.outcomes[outcome] ?? 0) + 1;

    const message = NEEDS_A_PERSON[outcome];
    if (message) {
      await supabase.from("alerts").upsert(
        {
          org_id: orgId,
          kind: "pre_send_review",
          lead_id: lead.id,
          message: detail ? `${message} (${detail})` : message,
          // One alert per lead and reason, however many nights it recurs.
          dedupe_token: `reconcile:${lead.id}:${outcome}`,
          payload: { outcome, detail },
        },
        { onConflict: "org_id,kind,dedupe_token", ignoreDuplicates: true },
      );
    }
  });

  return report;
}

// ---------------------------------------------------------------------------

export async function POST(request: Request) {
  const denied = requireBearer(request, serverEnv().cronSecret);
  if (denied) return denied;

  const url = new URL(request.url);
  const requested = Number(url.searchParams.get("days"));
  const days =
    Number.isFinite(requested) && requested >= 1 && requested <= MAX_DAYS
      ? Math.floor(requested)
      : DEFAULT_DAYS;
  const sinceSeconds = Math.floor((Date.now() - days * 86_400_000) / 1000);

  const supabase = createAdminSupabase();

  // Paused mailboxes are read too. Pausing stops the APP sending from one; a
  // person can still write from it in Gmail, and that is what this is for.
  let query = supabase
    .from("mailboxes")
    .select("id, org_id, email")
    .is("disconnected_at", null)
    .order("email");

  // Optional scope, same reasoning as the other jobs: a test must never read
  // or write for an org it did not create.
  const onlyOrg = url.searchParams.get("org");
  if (onlyOrg) query = query.eq("org_id", onlyOrg);

  const { data: mailboxRows, error } = await query;
  if (error) return Response.json({ error: error.message }, { status: 500 });

  const byOrg = new Map<string, Mailbox[]>();
  for (const mailbox of (mailboxRows ?? []) as Mailbox[]) {
    const list = byOrg.get(mailbox.org_id) ?? [];
    list.push(mailbox);
    byOrg.set(mailbox.org_id, list);
  }

  const reports: OrgReport[] = [];
  for (const [orgId, mailboxes] of byOrg) {
    reports.push(await reconcileOrg(supabase, orgId, mailboxes, sinceSeconds));
  }

  return Response.json({ days, orgs: reports.length, reports });
}
