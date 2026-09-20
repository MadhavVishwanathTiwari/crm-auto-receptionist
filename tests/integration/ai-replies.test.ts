import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { GmailMessage } from "@/lib/gmail/messages";

// Gmail and the model are the only things faked. Everything after them -- the
// candidate scan, the claim under the advisory lock, the guard, the event log,
// the mailbox cap, RLS -- is the real thing against a real database.
const gmail = vi.hoisted(() => ({
  threads: new Map<string, GmailMessage[]>(),
  sent: [] as { threadId: string | null; subject: string; inReplyTo: string | null; autoReply: boolean; to: string }[],
  /** The next send throws this instead of answering. */
  failWith: null as { status: number } | null,
}));

const model = vi.hoisted(() => ({
  calls: 0,
  answer: {
    action: "reply" as "reply" | "skip",
    intent: "interested" as string,
    reason: "they asked for a time",
    body: "Happy to. Grab a slot: [book a time](https://cal.com/madhav/intro)\n\nMadhav's assistant" as string | null,
    needs_human: false,
  },
  failure: null as { reason: string; retryable: boolean } | null,
}));

vi.mock("@/lib/gmail/token", () => ({
  getMailboxAccessToken: vi.fn(async () => ({ accessToken: "test-access-token" })),
  MailboxDisconnectedError: class MailboxDisconnectedError extends Error {},
}));

vi.mock("@/lib/notify/push", () => ({ pushAlert: vi.fn(async () => true) }));

vi.mock("@/lib/ai/client", () => ({
  anthropicIsConfigured: () => true,
  getAnthropic: () => {
    throw new Error("the model client must never be reached in a test");
  },
}));

vi.mock("@/lib/ai/reply/decide", () => ({
  REPLY_MODEL: "claude-opus-5",
  decideReply: vi.fn(async () => {
    model.calls += 1;
    if (model.failure) {
      return { ok: false as const, reason: model.failure.reason, retryable: model.failure.retryable };
    }
    return {
      ok: true as const,
      decision: model.answer,
      model: "claude-opus-5",
      inputTokens: 1200,
      outputTokens: 90,
    };
  }),
}));

vi.mock("@/lib/gmail/messages", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/gmail/messages")>();
  return {
    ...actual,
    fetchThread: vi.fn(async (_token: string, threadId: string) => ({
      id: threadId,
      messages: gmail.threads.get(threadId) ?? [],
    })),
  };
});

vi.mock("@/lib/gmail/send", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/gmail/send")>();
  return {
    ...actual,
    sendMessage: vi.fn(
      async (input: {
        threadId?: string | null;
        message: {
          subject: string;
          inReplyTo?: string | null;
          autoReply?: boolean;
          to: { email: string };
        };
      }) => {
        if (gmail.failWith) {
          throw new actual.GmailSendError("gmail send failed", gmail.failWith.status);
        }
        gmail.sent.push({
          threadId: input.threadId ?? null,
          subject: input.message.subject,
          inReplyTo: input.message.inReplyTo ?? null,
          autoReply: Boolean(input.message.autoReply),
          to: input.message.to.email,
        });
        const id = `gmail-${randomUUID()}`;
        return {
          providerMessageId: id,
          providerThreadId: input.threadId ?? "thread",
          rfc822MessageId: `<${id}@mail.gmail.com>`,
        };
      },
    ),
  };
});

import { POST as aiReplies } from "@/app/api/cron/ai-replies/route";

import {
  addMember,
  adminClient,
  anonClient,
  cleanup,
  createTestOrg,
  createTestUser,
  type TestUser,
} from "../setup/stack";

// The assistant answers a prospect only when nobody else has, only once, and
// only at an address that belongs to a lead. Every route call is ?org= scoped
// so a run never touches an org this file did not create.

const CRON_SECRET = process.env.CRON_SECRET ?? "";
const ZONE = "America/Chicago";
const BOOKING = "https://cal.com/madhav/intro";

const orgIds: string[] = [];
const userIds: string[] = [];

function admin() {
  return adminClient();
}

