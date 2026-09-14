import { describe, expect, it } from "vitest";

import { brokenLinks, toHtml, toPlainText } from "@/lib/gmail/body";

describe("a link with words on it", () => {
  const body = "I built one:\n\n[hear it for yourself](https://demo.test/joes?x=1&y=2)\n\nJo";

  it("becomes an anchor in HTML, with the address escaped", () => {
    expect(toHtml(body)).toBe(
      '<div dir="ltr"><div>I built one:</div><div><br></div>' +
        '<div><a href="https://demo.test/joes?x=1&amp;y=2">hear it for yourself</a></div>' +
        "<div><br></div><div>Jo</div></div>",
    );
  });

  it("keeps the address beside the words in plain text", () => {
    expect(toPlainText(body)).toBe(
      "I built one:\n\nhear it for yourself (https://demo.test/joes?x=1&y=2)\n\nJo",
    );
  });

  it("does not repeat an address used as its own words", () => {
    expect(toPlainText("[https://a.test](https://a.test)")).toBe("https://a.test");
  });

  it("never links anything but http(s)", () => {
    const hostile = "[click](javascript:alert(1)) [x](demo.test/joes)";
    expect(toHtml(hostile)).not.toContain("<a");
    expect(toPlainText(hostile)).toBe(hostile);
    expect(brokenLinks(hostile)).toEqual(["[click](javascript:alert(1)", "[x](demo.test/joes)"]);
  });

  it("finds nothing broken in a body without links or with good ones", () => {
    expect(brokenLinks(body)).toEqual([]);
    expect(brokenLinks("No links. [Just brackets] and (parens).")).toEqual([]);
  });
});

describe("everything else in the HTML", () => {
  it("links a bare address and leaves the full stop after it outside", () => {
    expect(toHtml("See https://demo.test/joes.")).toBe(
      '<div dir="ltr"><div>See <a href="https://demo.test/joes">https://demo.test/joes</a>.</div></div>',
    );
  });

  it("escapes what a prospect's company name could smuggle in", () => {
    expect(toHtml('Hi <b>"Joe & Sons"</b>')).toBe(
      '<div dir="ltr"><div>Hi &lt;b&gt;&quot;Joe &amp; Sons&quot;&lt;/b&gt;</div></div>',
    );
  });

  it("reads CRLF the same as LF", () => {
    expect(toHtml("a\r\n\r\nb")).toBe(toHtml("a\n\nb"));
  });
});
