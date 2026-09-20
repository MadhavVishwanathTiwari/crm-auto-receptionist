import { afterEach, describe, expect, it, vi } from "vitest";

import { classifyInbound, newText } from "@/lib/gmail/classify";
import {
  addressFromHeader,
  fetchThread,
  referencedMessageIds,
} from "@/lib/gmail/messages";
import { buildAuthUrl, GMAIL_SCOPES, grantIsComplete } from "@/lib/gmail/oauth";
import { buildMimeMessage, generateMessageId, sendMessage } from "@/lib/gmail/send";

function inbound(overrides: {
  headers?: Record<string, string>;
  text?: string;
  labelIds?: string[];
  snippet?: string;
}) {
  return {
    labelIds: overrides.labelIds ?? ["INBOX"],
    headers: overrides.headers ?? {},
    text: overrides.text ?? "",
    snippet: overrides.snippet ?? "",
  };
}

describe("the OAuth grant", () => {
  it("asks for send and read, and never for modify", () => {
    // Instantly's warmup mail lives in these mailboxes. Without the scope the
    // app cannot archive, label or mark it read even if something tried to.
    expect(GMAIL_SCOPES).toEqual([
      "https://www.googleapis.com/auth/gmail.send",
      "https://www.googleapis.com/auth/gmail.readonly",
    ]);
    expect(GMAIL_SCOPES.join(" ")).not.toContain("gmail.modify");
  });

  it("asks offline, forces consent, and always offers the account chooser", () => {
    const url = new URL(
      buildAuthUrl({
        clientId: "client-123",
        redirectUri: "https://ops.example.test/api/auth/google/callback",
        state: "abc",
      }),
    );

    // Without the first two, Google hands back a refresh token exactly once per
    // account and silently omits it on every reconnect after that.
    expect(url.searchParams.get("access_type")).toBe("offline");
    const prompt = (url.searchParams.get("prompt") ?? "").split(" ");
    expect(prompt).toContain("consent");

    // And without this one, Google silently uses whichever account the browser
    // is already signed into. Connecting the wrong mailbox picks the address
    // every subsequent cold email goes out from.
    expect(prompt).toContain("select_account");

    expect(url.searchParams.get("include_granted_scopes")).toBe("false");
    expect(url.searchParams.get("state")).toBe("abc");
  });

  it("refuses a partial grant", () => {
    expect(grantIsComplete(GMAIL_SCOPES.join(" "))).toBe(true);
    expect(grantIsComplete("https://www.googleapis.com/auth/gmail.send")).toBe(false);
  });
});