function minutesAgo(minutes: number): Date {
  return new Date(Date.now() - minutes * 60 * 1000);
}

async function makeOrg(label: string, settings: Record<string, unknown> = {}) {
  const org = await createTestOrg(label);
  orgIds.push(org.id);
  const operator = await createTestUser(`${label}-op`);
  userIds.push(operator.id);
  await addMember(org.id, operator.id, "admin");

  const { error } = await admin()
    .from("org_settings")
    .update({
      ai_reply_mode: "send",
      ai_reply_delay_minutes: 5,
      ai_reply_daily_cap: 20,
      booking_url: BOOKING,
      business_context: "We build AI receptionists.",
      operator_timezone: "Asia/Kolkata",
      ...settings,
    })
    .eq("org_id", org.id);
  if (error) throw new Error(`org_settings: ${error.message}`);

  return { org, operator };
}

async function makeMailbox(
  orgId: string,
  operator: TestUser,
  overrides: Record<string, unknown> = {},
): Promise<{ id: string; email: string }> {
  const email = `sender-${randomUUID().slice(0, 8)}@example.test`;
  const { data, error } = await admin()
    .from("mailboxes")
    .insert({
      org_id: orgId,
      user_id: operator.id,
      email,
      display_name: "Madhav",
      timezone: "America/New_York",
      daily_cap: 20,
      ...overrides,
    })
    .select("id")
    .single();
  if (error) throw new Error(`mailbox: ${error.message}`);
  return { id: data.id as string, email };
}

function threadMessage(input: {
  id: string;
  threadId: string;
  outbound: boolean;
  at: Date;
  from: string;
  text?: string;
}): GmailMessage {
  return {
    id: input.id,
    threadId: input.threadId,
    labelIds: input.outbound ? ["SENT"] : ["INBOX"],
    internalDate: String(input.at.getTime()),
    headers: {
      from: input.from,
      subject: input.outbound
        ? "Your Tuesday text went unanswered"
        : "Re: Your Tuesday text went unanswered",
      "message-id": `<${input.id}@mail.gmail.com>`,
    },
    text: input.text ?? "Sounds good, what times work next week?",
    snippet: input.text ?? "Sounds good, what times work next week?",
  };
}

/**
 * A lead that was emailed, replied, and whose reply is the given age. The
 * `replied` event is shaped exactly as poll-replies writes it.
 */
async function makeRepliedLead(
  orgId: string,
  operator: TestUser,
  mailbox: { id: string; email: string },
  options: { repliedMinutesAgo?: number; from?: string; sheetOnly?: boolean } = {},
) {
  const email = `owner-${randomUUID().slice(0, 8)}@prospect.test`;
  const domain = email.split("@")[1]!;

  const { data, error } = await admin()
    .from("leads")
    .insert({
      org_id: orgId,
      company_name: "Bright Smile Dental",
      work_email: email,
      website: `https://${domain}`,
      timezone: ZONE,
      timezone_source: "import",
      claimed_by: operator.id,
      claimed_at: new Date().toISOString(),
    })
    .select("id, website_domain")
    .single();
  if (error) throw new Error(`lead: ${error.message}`);
  const leadId = data.id as string;

  const threadId = `thread-${randomUUID()}`;
  const sentAt = minutesAgo(600);

  const { error: sendError } = await admin().from("scheduled_sends").insert({
    org_id: orgId,
    lead_id: leadId,
    mailbox_id: mailbox.id,
    step_number: 1,
    touch_kind: "first",
    status: "sent",
    scheduled_at: sentAt.toISOString(),
    scheduled_local: sentAt.toISOString().slice(0, 19),
    prospect_timezone: ZONE,
    sent_at: sentAt.toISOString(),
    // Explicitly an earlier day, so a test run near midnight does not have the
    // first touch eating today's mailbox cap by accident.
    cap_date: new Date(sentAt.getTime() - 3 * 24 * 60 * 60 * 1000)
      .toISOString()
      .slice(0, 10),
    provider_message_id: `gmail-${randomUUID()}`,
    provider_thread_id: threadId,
    rfc822_message_id: `<${randomUUID()}@example.test>`,
  });
  if (sendError) throw new Error(`sent row: ${sendError.message}`);

  const receivedAt = minutesAgo(options.repliedMinutesAgo ?? 30);
  const messageId = `msg-${randomUUID()}`;
  const from = options.from ?? email;

  gmail.threads.set(threadId, [
    threadMessage({
      id: `ours-${randomUUID()}`,
      threadId,
      outbound: true,
      at: sentAt,
      from: mailbox.email,
    }),
    threadMessage({ id: messageId, threadId, outbound: false, at: receivedAt, from }),
  ]);

  const { error: eventError } = await admin().from("lead_events").insert({
    org_id: orgId,
    lead_id: leadId,
    type: "replied",
    actor_id: null,
    occurred_at: receivedAt.toISOString(),
    dedupe_token: messageId,
    payload: {
      mailbox_id: mailbox.id,
      gmail_message_id: messageId,
      gmail_thread_id: threadId,
      internal_date: String(receivedAt.getTime()),
      from,
      subject: "Re: Your Tuesday text went unanswered",
      snippet: "Sounds good",
      classification: "a person wrote back",
      hard: false,
    },
  });
  if (eventError) throw new Error(`replied event: ${eventError.message}`);

  return { leadId, email, threadId, messageId, receivedAt };
}

