// Getting a reply onto a phone.
//
// A reply to cold outbound is worth minutes, not hours, and the alerts screen
// only helps somebody already looking at it. This is the part that interrupts.
//
// Telegram first because it costs nothing, delivers reliably on both phones,
// needs no PWA install dance (which is what rules out Web Push on iOS), and
// carries a tappable link back to the lead. ntfy is the runner-up and needs no
// account at all, so both are supported and either, both or neither may be
// configured.
//
// Three rules, all of them load-bearing:
//
//   * Unconfigured is a no-op, not an error. This has to be safe to deploy
//     before anybody has made a bot.
//   * Nothing here throws. A push failure must never fail the poll that found
//     the reply: the alert row is already written, and losing the poller's
//     cursor update to a Telegram outage would re-scan the mailbox instead.
//   * It is called only for alerts that were newly INSERTED. The poller upserts
//     on (org, kind, dedupe_token) and re-reads overlapping history pages, so
//     pushing on every seen row would buzz twice for one reply.

interface PushInput {
  title: string;
  body: string;
  /** Deep link back to the lead. Absolute, or the phone cannot open it. */
  url?: string | null;
}

function config() {
  return {
    telegramToken: process.env.TELEGRAM_BOT_TOKEN?.trim() ?? "",
    telegramChatIds: (process.env.TELEGRAM_CHAT_IDS ?? "")
      .split(",")
      .map((id) => id.trim())
      .filter(Boolean),
    ntfyTopic: process.env.NTFY_TOPIC?.trim() ?? "",
    ntfyServer: (process.env.NTFY_SERVER ?? "https://ntfy.sh").replace(/\/+$/, ""),
  };
}

export function pushIsConfigured(): boolean {
  const { telegramToken, telegramChatIds, ntfyTopic } = config();
  return (telegramToken !== "" && telegramChatIds.length > 0) || ntfyTopic !== "";
}

async function sendTelegram(
  token: string,
  chatId: string,
  input: PushInput,
): Promise<void> {
  const text = input.url
    ? `${input.title}\n${input.body}\n\n${input.url}`
    : `${input.title}\n${input.body}`;

  await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    // Plain text, no parse_mode: a prospect's reply is arbitrary text, and
    // Markdown parsing turns an unmatched underscore in their signature into a
    // 400 that silently drops the notification.
    body: JSON.stringify({
      chat_id: chatId,
      text,
      disable_web_page_preview: true,
    }),
  });
}

async function sendNtfy(
  server: string,
  topic: string,
  input: PushInput,
): Promise<void> {
  const headers: Record<string, string> = {
    // Header values are latin-1 over HTTP. A prospect's name with an accent in
    // it would make the whole request unsendable, so the title is transliterated
    // down to ASCII here rather than risking the send.
    Title: input.title.replace(/[^\x20-\x7e]/g, "?"),
  };
  if (input.url) headers["Click"] = input.url;

  await fetch(`${server}/${topic}`, {
    method: "POST",
    headers,
    body: input.body,
  });
}

/**
 * Fire and forget, with the failure swallowed and logged.
 *
 * Awaited by the caller rather than left dangling: a serverless function that
 * returns before its fetch resolves has its execution frozen, and the
 * notification simply never leaves.
 */
export async function pushAlert(input: PushInput): Promise<boolean> {
  const { telegramToken, telegramChatIds, ntfyTopic, ntfyServer } = config();
  const sends: Promise<void>[] = [];

  if (telegramToken && telegramChatIds.length > 0) {
    for (const chatId of telegramChatIds) {
      sends.push(sendTelegram(telegramToken, chatId, input));
    }
  }
  if (ntfyTopic) sends.push(sendNtfy(ntfyServer, ntfyTopic, input));

  if (sends.length === 0) return false;

  const results = await Promise.allSettled(sends);
  for (const result of results) {
    if (result.status === "rejected") {
      console.error("push notification failed:", result.reason);
    }
  }

  return results.some((result) => result.status === "fulfilled");
}
