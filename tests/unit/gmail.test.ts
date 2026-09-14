import { describe, expect, it } from "vitest";

import { classifyInbound } from "@/lib/gmail/classify";
import {
  addressFromHeader,
  referencedMessageIds,
} from "@/lib/gmail/messages";
import { buildAuthUrl, GMAIL_SCOPES, grantIsComplete } from "@/lib/gmail/oauth";
import { buildMimeMessage, generateMessageId } from "@/lib/gmail/send";

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