/**
 * A lead with a send the dispatcher would claim right now.
 *
 * dry_run is turned off here too: claim_due_sends() refuses everything while it
 * is on, and a cap test that passed because of the kill switch would prove
 * nothing.
 */
async function makeDueSend(
  orgId: string,
  operator: TestUser,
  mailbox: { id: string },
): Promise<string> {
  await admin().from("org_settings").update({ dry_run: false }).eq("org_id", orgId);

  const { data: lead, error } = await admin()
    .from("leads")
    .insert({
      org_id: orgId,
      company_name: "Northside Plumbing",
      work_email: `due-${randomUUID().slice(0, 8)}@prospect.test`,
      timezone: ZONE,
      timezone_source: "import",
      claimed_by: operator.id,
      claimed_at: new Date().toISOString(),
    })
    .select("id")
    .single();
  if (error) throw new Error(`due lead: ${error.message}`);

  const at = minutesAgo(1);
  const { data: send, error: sendError } = await admin()
    .from("scheduled_sends")
    .insert({
      org_id: orgId,
      lead_id: lead.id,
      mailbox_id: mailbox.id,
      step_number: 1,
      touch_kind: "first",
      status: "planned",
      scheduled_at: at.toISOString(),
      scheduled_local: at.toISOString().slice(0, 19),
      prospect_timezone: ZONE,
      composed_subject: "A question about your phones",
      composed_body: "Hi there",
    })
    .select("id")
    .single();
  if (sendError) throw new Error(`due send: ${sendError.message}`);

  return send.id as string;
}

async function run(orgId: string) {
  const response = await aiReplies(
    new Request(`http://localhost/api/cron/ai-replies?org=${orgId}`, {
      method: "POST",
      headers: { authorization: `Bearer ${CRON_SECRET}` },
    }),
  );
  expect(response.status).toBe(200);
  const body = (await response.json()) as {
    reports: Record<string, unknown>[];
  };
  return body.reports[0] as Record<string, number | string>;
}

async function repliesFor(leadId: string) {
  const { data } = await admin()
    .from("ai_replies")
    .select("id, outcome, reason, intent, draft_body, provider_message_id, cap_date")
    .eq("lead_id", leadId);
  return data ?? [];
}

beforeAll(() => {
  if (!CRON_SECRET) throw new Error("CRON_SECRET must be set for the cron route tests.");
});

beforeEach(() => {
  gmail.threads.clear();
  gmail.sent.length = 0;
  gmail.failWith = null;
  model.calls = 0;
  model.failure = null;
  model.answer = {
    action: "reply",
    intent: "interested",
    reason: "they asked for a time",
    body: "Happy to. Grab a slot: [book a time](https://cal.com/madhav/intro)\n\nMadhav's assistant",
    needs_human: false,
  };
});

