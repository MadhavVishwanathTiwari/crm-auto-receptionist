import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { GmailMessage } from "@/lib/gmail/messages";

// No live Gmail grant exists in a test, so the token, the profile and the two
// Gmail reads are replaced by a mailbox the test writes. Everything after that
// -- matching, the event log, the status trigger, the cursor, the alerts -- is
// the real thing against a real database.
const gmail = vi.hoisted(() => ({
  /** History records, ids ascending, as Gmail keeps them. */
  history: [] as { id: string; messageIds: string[] }[],
  /** Records per page, so a test can make the history span many pages. */
  pageSize: 100,
  /** The mailbox's current history id: past every record. */
  currentHistoryId: "9000",
  profileHistoryId: "9500",
  messages: new Map<string, GmailMessage>(),
  /** Message ids whose read fails with a 503. */
  failing: new Set<string>(),
  /** history.list answers 404: the cursor is older than what Gmail keeps. */
  expired: false,
  /** history.list answers 500. */
  broken: false,
}));

vi.mock("@/lib/gmail/token", () => ({
  getMailboxAccessToken: vi.fn(async () => ({ accessToken: "test-access-token" })),
  MailboxDisconnectedError: class MailboxDisconnectedError extends Error {},
}));

vi.mock("@/lib/gmail/oauth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/gmail/oauth")>()),
  fetchProfile: vi.fn(async () => ({
    emailAddress: "sender@example.test",
    historyId: gmail.profileHistoryId,
  })),
}));

vi.mock("@/lib/notify/push", () => ({ pushAlert: vi.fn(async () => {}) }));

vi.mock("@/lib/gmail/messages", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/gmail/messages")>();
  return {
    ...actual,
    listHistory: vi.fn(
      async (input: { startHistoryId: string; pageToken?: string | null }) => {
        // Worded the way lib/gmail/messages.ts words them, status included.
        if (gmail.expired) {
          throw new actual.GmailReadError("gmail /history failed (404): history expired", 404);
        }
        if (gmail.broken) {
          throw new actual.GmailReadError("gmail /history failed (500): backendError", 500);
        }
        const after = gmail.history.filter(
          (record) => BigInt(record.id) > BigInt(input.startHistoryId),
        );
        const offset = input.pageToken ? Number(input.pageToken) : 0;
        const end = offset + gmail.pageSize;
        return {
          records: after.slice(offset, end),
          historyId: gmail.currentHistoryId,
          nextPageToken: end < after.length ? String(end) : null,
        };
      },
    ),
    fetchMessage: vi.fn(async (_token: string, id: string) => {
      if (gmail.failing.has(id)) {
        throw new actual.GmailReadError(`gmail /messages/${id} failed (503): backendError`, 503);
      }
      const message = gmail.messages.get(id);
      if (!message) {
        throw new actual.GmailReadError(
          `gmail /messages/${id} failed (404): Requested entity was not found.`,
          404,
        );
      }
      return message;
    }),
  };
});

import { POST as pollReplies } from "@/app/api/cron/poll-replies/route";

import {
  addMember,
  adminClient,
  cleanup,
  createTestOrg,
  createTestUser,
  type TestUser,
} from "../setup/stack";

// The reply poller only moves its cursor past what it has settled, and says so
// when it cannot. Before this, one mailbox's poll threw on every run for four
// weeks behind a cron job that reported success.
//
// Every route call is scoped with ?org= so a run never polls a mailbox this
// file did not create.

const CRON_SECRET = process.env.CRON_SECRET ?? "";
const ZONE = "America/Chicago";

const orgIds: string[] = [];
const userIds: string[] = [];

function admin() {
  return adminClient();
}

async function makeOrg(label: string) {
  const org = await createTestOrg(label);
  orgIds.push(org.id);
  const operator = await createTestUser(`${label}-op`);
  userIds.push(operator.id);
  await addMember(org.id, operator.id, "member");
  return { org, operator };
}

