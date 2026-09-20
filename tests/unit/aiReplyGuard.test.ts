import { describe, expect, it } from "vitest";

import { checkDraft } from "@/lib/ai/reply/guard";

const LIMITS = {
  bookingUrl: "https://cal.com/madhav/intro",
  demoUrl: "https://autoreceptionist.io/sandbox/brightsmile",
  mailboxEmail: "madhav@autoreceptionist.io",
};

describe("checkDraft", () => {
  it("passes an ordinary reply with the booking link", () => {
    const body =
      "Happy to walk you through it.\n\n" +
      "Grab whatever slot suits: [book a time](https://cal.com/madhav/intro)\n\n" +
      "Madhav's assistant";
    expect(checkDraft(body, LIMITS)).toEqual({ ok: true });
  });

  it("passes this lead's own demo link", () => {
    const body =
      "Here it is: [listen to it](https://autoreceptionist.io/sandbox/brightsmile)";
    expect(checkDraft(body, LIMITS).ok).toBe(true);
  });

  it("refuses a link the model invented", () => {
    const body = "Pricing is here: [our plans](https://autoreceptionist.io/pricing)";
    const result = checkDraft(body, LIMITS);
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toContain("pricing");
  });

  it("refuses a BARE url, which toHtml would anchor just the same", () => {
    // The whole reason linkedUrls() reads both shapes. A guard that only knew
    // the bracket form would pass this and then send a live link.
    const body = "Have a look at https://some-other-site.example and tell me.";
    expect(checkDraft(body, LIMITS).ok).toBe(false);
  });

  it("ignores trailing punctuation and a trailing slash when matching", () => {
    const body = "Book here: https://cal.com/madhav/intro.";
    expect(checkDraft(body, LIMITS).ok).toBe(true);
  });

  it("refuses the demo link when this lead has no demo", () => {
    const body = "[hear it](https://autoreceptionist.io/sandbox/brightsmile)";
    expect(checkDraft(body, { ...LIMITS, demoUrl: null }).ok).toBe(false);
  });

  it("refuses a link whose address is not a whole https url", () => {
    const body = "[book a time](cal.com/madhav)";
    const result = checkDraft(body, LIMITS);
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toContain("https://");
  });

  it("refuses an email address that is not the sending mailbox", () => {
    const body = "Write to support@autoreceptionist.io and they will sort it.";
    const result = checkDraft(body, LIMITS);
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toContain("support@");
  });

  it("allows the sending mailbox's own address", () => {
    const body = "Just reply here, or to madhav@autoreceptionist.io directly.";
    expect(checkDraft(body, LIMITS).ok).toBe(true);
  });

  it("refuses a leftover template variable", () => {
    const body = "Thanks {{first_name}}, I will send that over.";
    const result = checkDraft(body, LIMITS);
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toContain("{{first_name}}");
  });

  it("refuses an empty body", () => {
    expect(checkDraft("   \n  ", LIMITS).ok).toBe(false);
  });

  it("refuses a body longer than a reply has any business being", () => {
    const result = checkDraft("a".repeat(1501), LIMITS);
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toContain("1501");
  });
});
