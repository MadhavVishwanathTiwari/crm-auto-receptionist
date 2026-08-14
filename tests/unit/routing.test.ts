import { describe, expect, it } from "vitest";

import {
  buildMailboxSenders,
  mailboxesForSend,
  pinnedMailboxIdFor,
  type RoutedMailbox,
} from "@/lib/scheduler/routing";

// Which mailbox an email is allowed to leave from.
//
// book.ts decides which mailbox has ROOM. This decides which mailbox is
// RIGHT, and for a long time nothing did: every send was routed to whichever
// account in the org was emptiest that day, so an operator's hand-written email
// went out over a colleague's name and the reply landed in a colleague's inbox.
//
// Two rules, and the second is the one that is easy to get wrong. An operator
// sends as themselves; but a lead whose sequence has already started is
// committed to the account that started it, because dispatch-sends reuses a
// Gmail threadId that only exists inside that one mailbox.

const OJAS = "user-ojas";
const MADHAV_LEADS = "user-madhav-try"; // the account that claimed the leads
const MADHAV_MAILBOX = "user-madhav-io"; // the account that connected the mailbox

const ojasBox: RoutedMailbox = {
  id: "mb-ojas",
  user_id: OJAS,
  timezone: "Asia/Kolkata",
  daily_cap: 20,
};

const madhavBox: RoutedMailbox = {
  id: "mb-madhav",
  user_id: MADHAV_MAILBOX,
  timezone: "Asia/Kolkata",
  daily_cap: 20,
};

const ALL = [ojasBox, madhavBox];

/** What public.mailbox_senders() returns for the real project. */
const SENDERS = buildMailboxSenders([
  { mailbox_id: "mb-ojas", user_id: OJAS },
  { mailbox_id: "mb-madhav", user_id: MADHAV_MAILBOX },
  // Both of madhav's accounts resolve to the same operator, so either may send
  // from the mailbox one of them connected. This row is the whole reason the
  // rule is not a plain user_id comparison.
  { mailbox_id: "mb-madhav", user_id: MADHAV_LEADS },
]);

describe("mailboxesForSend", () => {
  it("routes an operator to their own mailbox, not the emptiest one", () => {
    const routed = mailboxesForSend(ALL, {
      ownerId: OJAS,
      pinnedMailboxId: null,
      senders: SENDERS,
    });

    expect(routed.ok).toBe(true);
    if (!routed.ok) return;

    expect(routed.reason).toBe("owner");
    expect(routed.mailboxes.map((m) => m.id)).toEqual(["mb-ojas"]);
  });

  it("never offers a colleague's mailbox as a fallback", () => {
    // The exact shape of the bug: Ojas has no mailbox, and madhav@ has room.
    const routed = mailboxesForSend([madhavBox], {
      ownerId: OJAS,
      pinnedMailboxId: null,
      senders: SENDERS,
    });

    expect(routed).toEqual({ ok: false, blocked: "owner_has_no_mailbox" });
  });

  it("resolves a second account belonging to the same human", () => {
    // madhav@autoreceptionist.io connected the mailbox; the leads are claimed
    // by madhav@tryautoreceptionist.com. Strict ownership refuses all 30 of
    // them, which is a worse bug than the one being fixed.
    const routed = mailboxesForSend(ALL, {
      ownerId: MADHAV_LEADS,
      pinnedMailboxId: null,
      senders: SENDERS,
    });

    expect(routed.ok).toBe(true);
    if (!routed.ok) return;
    expect(routed.mailboxes.map((m) => m.id)).toEqual(["mb-madhav"]);
  });

  it("refuses the alias when no senders map says they are the same human", () => {
    const routed = mailboxesForSend(ALL, {
      ownerId: MADHAV_LEADS,
      pinnedMailboxId: null,
    });

    expect(routed).toEqual({ ok: false, blocked: "owner_has_no_mailbox" });
  });

  it("pins to the mailbox that started the thread, over the owner's own", () => {
    // The lead is Ojas's, but its first touch went out from madhav@. The Gmail
    // threadId dispatch-sends will reuse only exists inside that mailbox.
    const routed = mailboxesForSend(ALL, {
      ownerId: OJAS,
      pinnedMailboxId: "mb-madhav",
      senders: SENDERS,
    });

    expect(routed.ok).toBe(true);
    if (!routed.ok) return;

    expect(routed.reason).toBe("pinned");
    expect(routed.mailboxes.map((m) => m.id)).toEqual(["mb-madhav"]);
    expect(routed.pinnedTo?.id).toBe("mb-madhav");
  });

  it("blocks rather than re-homing when the pinned mailbox is not sendable", () => {
    // Paused or disconnected, so it is absent from the sendable list. Falling
    // back to the owner's mailbox would break the thread silently.
    const routed = mailboxesForSend([ojasBox], {
      ownerId: OJAS,
      pinnedMailboxId: "mb-madhav",
      senders: SENDERS,
    });

    expect(routed).toEqual({ ok: false, blocked: "pin_unavailable" });
  });

  it("refuses an unclaimed lead", () => {
    const routed = mailboxesForSend(ALL, {
      ownerId: null,
      pinnedMailboxId: null,
      senders: SENDERS,
    });

    expect(routed).toEqual({ ok: false, blocked: "no_owner" });
  });

  it("offers every mailbox an operator owns, so capacity can still spread", () => {
    const second: RoutedMailbox = { ...ojasBox, id: "mb-ojas-2" };

    const routed = mailboxesForSend([...ALL, second], {
      ownerId: OJAS,
      pinnedMailboxId: null,
      senders: SENDERS,
    });

    expect(routed.ok).toBe(true);
    if (!routed.ok) return;
    expect(routed.mailboxes.map((m) => m.id)).toEqual(["mb-ojas", "mb-ojas-2"]);
  });

  it("never routes to an unowned mailbox", () => {
    const orphan: RoutedMailbox = { ...madhavBox, id: "mb-orphan", user_id: null };

    const routed = mailboxesForSend([orphan], {
      ownerId: OJAS,
      pinnedMailboxId: null,
      senders: SENDERS,
    });

    expect(routed).toEqual({ ok: false, blocked: "owner_has_no_mailbox" });
  });
});

describe("pinnedMailboxIdFor", () => {
  it("is null for a lead with no history", () => {
    expect(
      pinnedMailboxIdFor([
        { status: "planned", mailbox_id: "mb-ojas", step_number: 1 },
      ]),
    ).toBeNull();
  });

  it("finds the mailbox a sent touch went out from", () => {
    expect(
      pinnedMailboxIdFor([
        { status: "sent", mailbox_id: "mb-madhav", step_number: 1 },
        { status: "planned", mailbox_id: "mb-ojas", step_number: 2 },
      ]),
    ).toBe("mb-madhav");
  });

  it("takes the latest step when several have gone out", () => {
    expect(
      pinnedMailboxIdFor([
        { status: "sent", mailbox_id: "mb-madhav", step_number: 1 },
        { status: "sent", mailbox_id: "mb-ojas", step_number: 2 },
      ]),
    ).toBe("mb-ojas");
  });

  it("ignores a sent row with no mailbox", () => {
    // 0027's sheet backfill writes exactly this: the sheet recorded that a
    // touch happened and never which account sent it. Such a lead is free to
    // start fresh on its owner's mailbox rather than being pinned to nothing.
    expect(
      pinnedMailboxIdFor([{ status: "sent", mailbox_id: null, step_number: 1 }]),
    ).toBeNull();
  });
});
