import { describe, expect, it } from "vitest";

import { newText } from "@/lib/gmail/classify";
import {
  findMessage,
  humanRepliedAfter,
  newerInboundAfter,
  transcriptFor,
  type ThreadMessage,
} from "@/lib/gmail/threadState";

function message(
  id: string,
  at: number,
  outbound: boolean,
  text = "",
): ThreadMessage {
  return {
    id,
    labelIds: outbound ? ["SENT"] : ["INBOX"],
    internalDate: String(at),
    headers: { subject: "Re: the calls that ring out" },
    text,
  };
}

describe("humanRepliedAfter", () => {
  const inbound = message("them-1", 1000, false);

  it("is true when something left the mailbox after their message", () => {
    const thread = [message("us-1", 500, true), inbound, message("us-2", 2000, true)];
    expect(humanRepliedAfter(thread, "them-1")).toBe(true);
  });

  it("is false when the only outbound message is the one they answered", () => {
    expect(humanRepliedAfter([message("us-1", 500, true), inbound], "them-1")).toBe(
      false,
    );
  });

  it("is false when nothing has been sent at all", () => {
    expect(humanRepliedAfter([inbound], "them-1")).toBe(false);
  });

  it("is false for a message that is no longer in the thread", () => {
    expect(humanRepliedAfter([message("us-1", 9000, true)], "them-1")).toBe(false);
  });

  it("does not count an outbound message at the same instant", () => {
    // Equal timestamps mean Gmail recorded both in the same millisecond, which
    // for an inbound and an outbound does not happen. Reading equal as
    // "answered" would make the assistant skip one it should have taken.
    expect(humanRepliedAfter([inbound, message("us-2", 1000, true)], "them-1")).toBe(
      false,
    );
  });
});

describe("newerInboundAfter", () => {
  it("is true when they wrote again", () => {
    const thread = [message("them-1", 1000, false), message("them-2", 1500, false)];
    expect(newerInboundAfter(thread, "them-1")).toBe(true);
  });

  it("does not count the message itself", () => {
    expect(newerInboundAfter([message("them-1", 1000, false)], "them-1")).toBe(false);
  });

  it("does not count our own reply", () => {
    const thread = [message("them-1", 1000, false), message("us-1", 2000, true)];
    expect(newerInboundAfter(thread, "them-1")).toBe(false);
  });
});

describe("transcriptFor", () => {
  const options = { limit: 3, maxChars: 40, stripQuotes: newText };

  it("keeps the newest messages, oldest first", () => {
    const thread = [
      message("a", 1, true, "one"),
      message("b", 2, false, "two"),
      message("c", 3, true, "three"),
      message("d", 4, false, "four"),
    ];
    expect(transcriptFor(thread, options).map((entry) => entry.text)).toEqual([
      "two",
      "three",
      "four",
    ]);
  });

  it("labels each side", () => {
    const thread = [message("a", 1, true, "ours"), message("b", 2, false, "theirs")];
    expect(transcriptFor(thread, options).map((e) => e.direction)).toEqual([
      "us",
      "them",
    ]);
  });

  it("cuts the quoted history off, so the model reads what they wrote", () => {
    const quoted =
      "Yes please, send a time.\n\nOn Tue, Madhav wrote:\n> the original email";
    const [entry] = transcriptFor([message("b", 2, false, quoted)], options);
    expect(entry.text).toBe("Yes please, send a time.");
  });

  it("truncates a long message rather than spending the context on it", () => {
    const [entry] = transcriptFor([message("b", 2, false, "x".repeat(200))], options);
    expect(entry.text).toContain("truncated");
    expect(entry.text.length).toBeLessThan(80);
  });
});

describe("findMessage", () => {
  it("returns null when it is gone", () => {
    expect(findMessage([message("a", 1, false)], "b")).toBeNull();
  });
});
