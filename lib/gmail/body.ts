// What a body becomes on the wire.
//
// A body is plain text with exactly one piece of markup, a link with words on
// it: `[hear it for yourself](https://…)`. It goes out as two parts, that text
// and an HTML rendering of it, which is what Gmail's own composer sends for an
// email somebody typed. The HTML is the same words and nothing else: no
// styling, no images, no tracking pixel, no redirect on the link. The plain
// part keeps the address beside the words, so a client that shows it loses
// nothing.
//
// Only an http(s) address becomes a link. `[demo](demo.site/x)` is left as
// typed in both parts; brokenLinks() is how a written email refuses that before
// it goes out with the brackets showing.
//
// No imports, so anything can use it, the browser included.

const LINK = /\[([^\]\n]+)\]\((https?:\/\/[^\s()<>]+)\)/;
const BARE_URL = /https?:\/\/[^\s<>"]+/;
const TOKEN = new RegExp(`${LINK.source}|${BARE_URL.source}`, "g");

/** Anything shaped like a link whose address is not a whole http(s) URL. */
const LINK_SHAPED = /\[([^\]\n]+)\]\(([^)\n]*)\)/g;
const WHOLE_URL = /^https?:\/\/[^\s()<>]+$/;

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function anchor(href: string, text: string): string {
  return `<a href="${escapeHtml(href)}">${escapeHtml(text)}</a>`;
}

/**
 * A bare URL at the end of a sentence carries the full stop with it. Clients
 * drop it from the link, so this does too; a closing bracket only when the URL
 * never opened one.
 */
function splitTrailing(url: string): [string, string] {
  let cut = url.length;
  while (cut > 0) {
    const last = url[cut - 1]!;
    const bracket = last === ")" && !url.slice(0, cut).includes("(");
    if (!".,;:!?'\"".includes(last) && !bracket) break;
    cut -= 1;
  }
  return [url.slice(0, cut), url.slice(cut)];
}

function lineToHtml(line: string): string {
  let out = "";
  let last = 0;
  for (const match of line.matchAll(TOKEN)) {
    const at = match.index ?? 0;
    out += escapeHtml(line.slice(last, at));
    if (match[1] !== undefined && match[2] !== undefined) {
      out += anchor(match[2], match[1]);
    } else {
      const [url, trailing] = splitTrailing(match[0]);
      out += anchor(url, url) + escapeHtml(trailing);
    }
    last = at + match[0].length;
  }
  return out + escapeHtml(line.slice(last));
}

/** The text/plain part: every link written out as its words and its address. */
export function toPlainText(body: string): string {
  return body.replace(new RegExp(LINK.source, "g"), (_match, text: string, url: string) =>
    text.trim() === url ? url : `${text} (${url})`,
  );
}

/**
 * The text/html part, shaped the way Gmail's composer shapes a typed email: a
 * div per line and an empty one for a blank line, so it renders exactly as the
 * plain text reads.
 */
export function toHtml(body: string): string {
  const lines = body.replace(/\r\n?/g, "\n").split("\n");
  const inner = lines
    .map((line) => (line.trim() === "" ? "<div><br></div>" : `<div>${lineToHtml(line)}</div>`))
    .join("");
  return `<div dir="ltr">${inner}</div>`;
}

/**
 * Every address that becomes a live link when this body goes out.
 *
 * Both shapes, because toHtml() anchors both: the `[words](address)` form and a
 * bare `https://…` sitting in the prose. A guard that only read the bracket
 * form would pass `just go to https://wherever` and then send it as a link.
 *
 * Here rather than in the caller so there is one definition of "what counts as
 * a link", the same argument that keeps the capacity arithmetic in book.ts.
 */
export function linkedUrls(body: string): string[] {
  const urls: string[] = [];
  for (const match of body.matchAll(new RegExp(TOKEN.source, "g"))) {
    // Group 2 is the bracket form's address; no group means a bare URL.
    urls.push(match[2] ?? match[0]);
  }
  return urls;
}

/** Every `[words](address)` whose address would not become a link. */
export function brokenLinks(body: string): string[] {
  const broken: string[] = [];
  for (const match of body.matchAll(LINK_SHAPED)) {
    if (!WHOLE_URL.test(match[2]!)) broken.push(match[0]);
  }
  return broken;
}