async function makeMailbox(
  orgId: string,
  operator: TestUser,
  overrides: Record<string, unknown> = {},
): Promise<string> {
  const { data, error } = await admin()
    .from("mailboxes")
    .insert({
      org_id: orgId,
      user_id: operator.id,
      email: `sender-${randomUUID().slice(0, 8)}@example.test`,
      display_name: "Ojas",
      timezone: "America/New_York",
      daily_cap: 20,
      last_history_id: "1000",
      last_polled_at: new Date().toISOString(),
      ...overrides,
    })
    .select("id")
    .single();
  if (error) throw new Error(`mailbox: ${error.message}`);
  return data.id as string;
}

/**
 * A lead that has had a first touch, on a Gmail thread the test names. With
 * `fromSheet`, the touch is what 0027 recorded from the outreach sheet: no
 * thread, no Message-ID, only that an email went.
 */
async function makeContactedLead(
  orgId: string,
  operator: TestUser,
  mailboxId: string,
  options: { fromSheet?: boolean } = {},
) {
  const email = `owner-${randomUUID().slice(0, 8)}@prospect.test`;
  const { data, error } = await admin()
    .from("leads")
    .insert({
      org_id: orgId,
      company_name: "Bright Smile Dental",
      work_email: email,
      website: `https://${randomUUID().slice(0, 8)}.prospect.test`,
      timezone: ZONE,
      timezone_source: "import",
      claimed_by: operator.id,
      claimed_at: new Date().toISOString(),
    })
    .select("id")
    .single();
  if (error) throw new Error(`lead: ${error.message}`);

  const threadId = `thread-${randomUUID()}`;
  const now = new Date().toISOString();
  const { error: sendError } = await admin().from("scheduled_sends").insert({
    org_id: orgId,
    lead_id: data.id,
    mailbox_id: mailboxId,
    step_number: 1,
    touch_kind: "first",
    status: "sent",
    scheduled_at: now,
    scheduled_local: now.slice(0, 19),
    prospect_timezone: ZONE,
    sent_at: now,
    ...(options.fromSheet
      ? {}
      : {
          provider_message_id: `gmail-${randomUUID()}`,
          provider_thread_id: threadId,
          rfc822_message_id: `<${randomUUID()}@example.test>`,
        }),
  });
  if (sendError) throw new Error(`sent row: ${sendError.message}`);

  return { id: data.id as string, email, threadId };
}

/** An inbound message, registered with the fake mailbox. */
function inbound(input: {
  threadId?: string;
  from?: string;
  text?: string;
  internalDate?: string;
}): string {
  const id = `msg-${randomUUID()}`;
  const text = input.text ?? "Sounds good. What times work next week?";
  gmail.messages.set(id, {
    id,
    threadId: input.threadId ?? `thread-${randomUUID()}`,
    labelIds: ["INBOX"],
    internalDate: input.internalDate ?? String(Date.now()),
    headers: {
      from: `Dana <${input.from ?? `someone-${randomUUID().slice(0, 6)}@elsewhere.test`}>`,
      subject: "Re: Bright Smile Dental and the calls that ring out",
    },
    text,
    snippet: text,
  });
  return id;
}

interface Report {
  replies: number;
  vanished: number;
  unmatched: number;
  rebaselined: boolean;
  caught_up: boolean;
  stopped?: string;
  error?: string;
}

async function run(orgId: string): Promise<Report> {
  const response = await pollReplies(
    new Request(`http://localhost/api/cron/poll-replies?org=${orgId}`, {
      method: "POST",
      headers: { authorization: `Bearer ${CRON_SECRET}` },
    }),
  );
  expect(response.status).toBe(200);
  const body = (await response.json()) as { reports: Report[] };
  expect(body.reports).toHaveLength(1);
  return body.reports[0]!;
}

async function mailboxState(mailboxId: string) {
  const { data } = await admin()
    .from("mailboxes")
    .select("last_history_id, last_polled_at")
    .eq("id", mailboxId)
    .single();
  return data!;
}

