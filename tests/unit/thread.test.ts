import { describe, expect, it } from "vitest";

import { replySubject } from "@/lib/gmail/thread";

describe("a follow-up's subject", () => {
  it("is Re: and the thread's subject, whatever the template said", () => {
    // The pair production actually sent: T1 by hand, T2 from a template, two
    // threads in the prospect's inbox.
    expect(replySubject("Gabriel, built you something")).toBe(
      "Re: Gabriel, built you something",
    );
  });

  it("collapses a stack of prefixes instead of growing one", () => {
    expect(replySubject("Re: RE: Fwd: Clear Air")).toBe("Re: Clear Air");
    expect(replySubject("Re[2]: Clear Air")).toBe("Re: Clear Air");
  });

  it("leaves a subject that is nothing but a prefix alone", () => {
    expect(replySubject("Re:")).toBe("Re:");
  });
});