afterAll(async () => {
  await cleanup(orgIds, userIds);
});

describe("ai-replies", () => {
  it("does nothing at all, and costs nothing, while the mode is off", async () => {
    const { org, operator } = await makeOrg("ai-off", { ai_reply_mode: "off" });
    const mailbox = await makeMailbox(org.id, operator);
    const lead = await makeRepliedLead(org.id, operator, mailbox);

    const report = await run(org.id);

    expect(report.mode).toBe("off");
    expect(model.calls).toBe(0);
    expect(gmail.sent).toHaveLength(0);
    expect(await repliesFor(lead.leadId)).toHaveLength(0);
  });

  it("leaves a reply alone until the head start has passed", async () => {
    const { org, operator } = await makeOrg("ai-early");
    const mailbox = await makeMailbox(org.id, operator);
    const lead = await makeRepliedLead(org.id, operator, mailbox, {
      repliedMinutesAgo: 2,
    });

    const report = await run(org.id);

    expect(report.candidates).toBe(0);
    expect(model.calls).toBe(0);
    expect(await repliesFor(lead.leadId)).toHaveLength(0);
  });

  it("answers, threads the reply, and records it on the lead's timeline", async () => {
    const { org, operator } = await makeOrg("ai-send");
    const mailbox = await makeMailbox(org.id, operator);
    const lead = await makeRepliedLead(org.id, operator, mailbox);

    const report = await run(org.id);

    expect(report.sent).toBe(1);
    expect(gmail.sent).toHaveLength(1);

    const sent = gmail.sent[0]!;
    expect(sent.threadId).toBe(lead.threadId);
    expect(sent.subject).toBe("Re: Your Tuesday text went unanswered");
    expect(sent.inReplyTo).toBe(`<${lead.messageId}@mail.gmail.com>`);
    // RFC 3834, so nobody else's autoresponder answers this one back.
    expect(sent.autoReply).toBe(true);
    expect(sent.to).toBe(lead.email);

    const [row] = await repliesFor(lead.leadId);
    expect(row?.outcome).toBe("sent");
    expect(row?.provider_message_id).toBeTruthy();
    // cap_date is stamped at claim, so the mailbox's day counts this email.
    expect(row?.cap_date).toBeTruthy();

    const { data: events } = await admin()
      .from("lead_events")
      .select("type, payload, dedupe_token")
      .eq("lead_id", lead.leadId)
      .eq("type", "ai_replied");
    expect(events).toHaveLength(1);
    expect((events![0]!.payload as { body: string }).body).toContain("Grab a slot");

    // The reply does not walk the lead's status anywhere: ai_replied ranks 0.
    const { data: after } = await admin()
      .from("leads")
      .select("status, halted_at")
      .eq("id", lead.leadId)
      .single();
    expect(after!.status).toBe("replied");
    expect(after!.halted_at).not.toBeNull();
  });

  it("writes the email and sends nothing while the mode is draft", async () => {
    const { org, operator } = await makeOrg("ai-draft", { ai_reply_mode: "draft" });
    const mailbox = await makeMailbox(org.id, operator);
    const lead = await makeRepliedLead(org.id, operator, mailbox);

    const report = await run(org.id);

    expect(report.drafted).toBe(1);
    expect(gmail.sent).toHaveLength(0);

    const [row] = await repliesFor(lead.leadId);
    expect(row?.outcome).toBe("drafted");
    expect(row?.draft_body).toContain("Grab a slot");

    const { data: alerts } = await admin()
      .from("alerts")
      .select("kind, message")
      .eq("org_id", org.id)
      .eq("kind", "ai_reply");
    expect(alerts).toHaveLength(1);
  });

  it("stands down when a person already answered, without paying the model", async () => {
    const { org, operator } = await makeOrg("ai-human");
    const mailbox = await makeMailbox(org.id, operator);
    const lead = await makeRepliedLead(org.id, operator, mailbox);

    // An operator answering from their own Gmail leaves no trace in this
    // database. The Sent copy in the thread is the only evidence there is.
    gmail.threads.get(lead.threadId)!.push(
      threadMessage({
        id: `ours-${randomUUID()}`,
        threadId: lead.threadId,
        outbound: true,
        at: minutesAgo(10),
        from: mailbox.email,
      }),
    );

    const report = await run(org.id);

    expect(report.skipped).toBe(1);
    expect(model.calls).toBe(0);
    expect(gmail.sent).toHaveLength(0);
    expect((await repliesFor(lead.leadId))[0]?.reason).toContain("already replied");
  });

  it("stands down when the prospect wrote again before it ran", async () => {
    const { org, operator } = await makeOrg("ai-again");
    const mailbox = await makeMailbox(org.id, operator);
    const lead = await makeRepliedLead(org.id, operator, mailbox);

    gmail.threads.get(lead.threadId)!.push(
      threadMessage({
        id: `them-${randomUUID()}`,
        threadId: lead.threadId,
        outbound: false,
        at: minutesAgo(8),
        from: lead.email,
      }),
    );

    const report = await run(org.id);

    expect(report.skipped).toBe(1);
    expect(model.calls).toBe(0);
    expect((await repliesFor(lead.leadId))[0]?.reason).toContain("conversation");
  });

  it("refuses an address that is not the lead's, and says so", async () => {
    // matchLead() attributes a thread by its References chain no matter who
    // sent the message, so a forward or a colleague reaches this route as an
    // ordinary candidate. Answering one is answering the wrong person.
    const { org, operator } = await makeOrg("ai-stranger");
    const mailbox = await makeMailbox(org.id, operator);
    const lead = await makeRepliedLead(org.id, operator, mailbox, {
      from: "someone-else@unrelated.test",
    });

    const report = await run(org.id);

    expect(report.skipped).toBe(1);
    expect(model.calls).toBe(0);
    expect(gmail.sent).toHaveLength(0);
    expect((await repliesFor(lead.leadId))[0]?.reason).toContain("not this lead's address");
  });

  it("answers a colleague at the same company", async () => {
    const { org, operator } = await makeOrg("ai-colleague");
    const mailbox = await makeMailbox(org.id, operator);
    const lead = await makeRepliedLead(org.id, operator, mailbox);
    const domain = lead.email.split("@")[1]!;

    // Replace the inbound with one from a different person, same domain.
    const thread = gmail.threads.get(lead.threadId)!;
    thread[1] = threadMessage({
      id: lead.messageId,
      threadId: lead.threadId,
      outbound: false,
      at: lead.receivedAt,
      from: `office@${domain}`,
    });

    const report = await run(org.id);

    expect(report.sent).toBe(1);
    expect(gmail.sent[0]!.to).toBe(`office@${domain}`);
  });

  it("never answers the same lead twice", async () => {
    const { org, operator } = await makeOrg("ai-once");
    const mailbox = await makeMailbox(org.id, operator);
    const lead = await makeRepliedLead(org.id, operator, mailbox);

    await run(org.id);
    expect(gmail.sent).toHaveLength(1);

    // A second reply on the same lead, a second tick.
    const second = `msg-${randomUUID()}`;
    const at = minutesAgo(6);
    gmail.threads.get(lead.threadId)!.push(
      threadMessage({
        id: second,
        threadId: lead.threadId,
        outbound: false,
        at,
        from: lead.email,
      }),
    );
    await admin().from("lead_events").insert({
      org_id: org.id,
      lead_id: lead.leadId,
      type: "replied",
      occurred_at: at.toISOString(),
      dedupe_token: second,
      payload: {
        mailbox_id: mailbox.id,
        gmail_message_id: second,
        gmail_thread_id: lead.threadId,
        internal_date: String(at.getTime()),
        from: lead.email,
      },
    });

    const report = await run(org.id);

    expect(gmail.sent).toHaveLength(1);
    expect(report.sent ?? 0).toBe(0);
  });

  it("running twice over the same reply sends one email", async () => {
    const { org, operator } = await makeOrg("ai-rerun");
    const mailbox = await makeMailbox(org.id, operator);
    const lead = await makeRepliedLead(org.id, operator, mailbox);

    await run(org.id);
    await run(org.id);

    expect(gmail.sent).toHaveLength(1);
    expect(await repliesFor(lead.leadId)).toHaveLength(1);
  });

  it("refuses a body that links somewhere it was not given, and alerts", async () => {
    const { org, operator } = await makeOrg("ai-guard");
    const mailbox = await makeMailbox(org.id, operator);
    const lead = await makeRepliedLead(org.id, operator, mailbox);

    model.answer = {
      ...model.answer,
      body: "Our pricing is here: [plans](https://autoreceptionist.io/pricing)",
    };

    const report = await run(org.id);

    expect(report.failed).toBe(1);
    expect(gmail.sent).toHaveLength(0);

    const [row] = await repliesFor(lead.leadId);
    expect(row?.outcome).toBe("failed");
    expect(row?.reason).toContain("refused before sending");

    const { data: alerts } = await admin()
      .from("alerts")
      .select("message")
      .eq("org_id", org.id)
      .eq("kind", "ai_reply");
    expect(alerts).toHaveLength(1);
  });

  it("says nothing when the model says there is nothing worth saying", async () => {
    const { org, operator } = await makeOrg("ai-skip");
    const mailbox = await makeMailbox(org.id, operator);
    const lead = await makeRepliedLead(org.id, operator, mailbox);

    model.answer = {
      action: "skip",
      intent: "negative",
      reason: "they said they are not interested",
      body: null,
      needs_human: false,
    };

    const report = await run(org.id);

    expect(report.skipped).toBe(1);
    expect(gmail.sent).toHaveLength(0);
    const [row] = await repliesFor(lead.leadId);
    expect(row?.outcome).toBe("skipped");
    expect(row?.intent).toBe("negative");
  });

  it("parks an ambiguous Gmail answer as stalled rather than trying again", async () => {
    // Only a 4xx is a failure. A 5xx may be an email that already went out, and
    // a retry would be a second email to a prospect.
    const { org, operator } = await makeOrg("ai-stalled");
    const mailbox = await makeMailbox(org.id, operator);
    const lead = await makeRepliedLead(org.id, operator, mailbox);

    gmail.failWith = { status: 503 };
    const first = await run(org.id);
    expect(first.stalled).toBe(1);

    gmail.failWith = null;
    const second = await run(org.id);

    expect(gmail.sent).toHaveLength(0);
    expect(second.sent ?? 0).toBe(0);
    expect((await repliesFor(lead.leadId))[0]?.outcome).toBe("stalled");
  });

  it("does not send from a paused mailbox, and keeps the reply for later", async () => {
    const { org, operator } = await makeOrg("ai-paused");
    const mailbox = await makeMailbox(org.id, operator, {
      paused_at: new Date().toISOString(),
    });
    const lead = await makeRepliedLead(org.id, operator, mailbox);

    const report = await run(org.id);

    expect(gmail.sent).toHaveLength(0);
    expect(report.deferred).toBe(1);
    // Deferred, not consumed: unpause within the day and it still goes.
    expect(await repliesFor(lead.leadId)).toHaveLength(0);
  });

  it("stops at the daily cap", async () => {
    const { org, operator } = await makeOrg("ai-cap", { ai_reply_daily_cap: 1 });
    const mailbox = await makeMailbox(org.id, operator);
    await makeRepliedLead(org.id, operator, mailbox);
    await makeRepliedLead(org.id, operator, mailbox);

    const first = await run(org.id);
    expect(first.sent).toBe(1);

    const second = await run(org.id);
    expect(second.stopped).toContain("daily cap");
    expect(gmail.sent).toHaveLength(1);
  });

  it("answers nothing that predates the moment it was switched on", async () => {
    const { org, operator } = await makeOrg("ai-enabled", {
      ai_reply_enabled_at: new Date().toISOString(),
    });
    const mailbox = await makeMailbox(org.id, operator);
    const lead = await makeRepliedLead(org.id, operator, mailbox, {
      repliedMinutesAgo: 120,
    });

    const report = await run(org.id);

    expect(report.candidates).toBe(0);
    expect(await repliesFor(lead.leadId)).toHaveLength(0);
  });

  it("counts against the sending mailbox's daily cap, so the dispatcher sees it", async () => {
    // 0041's cap is a Gmail reputation limit on the ACCOUNT, not an outreach
    // budget. An AI reply is a real email out of that account, so
    // claim_due_sends() counts both pipelines -- otherwise the claimer believes
    // in headroom that does not exist and the account quietly over-sends.
    //
    // Proved both ways: the same due send IS claimable when the assistant has
    // not run, and is not once it has.
    const control = await makeOrg("ai-cap-control", { ai_reply_mode: "off" });
    const controlMailbox = await makeMailbox(control.org.id, control.operator, {
      daily_cap: 1,
    });
    await makeRepliedLead(control.org.id, control.operator, controlMailbox);
    const controlDue = await makeDueSend(
      control.org.id,
      control.operator,
      controlMailbox,
    );

    await run(control.org.id);
    expect(gmail.sent).toHaveLength(0);

    const { data: claimedControl } = await admin().rpc("claim_due_sends", {
      p_org_id: control.org.id,
      p_limit: 5,
    });
    expect((claimedControl ?? []).map((row: { id: string }) => row.id)).toEqual([
      controlDue,
    ]);

    // Same shape, with the assistant on.
    const { org, operator } = await makeOrg("ai-mailbox-cap");
    const mailbox = await makeMailbox(org.id, operator, { daily_cap: 1 });
    await makeRepliedLead(org.id, operator, mailbox);
    await makeDueSend(org.id, operator, mailbox);

    await run(org.id);
    expect(gmail.sent).toHaveLength(1);

    const { data: claimed, error } = await admin().rpc("claim_due_sends", {
      p_org_id: org.id,
      p_limit: 5,
    });
    expect(error).toBeNull();
    expect(claimed ?? []).toHaveLength(0);
  });

  it("is invisible to the nightly Sent-folder reconciler", async () => {
    // The property the whole design rests on: reconcile-mailboxes filters
    // halted_at is null, and the `replied` event that triggered the assistant
    // is what sets it. Delete that filter and the assistant becomes a
    // sequence-corrupter, so it is asserted here rather than assumed.
    const { org, operator } = await makeOrg("ai-reconcile");
    const mailbox = await makeMailbox(org.id, operator);
    const lead = await makeRepliedLead(org.id, operator, mailbox);
    await run(org.id);

    const { data: visible } = await admin()
      .from("leads")
      .select("id")
      .eq("org_id", org.id)
      .is("archived_at", null)
      .is("halted_at", null)
      .is("terminal_outcome", null);

    expect((visible ?? []).map((row) => row.id)).not.toContain(lead.leadId);
  });
});