async function repliedEvents(leadId: string) {
  const { data } = await admin()
    .from("lead_events")
    .select("id")
    .eq("lead_id", leadId)
    .eq("type", "replied");
  return data ?? [];
}

async function alerts(orgId: string, tokenPrefix: string) {
  const { data } = await admin()
    .from("alerts")
    .select("kind, message, dedupe_token")
    .eq("org_id", orgId)
    .like("dedupe_token", `${tokenPrefix}%`);
  return data ?? [];
}

// ---------------------------------------------------------------------------

beforeAll(() => {
  if (!CRON_SECRET) {
    throw new Error("CRON_SECRET must be set in .env for these tests.");
  }
});

beforeEach(() => {
  gmail.history = [];
  gmail.pageSize = 100;
  gmail.currentHistoryId = "9000";
  gmail.profileHistoryId = "9500";
  gmail.messages.clear();
  gmail.failing.clear();
  gmail.expired = false;
  gmail.broken = false;
});

afterAll(async () => {
  await cleanup(orgIds, userIds);
}, 120_000);

// ---------------------------------------------------------------------------

describe("poll-replies", () => {
  it("steps over a message deleted before it was read, and records the reply behind it", async () => {
    const { org, operator } = await makeOrg("poll-vanished");
    const mailboxId = await makeMailbox(org.id, operator);
    const lead = await makeContactedLead(org.id, operator, mailboxId);

    // Gmail lists a message that is gone by the time it is fetched. This used
    // to throw out of the run before the cursor was stored, so every later run
    // met the same 404 and nothing behind it was ever read.
    const reply = inbound({ threadId: lead.threadId, from: lead.email });
    gmail.history = [
      { id: "1001", messageIds: ["msg-deleted-forever"] },
      { id: "1002", messageIds: [reply] },
    ];

    const report = await run(org.id);

    expect(report.error).toBeUndefined();
    expect(report.vanished).toBe(1);
    expect(report.replies).toBe(1);
    expect(report.caught_up).toBe(true);
    expect(await repliedEvents(lead.id)).toHaveLength(1);

    const { data: leadAfter } = await admin()
      .from("leads")
      .select("status, halted_at")
      .eq("id", lead.id)
      .single();
    expect(leadAfter?.status).toBe("replied");
    expect(leadAfter?.halted_at).not.toBeNull();

    expect((await mailboxState(mailboxId)).last_history_id).toBe("9000");
  }, 180_000);

  it("matches a reply by address when the lead's only touch came from the sheet", async () => {
    const { org, operator } = await makeOrg("poll-sheet");
    const mailboxId = await makeMailbox(org.id, operator);
    const lead = await makeContactedLead(org.id, operator, mailboxId, { fromSheet: true });

    // A new thread, from the very address we wrote to. The index used to hold
    // addresses only for leads whose sends carried Gmail ids, so this was filed
    // as ordinary mail and the sequence carried on past the reply.
    const reply = inbound({ from: lead.email });
    gmail.history = [{ id: "1001", messageIds: [reply] }];

    const report = await run(org.id);

    expect(report.error).toBeUndefined();
    expect(report.unmatched).toBe(0);
    expect(report.replies).toBe(1);
    expect(await repliedEvents(lead.id)).toHaveLength(1);
  }, 180_000);

  it("holds the cursor at the last settled record when a message cannot be read", async () => {
    const { org, operator } = await makeOrg("poll-flaky");
    const mailboxId = await makeMailbox(org.id, operator);
    const first = await makeContactedLead(org.id, operator, mailboxId);
    const second = await makeContactedLead(org.id, operator, mailboxId);
    const polledBefore = (await mailboxState(mailboxId)).last_polled_at;

    const replyA = inbound({ threadId: first.threadId, from: first.email });
    const flaky = inbound({});
    const replyB = inbound({ threadId: second.threadId, from: second.email });
    gmail.failing.add(flaky);
    gmail.history = [
      { id: "1001", messageIds: [replyA] },
      { id: "1002", messageIds: [flaky] },
      { id: "1003", messageIds: [replyB] },
    ];

    const failed = await run(org.id);

    // What it settled is kept; what it could not read is retried, not skipped.
    expect(failed.error).toContain("503");
    expect(failed.caught_up).toBe(false);
    expect(await repliedEvents(first.id)).toHaveLength(1);
    expect(await repliedEvents(second.id)).toHaveLength(0);

    const held = await mailboxState(mailboxId);
    expect(held.last_history_id).toBe("1001");
    // A failing run is not a poll, so the mailbox shows as stale.
    expect(held.last_polled_at).toBe(polledBefore);

    gmail.failing.clear();
    const recovered = await run(org.id);

    expect(recovered.error).toBeUndefined();
    expect(recovered.caught_up).toBe(true);
    expect(await repliedEvents(second.id)).toHaveLength(1);
    expect(await repliedEvents(first.id)).toHaveLength(1);
    expect((await mailboxState(mailboxId)).last_history_id).toBe("9000");
  }, 180_000);

  it("resumes after the last record it read when the history runs past one run's pages", async () => {
    const { org, operator } = await makeOrg("poll-pages");
    const mailboxId = await makeMailbox(org.id, operator);

    gmail.pageSize = 1;
    gmail.history = ["1001", "1002", "1003", "1004", "1005", "1006", "1007"].map(
      (id) => ({ id, messageIds: [inbound({})] }),
    );

    const partial = await run(org.id);

    // It used to store Gmail's CURRENT history id here, which is past pages 6
    // and 7 that it never read.
    expect(partial.caught_up).toBe(false);
    expect(partial.stopped).toContain("pages");
    expect(partial.unmatched).toBe(5);
    expect((await mailboxState(mailboxId)).last_history_id).toBe("1005");

    const rest = await run(org.id);

    expect(rest.caught_up).toBe(true);
    expect(rest.unmatched).toBe(2);
    expect((await mailboxState(mailboxId)).last_history_id).toBe("9000");
  }, 180_000);

  it("says what was never read when Gmail no longer has the cursor's history", async () => {
    const { org, operator } = await makeOrg("poll-expired");
    const mailboxId = await makeMailbox(org.id, operator);
    gmail.expired = true;

    const report = await run(org.id);

    expect(report.rebaselined).toBe(true);
    expect((await mailboxState(mailboxId)).last_history_id).toBe("9500");

    const gap = await alerts(org.id, "history-gap:");
    expect(gap).toHaveLength(1);
    expect(gap[0]!.kind).toBe("mailbox_auth");
    expect(gap[0]!.message).toContain("reconcile-mailbox-history");
  }, 180_000);

  it("raises one alert a day for a mailbox that has not completed a poll in over an hour", async () => {
    const { org, operator } = await makeOrg("poll-failing");
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    const mailboxId = await makeMailbox(org.id, operator, { last_polled_at: twoHoursAgo });
    gmail.broken = true;

    const first = await run(org.id);
    const second = await run(org.id);

    // The error is in the response body now, which is what pg_net records.
    expect(first.error).toContain("500");
    expect(second.error).toContain("500");

    const failing = await alerts(org.id, "poll-failing:");
    expect(failing).toHaveLength(1);
    expect(failing[0]!.message).toContain("not being read");

    const state = await mailboxState(mailboxId);
    expect(state.last_history_id).toBe("1000");
    expect(new Date(state.last_polled_at as string).toISOString()).toBe(twoHoursAgo);
  }, 180_000);

  it("stays quiet about a single failed run", async () => {
    const { org, operator } = await makeOrg("poll-blip");
    await makeMailbox(org.id, operator);
    gmail.broken = true;

    const report = await run(org.id);

    expect(report.error).toContain("500");
    expect(await alerts(org.id, "poll-failing:")).toHaveLength(0);
  }, 180_000);
});
