import { describe, expect, it } from "vitest";

import { collapseToDays, recipientsOf, touchFrom, type SentTouch } from "@/lib/gmail/touches";
import { normalizeEmail } from "@/lib/normalize";

function touch(id: string, sentAt: string, subject = "T1"): SentTouch {
  return {
    message_id: id,
    thread_id: `thread-${id}`,
    rfc822_id: null,
    subject,
    mailbox_id: "mailbox",
    sent_at: sentAt,
  };
}

describe("collapsing a Sent folder into touches", () => {
  it("keeps the latest email of each prospect-local day, oldest day first", () => {
    // Sep 10: the 0040 loop's three first touches, three subjects, one afternoon.
    const touches = [
      touch("third", "2026-09-10T20:30:00Z", "Three"),
      touch("first", "2026-09-10T15:40:00Z", "One"),
      touch("second", "2026-09-10T18:05:00Z", "Two"),
      touch("next-week", "2026-09-14T15:00:00Z"),
    ];

    expect(collapseToDays(touches, "America/Chicago").map((t) => t.message_id)).toEqual([
      "third",
      "next-week",
    ]);
  });

  it("draws the day line in the prospect's zone, not UTC", () => {
    // 03:30 UTC on the 11th is still the evening of the 10th in Chicago.
    const touches = [
      touch("afternoon", "2026-09-10T20:00:00Z"),
      touch("evening", "2026-09-11T03:30:00Z"),
    ];

    expect(collapseToDays(touches, "America/Chicago").map((t) => t.message_id)).toEqual([
      "evening",
    ]);
    expect(collapseToDays(touches, "UTC").map((t) => t.message_id)).toEqual([
      "afternoon",
      "evening",
    ]);
  });
});

describe("who a sent message went to", () => {
  it("reads To, Cc and Bcc, normalized the way work_email_norm is", () => {
    const recipients = recipientsOf(
      {
        to: "Dana Owner <Dana@Prospect.test>, other@warmup.test",
        cc: "j.doe+outreach@gmail.com",
        bcc: "",
      },
      normalizeEmail,
    );

    expect(recipients.sort()).toEqual(["dana@prospect.test", "jdoe@gmail.com", "other@warmup.test"]);
  });
});

describe("a touch from a message", () => {
  it("is dated by when Gmail says it left", () => {
    expect(
      touchFrom(
        {
          id: "m1",
          threadId: "t1",
          internalDate: String(Date.parse("2026-09-10T15:40:00Z")),
          headers: { subject: "Hi", "message-id": "<x@example.test>" },
        },
        "mailbox",
      ),
    ).toEqual({
      message_id: "m1",
      thread_id: "t1",
      rfc822_id: "<x@example.test>",
      subject: "Hi",
      mailbox_id: "mailbox",
      sent_at: "2026-09-10T15:40:00.000Z",
    });
  });

  it("is nothing when Gmail gave no send time", () => {
    expect(touchFrom({ id: "m1", internalDate: null, headers: {} }, "mailbox")).toBeNull();
  });
});