describe("who can read what the assistant did", () => {
  it("is denied to anon entirely", async () => {
    const { org, operator } = await makeOrg("ai-rls");
    const mailbox = await makeMailbox(org.id, operator);
    await makeRepliedLead(org.id, operator, mailbox);
    await run(org.id);

    const { data: replies } = await anonClient().from("ai_replies").select("id");
    expect(replies ?? []).toHaveLength(0);

    const { data: kb } = await anonClient().from("kb_entries").select("id");
    expect(kb ?? []).toHaveLength(0);
  });

  it("refuses an operator's write, and the row is genuinely unchanged", async () => {
    // A PostgREST update denied by RLS is 204 with zero rows and no error, so
    // asserting error !== null would pass against a completely broken policy.
    const { org, operator } = await makeOrg("ai-rls-write");
    const mailbox = await makeMailbox(org.id, operator);
    const lead = await makeRepliedLead(org.id, operator, mailbox);
    await run(org.id);

    const [before] = await repliesFor(lead.leadId);
    expect(before?.outcome).toBe("sent");

    const asOperator = operator.client;
    const { error } = await asOperator
      .from("ai_replies")
      .update({ reason: "tampered" })
      .eq("id", before!.id);
    expect(error).not.toBeNull();

    const [after] = await repliesFor(lead.leadId);
    expect(after?.reason).toBe(before?.reason);
    expect(after?.outcome).toBe("sent");
  });
});
