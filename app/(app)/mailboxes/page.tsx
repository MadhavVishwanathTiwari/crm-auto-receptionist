import { DateTime } from "luxon";

import { requireOrgContext } from "@/lib/org";
import { buildMailboxSenders } from "@/lib/scheduler/routing";

import { PAGE, PAGE_HEADER } from "../ui";
import { MailboxList, type MailboxRow } from "./MailboxList";

export const dynamic = "force-dynamic";

/**
 * The OAuth callback reports back through the query string, because it is a
 * redirect and has nowhere else to put a message. Every one of these is a real
 * thing that happens rather than a defensive catch-all, so each gets a sentence
 * that says what to do next.
 */
const ERRORS: Record<string, string> = {
  access_denied: "You declined at the Google consent screen, so nothing changed.",
  google_not_configured:
    "GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET are not set on this deployment.",
  state_mismatch:
    "That sign-in did not come back the way it left, so it was refused. This " +
    "happens if you started the connection on a different address than the one " +
    "you landed on, or left the consent screen open for more than half an hour. " +
    "Start it again from this page.",
  no_code: "Google sent us back without an authorization code. Try again.",
  no_refresh_token:
    "Google returned no refresh token, so this mailbox could send for an hour and then stop. " +
    "That usually means the consent screen is in External/Testing mode rather than Internal.",
  partial_scopes:
    "Not all the permissions were granted. Sending needs both gmail.send and gmail.readonly.",
  grant_revoked: "That Google grant has been revoked. Connect it again.",
  bad_address: "Google reported an address we could not read.",
  lookup_failed: "Could not check whether that mailbox was already connected.",
  create_failed: "Could not create the mailbox row.",
  reconnect_failed: "Could not update the existing mailbox.",
  secret_write_failed: "Could not store the refresh token, so nothing was connected.",
  google_error: "Google refused the exchange. Try again.",
  unexpected: "Something went wrong connecting that mailbox.",
};

export default async function MailboxesPage({
  searchParams,
}: {
  searchParams: Promise<{ connected?: string; error?: string }>;
}) {
  const { supabase, userId } = await requireOrgContext();
  const { connected, error: errorCode } = await searchParams;

  const [{ data: mailboxRows, error }, { data: senderRows }] = await Promise.all([
    supabase
      .from("mailboxes")
      .select(
        "id, user_id, email, display_name, timezone, daily_cap, paused_at, disconnected_at, last_send_at, last_polled_at",
      )
      .order("created_at", { ascending: true }),
    supabase.rpc("mailbox_senders"),
  ]);

  const mailboxes = mailboxRows ?? [];

  // Not `user_id === userId`. One human here holds two accounts -- one
  // connected the mailbox, the other owns the leads -- so a strict comparison
  // labels his own mailbox as somebody else's. Resolved in SQL against
  // app.operator_aliases, the same way the send path decides it.
  const senders = buildMailboxSenders(
    (senderRows ?? []) as { mailbox_id: string; user_id: string }[],
  );

  // Usage is counted against cap_date, which the claimer stamps from the
  // MAILBOX's timezone. Reading it back the same way is the only way the number
  // on screen matches the number the cap is enforced against.
  const todayByMailbox = new Map<string, string>();
  for (const mailbox of mailboxes) {
    todayByMailbox.set(
      mailbox.id as string,
      DateTime.now().setZone(mailbox.timezone as string).toISODate() ?? "",
    );
  }

  const dates = [...new Set(todayByMailbox.values())].filter(Boolean);

  const { data: usageRows } = dates.length
    ? await supabase
        .from("scheduled_sends")
        .select("mailbox_id, cap_date")
        .in("status", ["claimed", "sending", "sent"])
        .in("cap_date", dates)
    : { data: [] };

  const used = new Map<string, number>();
  for (const row of usageRows ?? []) {
    const mailboxId = row.mailbox_id as string | null;
    if (!mailboxId) continue;
    if (todayByMailbox.get(mailboxId) !== row.cap_date) continue;
    used.set(mailboxId, (used.get(mailboxId) ?? 0) + 1);
  }

  const rows: MailboxRow[] = mailboxes.map((mailbox) => ({
    id: mailbox.id as string,
    email: mailbox.email as string,
    display_name: mailbox.display_name as string | null,
    timezone: mailbox.timezone as string,
    daily_cap: mailbox.daily_cap as number,
    paused_at: mailbox.paused_at as string | null,
    disconnected_at: mailbox.disconnected_at as string | null,
    last_send_at: mailbox.last_send_at as string | null,
    last_polled_at: mailbox.last_polled_at as string | null,
    used_today: used.get(mailbox.id as string) ?? 0,
    is_mine: senders.get(mailbox.id as string)?.has(userId) ?? false,
  }));

  const notice = errorCode
    ? {
        kind: "error" as const,
        text: ERRORS[errorCode] ?? `Google reported: ${errorCode}`,
      }
    : connected
      ? { kind: "connected" as const, text: `Connected ${connected}.` }
      : null;

  return (
    <div className={PAGE}>
      <header className={PAGE_HEADER}>
        <h1 className="text-[var(--color-ink)]">Mailboxes</h1>
        <span className="ml-auto text-[var(--color-ink-3)]">
          Caps reset in the mailbox&rsquo;s own timezone, not the prospect&rsquo;s.
        </span>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {error ? (
          <p role="alert" className="px-4 py-6 text-[var(--color-danger)]">
            Could not load mailboxes: {error.message}
          </p>
        ) : (
          <MailboxList rows={rows} notice={notice} />
        )}
      </div>
    </div>
  );
}
