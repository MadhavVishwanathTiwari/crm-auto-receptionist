// Reading a mailbox. gmail.readonly only, and that is the whole point.
//
// Nothing in here can archive, label, or mark anything read, because the scope
// to do so was never requested. Instantly's warmup mail lives in these same
// mailboxes and has to keep sitting in the inbox untouched.

const API = "https://gmail.googleapis.com/gmail/v1/users/me";

export class GmailReadError extends Error {
  readonly status: number;
  /**
   * Gmail returns 404 when startHistoryId is older than the history it still
   * keeps (roughly a week). That is not a failure to recover from by retrying;
   * the cursor has to be re-baselined from the profile.
   */
  readonly historyExpired: boolean;

  constructor(message: string, status: number) {
    super(message);
    this.name = "GmailReadError";
    this.status = status;
    this.historyExpired = status === 404;
  }
}

async function get<T>(path: string, accessToken: string): Promise<T> {
  const response = await fetch(`${API}${path}`, {
    headers: { authorization: `Bearer ${accessToken}` },
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new GmailReadError(
      `gmail ${path.split("?")[0]} failed (${response.status}): ${detail.slice(0, 300)}`,
      response.status,
    );
  }

  return (await response.json()) as T;
}

export interface HistoryPage {
  /** Message ids added since the cursor, newest last. */
  messageIds: string[];
  /** The cursor to store for next time. */
  historyId: string;
  nextPageToken: string | null;
}

interface RawHistoryResponse {
  history?: {
    messagesAdded?: { message?: { id?: string; labelIds?: string[] } }[];
  }[];
  historyId?: string;
  nextPageToken?: string;
}

/**
 * What has arrived since `startHistoryId`.
 *
 * Only `messageAdded` is requested. labelAdded and labelRemoved would report
 * every change Instantly's warmup makes to its own mail, which is both noise
 * and a much larger page.
 */
export async function listHistory(input: {
  accessToken: string;
  startHistoryId: string;
  pageToken?: string | null;
}): Promise<HistoryPage> {
  const params = new URLSearchParams({
    startHistoryId: input.startHistoryId,
    historyTypes: "messageAdded",
    maxResults: "200",
  });
  if (input.pageToken) params.set("pageToken", input.pageToken);

  const payload = await get<RawHistoryResponse>(
    `/history?${params.toString()}`,
    input.accessToken,
  );

  const ids: string[] = [];
  for (const entry of payload.history ?? []) {
    for (const added of entry.messagesAdded ?? []) {
      const id = added.message?.id;
      // Our own outbound copy shows up here too. Skipping it early saves a
      // messages.get per send we already know about.
      const labels = added.message?.labelIds ?? [];
      if (id && !labels.includes("SENT")) ids.push(id);
    }
  }

  return {
    // A page may repeat an id across history records.
    messageIds: [...new Set(ids)],
    historyId: String(payload.historyId ?? input.startHistoryId),
    nextPageToken: payload.nextPageToken ?? null,
  };
}

export interface GmailMessage {
  id: string;
  threadId: string;
  labelIds: string[];
  /** Lowercased header names. Duplicates keep the first occurrence. */
  headers: Record<string, string>;
  /** Every text/plain part, concatenated. Empty when the mail is HTML only. */
  text: string;
  snippet: string;
}

interface RawPart {
  mimeType?: string;
  filename?: string;
  headers?: { name?: string; value?: string }[];
  body?: { data?: string; size?: number };
  parts?: RawPart[];
}

interface RawMessage {
  id?: string;
  threadId?: string;
  labelIds?: string[];
  snippet?: string;
  payload?: RawPart;
}

function decodePart(data: string): string {
  // Gmail returns base64url without padding.
  return Buffer.from(data, "base64url").toString("utf8");
}

function collectText(part: RawPart | undefined, out: string[]): void {
  if (!part) return;

  // A delivery-status report is the interesting content of a bounce, so it is
  // collected alongside text/plain rather than treated as an attachment.
  const mime = part.mimeType ?? "";
  const isText =
    mime.startsWith("text/plain") ||
    mime.startsWith("message/") ||
    mime.startsWith("text/rfc822-headers") ||
    mime === "message/delivery-status";

  if (isText && part.body?.data) out.push(decodePart(part.body.data));

  for (const child of part.parts ?? []) collectText(child, out);
}

export async function fetchMessage(
  accessToken: string,
  messageId: string,
): Promise<GmailMessage> {
  const raw = await get<RawMessage>(
    `/messages/${encodeURIComponent(messageId)}?format=full`,
    accessToken,
  );

  const headers: Record<string, string> = {};
  for (const header of raw.payload?.headers ?? []) {
    const name = header.name?.toLowerCase();
    if (name && headers[name] === undefined) headers[name] = header.value ?? "";
  }

  const parts: string[] = [];
  collectText(raw.payload, parts);

  return {
    id: raw.id ?? messageId,
    threadId: raw.threadId ?? "",
    labelIds: raw.labelIds ?? [],
    headers,
    text: parts.join("\n"),
    snippet: raw.snippet ?? "",
  };
}

/** Message-IDs referenced by this message, oldest first. */
export function referencedMessageIds(headers: Record<string, string>): string[] {
  const raw = `${headers["references"] ?? ""} ${headers["in-reply-to"] ?? ""}`;
  return [...raw.matchAll(/<[^>\s]+>/g)].map((match) => match[0]);
}

/** The bare address out of a `Name <a@b.c>` header. */
export function addressFromHeader(value: string | undefined): string | null {
  if (!value) return null;
  const angled = value.match(/<([^>]+)>/);
  const candidate = (angled ? angled[1] : value).trim();
  return candidate.includes("@") ? candidate : null;
}