describe("building a message", () => {
  const base = {
    from: { name: "Ojas", email: "ojas@tryautoreceptionist.com" },
    to: { name: "Dana Reyes", email: "dana@brightsmile.test" },
    subject: "Your Tuesday text went unanswered",
    body: "Hi Dana,\n\nWorth a look, or should I close the file?\n",
    messageId: "<abc@tryautoreceptionist.com>",
  };

  /** Each part's decoded text, keyed by its content type. */
  function parts(raw: string): Record<string, string> {
    const boundary = raw.match(/boundary="([^"]+)"/)![1]!;
    const out: Record<string, string> = {};
    for (const chunk of raw.split(`--${boundary}`).slice(1, -1)) {
      const [head, encoded] = chunk.split("\r\n\r\n");
      const type = head!.match(/Content-Type: ([^;]+)/)![1]!;
      out[type] = Buffer.from(encoded!.replace(/\r\n/g, ""), "base64").toString("utf8");
    }
    return out;
  }

  it("sends plain text and HTML, both base64, the plain text first", () => {
    const raw = buildMimeMessage(base);
    const [headers] = raw.split("\r\n\r\n");

    // The display name is quoted, so a comma or a full stop in it cannot be
    // read as an address separator.
    expect(headers).toContain('To: "Dana Reyes" <dana@brightsmile.test>');
    expect(headers).toContain("Content-Type: multipart/alternative;");
    expect(raw).not.toMatch(/\r\n(?!\r\n)[^\r]*\n/); // no bare LF anywhere

    const decoded = parts(raw);
    expect(Object.keys(decoded)).toEqual(["text/plain", "text/html"]);
    expect(decoded["text/plain"]).toContain("Worth a look, or should I close the file?");
    expect(decoded["text/html"]).toContain("<div>Worth a look, or should I close the file?</div>");
  });

  it("gives a link its words in HTML and keeps the address beside them in plain text", () => {
    const decoded = parts(
      buildMimeMessage({
        ...base,
        body: "You can [hear it for yourself](https://demo.test/brightsmile) now.",
      }),
    );
    expect(decoded["text/html"]).toContain(
      '<a href="https://demo.test/brightsmile">hear it for yourself</a>',
    );
    expect(decoded["text/plain"]).toBe(
      "You can hear it for yourself (https://demo.test/brightsmile) now.",
    );
  });

  it("carries no image, style or tracking of any kind", () => {
    const html = parts(buildMimeMessage(base))["text/html"]!;
    expect(html).not.toMatch(/<img|<style|style=|<script/i);
  });

  it("RFC 2047 encodes a subject that is not plain ASCII", () => {
    // A raw UTF-8 subject header renders as mojibake, and the subject is the
    // first thing the prospect sees.
    const raw = buildMimeMessage({ ...base, subject: "Café Lumière missed a call" });
    expect(raw).toContain("Subject: =?UTF-8?B?");
    expect(raw).not.toContain("Subject: Café");
  });

  it("threads a follow-up onto the previous touch", () => {
    const raw = buildMimeMessage({
      ...base,
      messageId: "<second@tryautoreceptionist.com>",
      inReplyTo: "<first@tryautoreceptionist.com>",
      references: ["<first@tryautoreceptionist.com>"],
    });

    expect(raw).toContain("In-Reply-To: <first@tryautoreceptionist.com>");
    // The chain, de-duplicated, oldest first.
    expect(raw).toContain("References: <first@tryautoreceptionist.com>");
    expect(raw.match(/<first@tryautoreceptionist\.com>/g)).toHaveLength(2);
  });

  it("mints a Message-ID on the sending mailbox's own domain", () => {
    const id = generateMessageId("ojas@tryautoreceptionist.com");
    expect(id).toMatch(/^<[0-9a-f-]+@tryautoreceptionist\.com>$/);
  });
});

