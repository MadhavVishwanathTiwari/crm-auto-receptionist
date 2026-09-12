import { randomUUID } from "node:crypto";

import { DateTime } from "luxon";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// No live Gmail grant exists in a test, so the token and the two Gmail reads
// are replaced by a Sent folder the test writes. Everything after that -- the
// lead lookup, record_mailbox_touches(), the triggers -- is the real thing
// against a real database.
const gmail = vi.hoisted(() => ({
  sent: [] as {
    id: string;
    threadId: string;
    internalDate: string;
    headers: Record<string, string>;
  }[],
}));

vi.mock("@/lib/gmail/token", () => ({
  getMailboxAccessToken: vi.fn(async () => ({ accessToken: "test-access-token" })),
  MailboxDisconnectedError: class MailboxDisconnectedError extends Error {},
}));

vi.mock("@/lib/gmail/messages", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/gmail/messages")>();
  return {
    ...actual,
    listMessageIds: vi.fn(async () => gmail.sent.map((message) => message.id)),
    fetchMessageMetadata: vi.fn(async (_token: string, id: string) => {
      const message = gmail.sent.find((m) => m.id === id);
      if (!message) throw new Error(`no such message ${id}`);
      return message;
    }),
  };
});

import { POST as reconcileMailboxes } from "@/app/api/cron/reconcile-mailboxes/route";

import {
  addMember,
  adminClient,
  cleanup,
  createTestOrg,
  createTestUser,
  type TestUser,
} from "../setup/stack";

// The nightly catch-up (0044): an email sent straight from Gmail is recorded,
// once, and a lead in a conversation is left alone.
//
// Every route call is scoped with ?org= so a run against the shared cloud
// project never reads or writes for an org it did not create.

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

async function makeMailbox(orgId: string, operator: TestUser): Promise<string> {
  const { data, error } = await admin()
    .from("mailboxes")
    .insert({
      org_id: orgId,
      user_id: operator.id,
      email: `sender-${randomUUID().slice(0, 8)}@example.test`,
      display_name: "Ojas",
      timezone: "America/New_York",
      daily_cap: 20,
    })
    .select("id")
    .single();
  if (error) throw new Error(`mailbox: ${error.message}`);
  return data.id as string;
}

async function makeLead(orgId: string, operator: TestUser) {
  const email = `Owner-${randomUUID().slice(0, 8)}@Prospect.test`;
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
  return { id: data.id as string, email };
}

/** A message in the mocked Sent folder, `daysAgo` old. */
function sentTo(to: string, daysAgo: number) {
  const id = `gmail-${randomUUID()}`;
  return {
    id,
    threadId: `thread-${randomUUID()}`,
    internalDate: String(DateTime.now().minus({ days: daysAgo }).toMillis()),
    headers: {
      to: `Dana <${to}>`,
      subject: "Bright Smile Dental and the calls that ring out",
      "message-id": `<${randomUUID()}@example.test>`,
    },
  };
}

async function run(orgId: string) {
  const response = await reconcileMailboxes(
    new Request(`http://localhost/api/cron/reconcile-mailboxes?org=${orgId}`, {
      method: "POST",
      headers: { authorization: `Bearer ${CRON_SECRET}` },
    }),
  );
  expect(response.status).toBe(200);
  const body = (await response.json()) as {
    reports: { leads: number; outcomes: Record<string, number> }[];
  };
  return body.reports[0]!;
}

async function sentRows(leadId: string) {
  const { data } = await admin()
    .from("scheduled_sends")
    .select("step_number, status, mailbox_id, provider_message_id")
    .eq("lead_id", leadId)
    .eq("status", "sent");
  return data ?? [];
}

// ---------------------------------------------------------------------------

beforeAll(() => {
  if (!CRON_SECRET) {
    throw new Error("CRON_SECRET must be set in .env for these tests.");
  }
});

beforeEach(() => {
  gmail.sent = [];
});

afterAll(async () => {
  await cleanup(orgIds, userIds);
}, 120_000);

// ---------------------------------------------------------------------------

describe("reconcile-mailboxes", () => {
  it("records an email sent straight from Gmail, once, and ignores warmup", async () => {
    const { org, operator } = await makeOrg("nightly-record");
    const mailboxId = await makeMailbox(org.id, operator);
    const lead = await makeLead(org.id, operator);

    const direct = sentTo(lead.email, 1);
    gmail.sent = [direct, sentTo(`warmup-${randomUUID().slice(0, 6)}@warmup.test`, 1)];

    const first = await run(org.id);
    expect(first.leads).toBe(1);
    expect(first.outcomes).toEqual({ recorded: 1 });

    expect(await sentRows(lead.id)).toEqual([
      { step_number: 1, status: "sent", mailbox_id: mailboxId, provider_message_id: direct.id },
    ]);

    // The next night reads the same days again and changes nothing.
    const second = await run(org.id);
    expect(second.outcomes).toEqual({ already_present: 1 });
    expect(await sentRows(lead.id)).toHaveLength(1);
  });

  it("leaves a lead that has replied alone", async () => {
    const { org, operator } = await makeOrg("nightly-replied");
    await makeMailbox(org.id, operator);
    const lead = await makeLead(org.id, operator);

    const { error } = await admin().from("lead_events").insert({
      org_id: org.id,
      lead_id: lead.id,
      type: "replied",
      actor_id: null,
      dedupe_token: `reply-${randomUUID()}`,
    });
    if (error) throw new Error(`replied: ${error.message}`);

    // The operator answering in Gmail: a conversation, not a touch.
    gmail.sent = [sentTo(lead.email, 1)];

    const report = await run(org.id);
    expect(report.leads).toBe(0);
    expect(await sentRows(lead.id)).toHaveLength(0);
  });
});
