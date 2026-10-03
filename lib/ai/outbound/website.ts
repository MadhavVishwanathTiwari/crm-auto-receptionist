// Reading a prospect's website, which is the whole of what makes a first touch
// written by the assistant better than a template.
//
// Fetched here rather than through a model's own web tool, because the reply
// model is reached through OpenRouter and server tools are a provider feature,
// and because a page read in TypeScript is a page we can bound: one request,
// a size cap, a timeout, http(s) only and no private addresses. What comes back
// is untrusted text written by somebody else, so it goes to the model as data,
// and the guard binds the output whatever the page said.
//
// `pageText()` is pure and is the part worth testing.

/** What reaches the prompt. A home page says what it is in far less. */
export const MAX_WEBSITE_CHARS = 6000;

const MAX_BYTES = 600_000;
const TIMEOUT_MS = 10_000;
const MAX_REDIRECTS = 3;

// An ordinary browser's. Small-business hosts behind a bot filter answer 403
// to anything that names itself, and this reads one public home page once, the
// same page a person deciding whether to email them would open.
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  rsquo: "'",
  lsquo: "'",
  rdquo: '"',
  ldquo: '"',
  ndash: "-",
  mdash: "-",
  hellip: "...",
};

function decodeEntities(text: string): string {
  return text.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (whole, code: string) => {
    if (code[0] === "#") {
      const n = code[1]?.toLowerCase() === "x" ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : " ";
    }
    return ENTITIES[code.toLowerCase()] ?? whole;
  });
}

/**
 * The words a person would read on the page: title, meta description, and the
 * body text with scripts, styles, navigation chrome and markup removed.
 */
export function pageText(html: string, maxChars = MAX_WEBSITE_CHARS): string {
  const title = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? "";
  const description =
    html.match(/<meta[^>]+name=["']description["'][^>]*content=["']([^"']*)["']/i)?.[1] ??
    html.match(/<meta[^>]+content=["']([^"']*)["'][^>]*name=["']description["']/i)?.[1] ??
    "";

  const body = html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|noscript|svg|template|iframe|head)\b[\s\S]*?<\/\1>/gi, " ")
    .replace(/<(br|p|div|li|h[1-6]|tr|section|article|header|footer)\b[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, " ");

  const lines = decodeEntities(body)
    .split("\n")
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter((line) => line.length > 1);

  // Menus and footers repeat on every section; a line seen twice is chrome.
  const seen = new Set<string>();
  const unique = lines.filter((line) => {
    const key = line.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  const head = [decodeEntities(title).trim(), decodeEntities(description).trim()]
    .filter(Boolean)
    .join("\n");

  const text = [head, unique.join("\n")].filter(Boolean).join("\n\n");
  return text.length > maxChars ? `${text.slice(0, maxChars)}\n[cut]` : text;
}

/**
 * Whether a URL may be fetched at all. http(s), a real hostname, and nothing
 * that names this machine or a private network: `leads.website` is imported
 * data, and a server that fetches whatever a CSV says is an SSRF waiting for a
 * CSV that says `http://169.254.169.254/`.
 */
export function fetchableUrl(raw: string): URL | null {
  let url: URL;
  try {
    url = new URL(/^https?:\/\//i.test(raw.trim()) ? raw.trim() : `https://${raw.trim()}`);
  } catch {
    return null;
  }

  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  if (url.username || url.password) return null;
  if (url.port && url.port !== "80" && url.port !== "443") return null;

  const host = url.hostname.toLowerCase();
  if (!host.includes(".")) return null;
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) return null;
  if (host.endsWith(".internal")) return null;
  // Any IP literal. A business's website has a name.
  if (/^\d+(\.\d+){3}$/.test(host) || host.startsWith("[")) return null;

  return url;
}

export type WebsiteRead =
  | { ok: true; url: string; text: string }
  | { ok: false; reason: string };

export async function readWebsite(raw: string | null): Promise<WebsiteRead> {
  if (!raw?.trim()) return { ok: false, reason: "the lead has no website" };

  const first = fetchableUrl(raw);
  if (!first) return { ok: false, reason: `${raw} is not an address the assistant will fetch` };
  let url: URL = first;

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    let response: Response;
    try {
      response = await fetch(url, {
        redirect: "manual",
        signal: AbortSignal.timeout(TIMEOUT_MS),
        headers: {
          "user-agent": USER_AGENT,
          accept: "text/html,application/xhtml+xml",
          "accept-language": "en-US,en;q=0.9",
        },
      });
    } catch (error) {
      return {
        ok: false,
        reason: `${url.hostname} did not answer (${error instanceof Error ? error.name : "error"})`,
      };
    }

    // Each hop is checked again: a redirect is where an allowed host hands
    // over to one that is not.
    if (response.status >= 300 && response.status < 400) {
      const next = response.headers.get("location");
      const resolved: URL | null = next ? fetchableUrl(new URL(next, url).toString()) : null;
      if (!resolved) return { ok: false, reason: `${url.hostname} redirects somewhere it will not follow` };
      url = resolved;
      continue;
    }

    if (!response.ok) return { ok: false, reason: `${url.hostname} answered ${response.status}` };

    const type = response.headers.get("content-type") ?? "";
    if (!/text\/html|application\/xhtml/i.test(type)) {
      return { ok: false, reason: `${url.hostname} is not an HTML page` };
    }

    const html = await readCapped(response);
    const text = pageText(html);
    if (text.length < 80) {
      // A page that renders entirely in JavaScript reads as nothing here. That
      // is a site the assistant cannot see, not a business with nothing to say.
      return { ok: false, reason: `${url.hostname} has almost no readable text without JavaScript` };
    }

    return { ok: true, url: url.toString(), text };
  }

  return { ok: false, reason: `${url.hostname} redirects too many times` };
}

async function readCapped(response: Response): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  while (total < MAX_BYTES) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.byteLength;
  }
  await reader.cancel().catch(() => undefined);

  return new TextDecoder("utf-8", { fatal: false }).decode(Buffer.concat(chunks).subarray(0, MAX_BYTES));
}