describe("what a send records", () => {
  const message = {
    from: { name: "Madhav", email: "madhav@tryautoreceptionist.com" },
    to: { name: null, email: "dana@brightsmile.test" },
    subject: "E2E 1 happy path",
    body: "Hi Dana",
    messageId: "<113dcac6-b1c5-451a-9e65-fc817326f08d@tryautoreceptionist.com>",
  };
  // What Gmail actually put on lead 1's T1 on 15 Sep.
  const gmails = "<CAPvWn2D2HFtFQCydF9v0R+z1qwfuk1ee9+t7ePjcdOJV1dzvGw@mail.gmail.com>";

  function gmail(metadata: () => Response) {
    const fetchMock = vi.fn(async (url: string) =>
      url.endsWith("/messages/send")
        ? Response.json({ id: "1a0a4ded1050bad5", threadId: "1a0a4ded1050bad5" })
        : metadata(),
    );
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("is the Message-ID Gmail sent, not the one we wrote", () => {
    // Gmail replaces it. Recording ours made every follow-up's In-Reply-To name
    // a message the prospect never received.
    const fetchMock = gmail(() =>
      Response.json({
        id: "1a0a4ded1050bad5",
        payload: { headers: [{ name: "Message-ID", value: gmails }] },
      }),
    );

    return sendMessage({ accessToken: "t", message }).then((result) => {
      expect(result.rfc822MessageId).toBe(gmails);
      expect(String(fetchMock.mock.calls[1]![0])).toContain(
        "/messages/1a0a4ded1050bad5?format=metadata&metadataHeaders=Message-ID",
      );
    });
  });

  it("is null, and the send still succeeds, when Gmail cannot say", async () => {
    // The email has already gone. Throwing here would park it as unknown, and
    // falling back to ours would record the id we know is wrong.
    gmail(() => new Response("backend error", { status: 500 }));

    const result = await sendMessage({ accessToken: "t", message });
    expect(result.providerMessageId).toBe("1a0a4ded1050bad5");
    expect(result.rfc822MessageId).toBeNull();
  });
});

describe("classifying what comes back", () => {
  it("reads a person writing back as a reply", () => {
    expect(
      classifyInbound(
        inbound({
          headers: { from: "Dana <dana@brightsmile.test>", subject: "Re: your text" },
          text: "Sure, send it over.",
        }),
      ).kind,
    ).toBe("reply");
  });

  it("reads a 5.x.x delivery report as a hard bounce", () => {
    const result = classifyInbound(
      inbound({
        headers: {
          from: "Mail Delivery Subsystem <mailer-daemon@googlemail.com>",
          "content-type": 'multipart/report; report-type="delivery-status"',
          subject: "Delivery Status Notification (Failure)",
        },
        text: "Final-Recipient: rfc822; dana@brightsmile.test\nStatus: 5.1.1\n",
      }),
    );

    expect(result.kind).toBe("bounce");
    expect(result.hard).toBe(true);
  });

  it("reads a 4.x.x delivery report as a soft bounce and does not suppress on it", () => {
    // A full mailbox on one afternoon must not take a prospect off the list
    // permanently.
    const result = classifyInbound(
      inbound({
        headers: {
          from: "mailer-daemon@googlemail.com",
          "content-type": 'multipart/report; report-type="delivery-status"',
        },
        text: "Status: 4.2.2 (mailbox full)",
      }),
    );

    expect(result.kind).toBe("bounce");
    expect(result.hard).toBe(false);
  });

  it("ignores a delay notice, and bounces on the failure that may follow it", () => {
    // Recorded as a bounce, "Gmail will retry" halted the sequence for good
    // over an email that was still on its way.
    const dsn = {
      from: "Mail Delivery Subsystem <mailer-daemon@googlemail.com>",
      "content-type": 'multipart/report; report-type="delivery-status"',
    };

    const delayed = classifyInbound(
      inbound({
        headers: { ...dsn, subject: "Delivery Status Notification (Delay)" },
        text:
          "Delivery incomplete\nThere was a temporary problem delivering your message to " +
          "dana@brightsmile.test. Gmail will retry for 47 more hours.\n" +
          "Final-Recipient: rfc822; dana@brightsmile.test\nAction: delayed\nStatus: 4.4.1\n",
      }),
    );
    expect(delayed.kind).toBe("ignore");

    const gaveUp = classifyInbound(
      inbound({
        headers: { ...dsn, subject: "Delivery Status Notification (Failure)" },
        text:
          "Message not delivered\nThe response from the remote server was: 451 4.4.1\n" +
          "Final-Recipient: rfc822; dana@brightsmile.test\nAction: failed\nStatus: 4.4.1\n",
      }),
    );
    expect(gaveUp.kind).toBe("bounce");
    expect(gaveUp.hard).toBe(false);
  });

  it("grades an unreadable delivery report as soft rather than guessing", () => {
    const result = classifyInbound(
      inbound({
        headers: { "x-failed-recipients": "dana@brightsmile.test" },
        text: "Something went wrong.",
      }),
    );

    expect(result.kind).toBe("bounce");
    expect(result.hard).toBe(false);
  });

  it("reads an opt-out as an unsubscribe", () => {
    const result = classifyInbound(
      inbound({
        headers: { from: "dana@brightsmile.test", subject: "Re: your text" },
        text: "Please take me off your list.",
      }),
    );

    expect(result.kind).toBe("unsubscribe");
    expect(result.hard).toBe(true);
  });

  it("reads a bare 'remove me' as an unsubscribe", () => {
    // Cool Zone Air's whole reply was "Remove me Thank you", and it was filed
    // as an ordinary reply with no suppression.
    for (const text of ["Remove me Thank you, David", "Please remove us."]) {
      expect(
        classifyInbound(
          inbound({ headers: { from: "david@coolzone.test", subject: "Re: your text" }, text }),
        ).kind,
      ).toBe("unsubscribe");
    }
  });

  it("ignores an out-of-office", () => {
    // Halting a sequence because somebody went on holiday ends an outreach
    // attempt for no reason.
    expect(
      classifyInbound(
        inbound({
          headers: {
            from: "dana@brightsmile.test",
            subject: "Automatic reply: your text",
            "auto-submitted": "auto-replied",
          },
          text: "I am out of the office until Monday.",
        }),
      ).kind,
    ).toBe("ignore");
  });

  it("still honours an unsubscribe sent from behind a vacation responder", () => {
    expect(
      classifyInbound(
        inbound({
          headers: {
            from: "dana@brightsmile.test",
            subject: "Automatic reply",
            "auto-submitted": "auto-replied",
          },
          text: "Out of office. Also please unsubscribe me.",
        }),
      ).kind,
    ).toBe("unsubscribe");
  });

  it("ignores our own outbound copy", () => {
    expect(
      classifyInbound(
        inbound({
          labelIds: ["SENT"],
          headers: { from: "ojas@tryautoreceptionist.com" },
          text: "Worth a look, or should I close the file?",
        }),
      ).kind,
    ).toBe("ignore");
  });
});

describe("header parsing", () => {
  it("pulls the whole reference chain, oldest first", () => {
    expect(
      referencedMessageIds({
        references: "<one@x.test> <two@x.test>",
        "in-reply-to": "<two@x.test>",
      }),
    ).toEqual(["<one@x.test>", "<two@x.test>", "<two@x.test>"]);
  });

  it("pulls a bare address out of a display-name header", () => {
    expect(addressFromHeader('"Dana Reyes" <dana@brightsmile.test>')).toBe(
      "dana@brightsmile.test",
    );
    expect(addressFromHeader("dana@brightsmile.test")).toBe("dana@brightsmile.test");
    expect(addressFromHeader("Mail Delivery Subsystem")).toBeNull();
  });
});

describe("the unsubscribe header", () => {
  const base = {
    from: { name: "Madhav", email: "madhav@tryautoreceptionist.com" },
    to: { name: null, email: "dana@brightsmile.test" },
    subject: "Your Tuesday text went unanswered",
    body: "Hi Dana",
    messageId: "<abc@tryautoreceptionist.com>",
  };

  it("offers a way out that lands in the sending mailbox", () => {
    // So somebody who wants out presses Unsubscribe rather than Report spam,
    // and the request arrives where poll-replies already reads.
    expect(buildMimeMessage(base)).toContain(
      "List-Unsubscribe: <mailto:madhav@tryautoreceptionist.com?subject=unsubscribe>",
    );
  });

  it("is not a tracking pixel by another name", () => {
    const raw = buildMimeMessage(base);
    expect(raw).not.toContain("List-Unsubscribe-Post");
    expect(raw).not.toMatch(/<img|https?:\/\/[^\s]*unsub/i);
  });

  it("takes it off a 1:1 reply, and says the reply is automated instead", () => {
    // Right on outbound a prospect did not ask for, absurd on an answer to
    // "yes, send me a time": Gmail would draw an Unsubscribe control beside
    // your name in the middle of a conversation. Auto-Submitted is RFC 3834,
    // so everybody else's loop prevention can see what this is -- our own
    // classifyInbound() reads exactly that header for exactly that purpose.
    const raw = buildMimeMessage({ ...base, autoReply: true });
    expect(raw).not.toContain("List-Unsubscribe");
    expect(raw).toContain("Auto-Submitted: auto-replied");
  });

  it("does not mark an ordinary touch as automated", () => {
    expect(buildMimeMessage(base)).not.toContain("Auto-Submitted");
  });
});

describe("a reply that quotes our own email back", () => {
  // The hazard the List-Unsubscribe header introduces: the quoted original
  // carries the word "unsubscribe", and suppressing on it would take a prospect
  // who just said yes off the list.
  const QUOTED = [
    "Sure, send it over.",
    "",
    "On Tue, 15 Sept 2026 at 23:39, Madhav <madhav@tryautoreceptionist.com> wrote:",
    "> Hi Dana, worth a look?",
    "> List-Unsubscribe: <mailto:madhav@tryautoreceptionist.com?subject=unsubscribe>",
  ].join("\n");

  it("is a reply, not an unsubscribe", () => {
    expect(
      classifyInbound({
        labelIds: ["INBOX"],
        headers: { from: "Dana <dana@brightsmile.test>", subject: "Re: your text" },
        text: QUOTED,
        snippet: "Sure, send it over. On Tue, 15 Sept 2026 at 23:39, Madhav wrote: Hi Dana",
      }).kind,
    ).toBe("reply");
  });

  it("still hears an opt-out written above the quote", () => {
    expect(
      classifyInbound({
        labelIds: ["INBOX"],
        headers: { from: "Dana <dana@brightsmile.test>", subject: "Re: your text" },
        text: "remove me\n\n" + QUOTED,
        snippet: "remove me",
      }).kind,
    ).toBe("unsubscribe");
  });

  it("still reads a bounce that quotes the whole message", () => {
    // The DSN path reads the WHOLE report on purpose: the status code lives
    // inside the quoted original.
    const result = classifyInbound({
      labelIds: ["INBOX"],
      headers: {
        from: "Mail Delivery Subsystem <mailer-daemon@googlemail.com>",
        "content-type": 'multipart/report; report-type="delivery-status"',
        subject: "Delivery Status Notification (Failure)",
      },
      text:
        "Address not found\nFinal-Recipient: rfc822; dana@brightsmile.test\nStatus: 5.1.1\n" +
        "----- Original message -----\nList-Unsubscribe: <mailto:madhav@tryautoreceptionist.com?subject=unsubscribe>\n",
      snippet: "Address not found",
    });
    expect(result.kind).toBe("bounce");
    expect(result.hard).toBe(true);
  });
});

describe("newText", () => {
  it("keeps what was written and drops what was quoted", () => {
    expect(newText("Yes please\n\nOn Mon, X <x@y.test> wrote:\n> old")).toBe("Yes please\n");
    expect(newText("Yes please\n> old")).toBe("Yes please");
    expect(newText("Yes please\n\nFrom: Madhav <madhav@x.test>\nSent: Tuesday")).toBe(
      "Yes please\n",
    );
    expect(newText("----- Original Message -----\nanything")).toBe("");
  });

  it("leaves a message with nothing quoted alone", () => {
    expect(newText("Happy to talk Thursday.")).toBe("Happy to talk Thursday.");
  });
});

describe("reading a whole thread", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function encoded(text: string): string {
    return Buffer.from(text, "utf8").toString("base64url");
  }

  it("decodes each message and puts them oldest first", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            id: "thread-1",
            messages: [
              {
                id: "b",
                threadId: "thread-1",
                labelIds: ["INBOX"],
                internalDate: "2000",
                snippet: "theirs",
                payload: {
                  mimeType: "text/plain",
                  headers: [{ name: "Subject", value: "Re: hello" }],
                  body: { data: encoded("yes please") },
                },
              },
              {
                id: "a",
                threadId: "thread-1",
                labelIds: ["SENT"],
                internalDate: "1000",
                snippet: "ours",
                payload: {
                  mimeType: "text/plain",
                  headers: [{ name: "Subject", value: "hello" }],
                  body: { data: encoded("the first touch") },
                },
              },
            ],
          }),
          { status: 200 },
        ),
      ),
    );

    const thread = await fetchThread("token", "thread-1");

    expect(thread.messages.map((message) => message.id)).toEqual(["a", "b"]);
    expect(thread.messages[0]!.labelIds).toContain("SENT");
    expect(thread.messages[0]!.internalDate).toBe("1000");
    expect(thread.messages[1]!.text).toContain("yes please");
    expect(thread.messages[1]!.headers["subject"]).toBe("Re: hello");
  });

  it("asks threads.get, which gmail.readonly already covers", async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      void url;
      return new Response(JSON.stringify({ id: "t", messages: [] }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    await fetchThread("token", "t");

    expect(String(fetchMock.mock.calls[0]![0])).toContain("/threads/t?format=full");
  });
});
