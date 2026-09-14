import { describe, expect, it } from "vitest";

import { replySubject } from "@/lib/gmail/thread";
import { replySubjectFor, type WriteSend } from "@/lib/write/context";

function send(
  step: number,
  thread: string | null,
  subject: string | null,
  status = "sent",
): WriteSend {
  return {
    id: `s${step}-${status}`,
    lead_id: "lead",
    mailbox_id: "mb",
    step_number: step,
    status,
    scheduled_at: "2026-09-15T11:41:00Z",
    sent_at: status === "sent" ? "2026-09-15T11:41:05Z" : null,
    provider_thread_id: thread,
    rendered_subject: subject,
    composed_body: null,
    composed_subject: null,
  };
}

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

// What /write locks the subject box to. dispatch-sends derives the same thing
// inline, so these are also the cases a follow-up's thread depends on.
describe("which subject a lead's next follow-up replies to", () => {
  it("is the opening subject of the thread T1 started", () => {
    expect(replySubjectFor([send(1, "t1", "Gabriel, built you something")])).toBe(
      "Re: Gabriel, built you something",
    );
  });

  it("stays on T1's subject once a follow-up has already replied in the thread", () => {
    expect(
      replySubjectFor([
        send(2, "t1", "Re: Gabriel, built you something"),
        send(1, "t1", "Gabriel, built you something"),
      ]),
    ).toBe("Re: Gabriel, built you something");
  });

  it("follows the newer thread when an old follow-up already split it", () => {
    // The 14 leads whose app follow-up opened a new conversation: the prospect
    // is now reading the newer one, so that is the one to continue.
    expect(
      replySubjectFor([
        send(1, "t1", "Gabriel, built you something"),
        send(2, "t2", "Re: how Clear Air answered on Tuesday"),
      ]),
    ).toBe("Re: how Clear Air answered on Tuesday");
  });

  it("has nothing to reply to without a thread (the sheet's history)", () => {
    expect(replySubjectFor([send(1, null, null), send(2, null, null)])).toBeNull();
  });

  it("has nothing to reply to when the thread's subject was never recorded", () => {
    expect(replySubjectFor([send(1, "t1", null)])).toBeNull();
  });

  it("ignores anything that did not go out", () => {
    expect(
      replySubjectFor([
        send(1, "t1", "E2E composer test v2"),
        send(2, "t9", "Quick follow-up", "cancelled"),
        send(2, null, null, "planned"),
      ]),
    ).toBe("Re: E2E composer test v2");
  });
});
