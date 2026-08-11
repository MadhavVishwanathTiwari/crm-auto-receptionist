// Does the grid actually get pushed changes?
//
// The publication is in migration 0010, but a publication alone proves nothing:
// Realtime also has to be switched on for the project, and when it is not, a
// subscription fails quietly and the grid simply stops updating without any
// error a user would see. Worth an assertion rather than an assumption.
//
// This also pins the security property the grid relies on: postgres_changes
// evaluates RLS per subscriber, so a lead in another org must never arrive.

import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  addMember,
  cleanup,
  createTestOrg,
  createTestUser,
  type TestOrg,
  type TestUser,
} from "../setup/stack";

const SUBSCRIBE_TIMEOUT = 20_000;
const EVENT_TIMEOUT = 15_000;

describe("realtime", () => {
  let org: TestOrg;
  let other: TestOrg;
  let user: TestUser;
  let outsider: TestUser;

  beforeAll(async () => {
    org = await createTestOrg("rt");
    other = await createTestOrg("rt-other");
    user = await createTestUser("rt-user");
    outsider = await createTestUser("rt-outsider");
    await addMember(org.id, user.id, "member");
    await addMember(other.id, outsider.id, "member");

    // Realtime authorises with its own copy of the JWT, so RLS on the socket
    // only applies once the token has been handed over.
    for (const person of [user, outsider]) {
      const {
        data: { session },
      } = await person.client.auth.getSession();
      if (!session) throw new Error("Test user has no session.");
      await person.client.realtime.setAuth(session.access_token);
    }
  }, 60_000);

  afterAll(async () => {
    await cleanup([org.id, other.id], [user.id, outsider.id]);
  }, 60_000);

  /** Subscribes and resolves once the socket is actually live. */
  function subscribe(
    person: TestUser,
    name: string,
    onRow: (row: Record<string, unknown>) => void,
  ) {
    const channel = person.client
      .channel(name)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "leads" },
        (payload) => onRow(payload.new as Record<string, unknown>),
      );

    return new Promise<typeof channel>((resolve, reject) => {
      const timer = setTimeout(
        () =>
          reject(
            new Error(
              "Realtime never reached SUBSCRIBED. Is Realtime enabled for this project?",
            ),
          ),
        SUBSCRIBE_TIMEOUT,
      );

      channel.subscribe((status, error) => {
        if (status === "SUBSCRIBED") {
          clearTimeout(timer);
          resolve(channel);
        }
        if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
          clearTimeout(timer);
          reject(new Error(`Realtime subscription failed: ${status} ${error ?? ""}`));
        }
      });
    });
  }

  it("pushes an insert and an update to a member of the org", async () => {
    const received: Array<Record<string, unknown>> = [];
    const channel = await subscribe(user, `rt-${randomUUID()}`, (row) =>
      received.push(row),
    );

    try {
      const { data: lead, error } = await user.client
        .from("leads")
        .insert({
          org_id: org.id,
          company_name: "Realtime Target",
          work_email: `owner-${randomUUID().slice(0, 8)}@realtime.test`,
          rating: 4.6,
        })
        .select("id")
        .single();
      expect(error).toBeNull();
      const leadId = lead!.id as string;

      await user.client
        .from("leads")
        .update({ company_name: "Realtime Target Renamed" })
        .eq("id", leadId);

      const deadline = Date.now() + EVENT_TIMEOUT;
      while (
        Date.now() < deadline &&
        !received.some((row) => row.company_name === "Realtime Target Renamed")
      ) {
        await new Promise((r) => setTimeout(r, 250));
      }

      const ids = received.map((row) => row.id);
      expect(ids).toContain(leadId);
      expect(
        received.some((row) => row.company_name === "Realtime Target Renamed"),
      ).toBe(true);
    } finally {
      await user.client.removeChannel(channel);
    }
  }, 120_000);

  it("does not push another org's leads", async () => {
    const received: Array<Record<string, unknown>> = [];
    const channel = await subscribe(outsider, `rt-out-${randomUUID()}`, (row) =>
      received.push(row),
    );

    try {
      const { error } = await user.client.from("leads").insert({
        org_id: org.id,
        company_name: "Not Yours",
        work_email: `secret-${randomUUID().slice(0, 8)}@realtime.test`,
        rating: 4.1,
      });
      expect(error).toBeNull();

      // No positive signal to wait for, so wait out the window and assert the
      // absence. RLS is evaluated per subscriber on the socket.
      await new Promise((r) => setTimeout(r, 6000));
      expect(received.some((row) => row.company_name === "Not Yours")).toBe(false);
    } finally {
      await outsider.client.removeChannel(channel);
    }
  }, 120_000);
});
