// Outreach history surviving the trip out of the Google Sheet.
//
// The sibling of lead-owner-import.test.ts. That suite proves ownership
// crosses over; this one proves what was already SENT crosses over, so a lead
// that received three emails resumes at T4 instead of starting again at T1.
//
// The load-bearing assertion in here is not "an event was written". It is that
// nextStepFor() — the real function /write uses, imported rather than
// reimplemented — returns the right step afterwards. Events alone would derive
// status `sent`, which opens the planner's gate, over a step count of zero,
// which restarts the sequence. That combination is the bug, and only checking
// the step catches it.
//
// Everything here needs a real database: the status recompute is a
// statement-level trigger, the timezone refusal is a trigger that binds the
// service role, and the admin check reads auth.uid() through SECURITY DEFINER.

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { nextStepFor, type WriteSend } from "@/lib/write/context";

import {
  addMember,
  adminClient,
  cleanup,
  createTestOrg,
  createTestUser,
  type TestOrg,
  type TestUser,
} from "../setup/stack";

interface BackfillRow {
  lead_id: string;
  company: string;
  sheet_status: string | null;
  touches: number;
  next_step: number | null;
  outcome: string;
  detail: string | null;
}

describe("sheet touch history", () => {
  let org: TestOrg;
  let owner: TestUser; // admin, runs the backfill
  let mate: TestUser; // plain member

  const admin = () => adminClient();

  /**
   * A lead as the legacy importer left it: the sheet's columns sitting in
   * `raw`, and nothing in the pipeline that knows they exist.
   */
  async function seedLead(
    company: string,
    raw: Record<string, string>,
    overrides: Record<string, unknown> = {},
  ): Promise<string> {
    const { data, error } = await admin()
      .from("leads")
      .insert({
        org_id: org.id,
        company_name: company,
        work_email: `${company.toLowerCase().replace(/[^a-z0-9]/g, "")}@sheet.test`,
        website: `https://${company.toLowerCase().replace(/[^a-z0-9]/g, "")}.test`,
        timezone: "America/New_York",
        timezone_source: "manual",
        raw: { company_name: company, status: "", first_touch: "", ...raw },
        ...overrides,
      })
      .select("id")
      .single();
    if (error) throw new Error(`Could not seed ${company}: ${error.message}`);
    return data.id as string;
  }

  async function runBackfill(
    args: Record<string, unknown> = {},
  ): Promise<BackfillRow[]> {
    const { data, error } = await owner.client.rpc(
      "backfill_sheet_touch_history",
      { p_dry_run: false, ...args },
    );
    if (error) throw new Error(`backfill failed: ${error.message}`);
    return (data ?? []) as BackfillRow[];
  }

  const rowFor = (rows: BackfillRow[], id: string) =>
    rows.find((r) => r.lead_id === id);

  /** The sends for one lead, shaped the way lib/write/context.ts reads them. */
  async function sendsFor(leadId: string): Promise<WriteSend[]> {
    const { data } = await admin()
      .from("scheduled_sends")
      .select(
        "id, lead_id, mailbox_id, step_number, status, scheduled_at, scheduled_local, sent_at, composed_body, composed_subject",
      )
      .eq("lead_id", leadId)
      .order("step_number");
    return (data ?? []) as unknown as WriteSend[];
  }

  beforeAll(async () => {
    org = await createTestOrg("sheet-touch");
    owner = await createTestUser("sheet-owner");
    mate = await createTestUser("sheet-mate");
    await addMember(org.id, owner.id, "admin");
    await addMember(org.id, mate.id, "member");
  }, 60_000);

  afterAll(async () => {
    await cleanup([org.id], [owner.id, mate.id]);
  }, 60_000);

  // -------------------------------------------------------------------------

  it("records every touch as a sent send plus a backdated event", async () => {
    const id = await seedLead("Three Co", {
      status: "third_touch",
      first_touch: "16/07/26 18:36",
      second_touch: "22/07/26 19:32",
      third_touch: "05/08/26 22:29",
    });

    const report = await runBackfill();
    const row = rowFor(report, id);

    expect(row?.outcome).toBe("recorded");
    expect(row?.touches).toBe(3);
    expect(row?.next_step).toBe(4);

    // --- the sends ----------------------------------------------------------
    const sends = await sendsFor(id);
    expect(sends).toHaveLength(3);
    expect(sends.map((s) => s.step_number)).toEqual([1, 2, 3]);
    expect(sends.every((s) => s.status === "sent")).toBe(true);

    // Day-first, read in IST. 16/07/26 18:36 +05:30 is 13:06 UTC on 16 July.
    expect(new Date(sends[0]!.sent_at!).toISOString()).toBe(
      "2026-07-16T13:06:00.000Z",
    );
    expect(new Date(sends[2]!.sent_at!).toISOString()).toBe(
      "2026-08-05T16:59:00.000Z",
    );

    const { data: full } = await admin()
      .from("scheduled_sends")
      .select("touch_kind, mailbox_id, template_id, cap_date, rendered_body, prospect_timezone")
      .eq("lead_id", id)
      .eq("step_number", 1)
      .single();

    expect(full?.touch_kind).toBe("first");
    // The sheet records neither the account nor the copy, and a historical send
    // must not consume a live mailbox's daily cap.
    expect(full?.mailbox_id).toBeNull();
    expect(full?.template_id).toBeNull();
    expect(full?.cap_date).toBeNull();
    expect(full?.rendered_body).toBeNull();
    expect(full?.prospect_timezone).toBe("America/New_York");

    // --- the events ---------------------------------------------------------
    const { data: events } = await admin()
      .from("lead_events")
      .select("type, occurred_at, dedupe_token, payload, scheduled_send_id, actor_id")
      .eq("lead_id", id)
      .eq("type", "sent")
      .order("occurred_at");

    expect(events).toHaveLength(3);
    expect(events!.map((e) => e.dedupe_token)).toEqual([
      "sheet:first_touch",
      "sheet:second_touch",
      "sheet:third_touch",
    ]);
    // Backdated to when it actually went out, not to when this pass ran.
    expect(new Date(events![0]!.occurred_at as string).toISOString()).toBe(
      "2026-07-16T13:06:00.000Z",
    );
    // The dispatcher writes its own `sent` event with a null actor; the sheet
    // names a lead owner, not a sender, so this matches rather than inventing.
    expect(events![0]!.actor_id).toBeNull();
    expect(events![0]!.scheduled_send_id).toBe(sends[0]!.id);
    expect((events![0]!.payload as Record<string, string>).source).toBe(
      "sheet_import",
    );

    // --- the derived status -------------------------------------------------
    const { data: lead } = await admin()
      .from("leads")
      .select("status")
      .eq("id", id)
      .single();
    expect(lead?.status).toBe("sent");

    // --- and the thing all of it exists for ---------------------------------
    const step = nextStepFor(sends);
    expect(step.ok).toBe(true);
    expect(step.ok && step.step).toBe(4);
  }, 120_000);

  // The 21 rows that made this worth checking: the sheet's own status column
  // says one touch while the timestamps record three. Resuming from `status`
  // would send a second T2 and a second T3 to a business that already had both.
  it("counts the timestamps, not the sheet's status column", async () => {
    const id = await seedLead("Liar Co", {
      status: "first_touch",
      first_touch: "20/07/26 19:14",
      second_touch: "05/08/26 04:39",
      third_touch: "13/08/26 02:13",
    });

    const row = rowFor(await runBackfill(), id);
    expect(row?.sheet_status).toBe("first_touch");
    expect(row?.touches).toBe(3);
    expect(row?.next_step).toBe(4);

    const step = nextStepFor(await sendsFor(id));
    expect(step.ok && step.step).toBe(4);
  }, 120_000);

  // 121 of the real values have a first component above 12 and none has a
  // second above 12, so day-first is proved by the data rather than assumed.
  // 05/08/26 is 5 August; month-first would make it 8 May and put every
  // follow-up's cadence three months out.
  it("reads the date day-first", async () => {
    const id = await seedLead("Dayfirst Co", {
      status: "first_touch",
      first_touch: "05/08/26 22:29",
    });

    await runBackfill();
    const sends = await sendsFor(id);
    expect(new Date(sends[0]!.sent_at!).toISOString()).toBe(
      "2026-08-05T16:59:00.000Z",
    );
  }, 120_000);

  // Six distinct string shapes exist in the real column. A parser that only
  // handled the common one would silently drop a touch and restart that lead a
  // step early, which is a real second email to a real business.
  it("parses every shape the sheet actually contains", async () => {
    const cases: Array<[string, string, string]> = [
      ["Plain Co", "04/08/26 02:15", "2026-08-03T20:45:00.000Z"],
      ["Longyear Co", "04/08/2026 23:35", "2026-08-04T18:05:00.000Z"],
      ["Seconds Co", "06/08/2026 02:20:00", "2026-08-05T20:50:00.000Z"],
      ["Shortsec Co", "10/08/26 22:48:00", "2026-08-10T17:18:00.000Z"],
      ["Spaced Co", "31/ 07/26 13:47", "2026-07-31T08:17:00.000Z"],
      ["Slashed Co", "11/08/26/ 21:40", "2026-08-11T16:10:00.000Z"],
    ];

    const ids: Array<[string, string]> = [];
    for (const [company, value] of cases) {
      ids.push([company, await seedLead(company, { first_touch: value })]);
    }

    const report = await runBackfill();

    for (const [i, [company, id]] of ids.entries()) {
      expect(rowFor(report, id)?.outcome, company).toBe("recorded");
      const sends = await sendsFor(id);
      expect(sends, company).toHaveLength(1);
      expect(new Date(sends[0]!.sent_at!).toISOString(), company).toBe(
        cases[i]![2],
      );
    }
  }, 180_000);

  it("reports a cell it cannot read instead of guessing at it", async () => {
    const id = await seedLead("Garbage Co", {
      first_touch: "sometime last Tuesday",
    });

    const row = rowFor(await runBackfill(), id);
    expect(row?.outcome).toBe("unparseable");
    expect(await sendsFor(id)).toHaveLength(0);
  }, 120_000);

  // -------------------------------------------------------------------------

  // The all-or-nothing rule, and the most important negative test in the file.
  // scheduled_sends refuses a lead with no zone, by a trigger that binds the
  // service role. If the events were written anyway the lead would derive
  // status `sent` — which the planner accepts — over a step count of zero,
  // which is exactly the restart-at-T1 bug this migration exists to prevent.
  it("writes neither sends nor events for a lead with no timezone", async () => {
    const id = await seedLead(
      "Zoneless Co",
      { status: "second_touch", first_touch: "20/07/26 19:14", second_touch: "05/08/26 04:39" },
      { timezone: null, timezone_source: null },
    );

    const row = rowFor(await runBackfill(), id);
    expect(row?.outcome).toBe("no_timezone");
    expect(row?.touches).toBe(2);

    expect(await sendsFor(id)).toHaveLength(0);

    const { data: events } = await admin()
      .from("lead_events")
      .select("id")
      .eq("lead_id", id)
      .eq("type", "sent");
    expect(events).toHaveLength(0);

    // Still `imported`, so the planner's gate stays shut rather than opening
    // over a step count that would restart the sequence.
    const { data: lead } = await admin()
      .from("leads")
      .select("status")
      .eq("id", id)
      .single();
    expect(lead?.status).toBe("imported");

    // resolve-timezones runs hourly and this pass is re-runnable, so the lead
    // is picked up once it has a zone. That is the reason skipping is safe.
    const { error } = await admin()
      .from("leads")
      .update({ timezone: "America/Chicago", timezone_source: "manual" })
      .eq("id", id);
    expect(error).toBeNull();

    const second = rowFor(await runBackfill(), id);
    expect(second?.outcome).toBe("recorded");
    expect(await sendsFor(id)).toHaveLength(2);
  }, 120_000);

  it("refuses a gap rather than compressing it", async () => {
    const id = await seedLead("Gappy Co", {
      first_touch: "20/07/26 19:14",
      second_touch: "",
      third_touch: "13/08/26 02:13",
    });

    const row = rowFor(await runBackfill(), id);
    expect(row?.outcome).toBe("gap");
    // Compressing 1 and 3 into steps 1 and 2 would claim a touch happened that
    // did not, and would resume this lead one step early.
    expect(await sendsFor(id)).toHaveLength(0);
  }, 120_000);

  it("refuses touch timestamps that run backwards", async () => {
    const id = await seedLead("Backwards Co", {
      first_touch: "13/08/26 02:13",
      second_touch: "20/07/26 19:14",
    });

    const row = rowFor(await runBackfill(), id);
    expect(row?.outcome).toBe("out_of_order");
    expect(await sendsFor(id)).toHaveLength(0);
  }, 120_000);

  it("leaves a lead the sheet never touched alone", async () => {
    const id = await seedLead("Pending Co", { status: "pending" });

    const row = rowFor(await runBackfill(), id);
    expect(row?.outcome).toBe("no_touches");
    expect(row?.next_step).toBeNull();
    expect(await sendsFor(id)).toHaveLength(0);

    const { data: lead } = await admin()
      .from("leads")
      .select("status")
      .eq("id", id)
      .single();
    expect(lead?.status).toBe("imported");
  }, 120_000);

  // -------------------------------------------------------------------------

  it("is idempotent: a second pass writes nothing new", async () => {
    const id = await seedLead("Twice Co", {
      status: "second_touch",
      first_touch: "22/07/26 19:59",
      second_touch: "06/08/26 21:45",
    });

    expect(rowFor(await runBackfill(), id)?.outcome).toBe("recorded");

    const first = await sendsFor(id);
    expect(first).toHaveLength(2);

    const second = rowFor(await runBackfill(), id);
    expect(second?.outcome).toBe("already_present");
    expect(second?.next_step).toBe(3);

    // Same rows, not new ones: unique (lead_id, type, dedupe_token) on the
    // events, and the step check on the sends.
    const after = await sendsFor(id);
    expect(after).toHaveLength(2);
    expect(after.map((s) => s.id).sort()).toEqual(first.map((s) => s.id).sort());

    const { data: events } = await admin()
      .from("lead_events")
      .select("id")
      .eq("lead_id", id)
      .eq("type", "sent");
    expect(events).toHaveLength(2);
  }, 120_000);

  it("writes nothing on a dry run", async () => {
    const id = await seedLead("Preview Co", {
      status: "first_touch",
      first_touch: "12/08/26 01:57",
    });

    const { data, error } = await owner.client.rpc(
      "backfill_sheet_touch_history",
      { p_dry_run: true },
    );
    expect(error).toBeNull();

    const row = rowFor((data ?? []) as BackfillRow[], id);
    expect(row?.outcome).toBe("recorded");
    expect(row?.next_step).toBe(2);

    // Re-read privileged. A dry run that quietly wrote would be invisible in
    // the RPC's own output.
    expect(await sendsFor(id)).toHaveLength(0);
    const { data: events } = await admin()
      .from("lead_events")
      .select("id")
      .eq("lead_id", id);
    expect(events).toHaveLength(0);
  }, 120_000);

  // -------------------------------------------------------------------------

  it("turns a removed row into do-not-contact plus a suppression", async () => {
    const id = await seedLead("Removed Co", {
      status: "removed",
      first_touch: "22/07/26 19:14",
    });

    const row = rowFor(await runBackfill(), id);
    expect(row?.outcome).toBe("do_not_contact");
    // A closed lead resumes at no step at all, whatever its history says.
    expect(row?.next_step).toBeNull();

    const { data: lead } = await admin()
      .from("leads")
      .select("status, terminal_outcome, work_email_norm, website_domain")
      .eq("id", id)
      .single();
    expect(lead?.terminal_outcome).toBe("do_not_contact");
    // terminal_outcome beats the `sent` events in app.lead_status_from_events.
    expect(lead?.status).toBe("do_not_contact");

    // The touch it did receive is still recorded. It happened.
    expect(await sendsFor(id)).toHaveLength(1);

    const { data: sup } = await admin()
      .from("suppressions")
      .select("email_norm, domain, reason, lead_id")
      .eq("lead_id", id);

    expect(sup).toHaveLength(1);
    expect(sup![0]!.email_norm).toBe(lead?.work_email_norm);
    // Email, not domain. `removed` may have meant "wrong contact" as easily as
    // "this company said no", and the domain hammer kills every future lead
    // there.
    expect(sup![0]!.domain).toBeNull();
    // Not `unsubscribed` or `complaint`: those assert something about what the
    // prospect did, and all the sheet records is that somebody took the row out.
    expect(sup![0]!.reason).toBe("manual_dnc");

    // Idempotent too: no second suppression, no second closed event.
    expect(rowFor(await runBackfill(), id)?.outcome).toBe("already_closed");
    const { data: again } = await admin()
      .from("suppressions")
      .select("id")
      .eq("lead_id", id);
    expect(again).toHaveLength(1);
  }, 120_000);

  it("suppresses the domain only when asked", async () => {
    const id = await seedLead("Domainwide Co", { status: "removed" });

    await runBackfill({ p_suppress_domain: true });

    const { data: sup } = await admin()
      .from("suppressions")
      .select("email_norm, domain")
      .eq("lead_id", id);

    expect(sup).toHaveLength(2);
    expect(sup!.some((s) => s.domain === "domainwideco.test")).toBe(true);
    expect(sup!.some((s) => s.email_norm !== null)).toBe(true);
  }, 120_000);

  it("leaves removed rows alone when told not to close them", async () => {
    const id = await seedLead("Keepme Co", {
      status: "removed",
      first_touch: "22/07/26 19:14",
    });

    const row = rowFor(await runBackfill({ p_close_removed: false }), id);
    expect(row?.outcome).toBe("recorded");
    expect(row?.next_step).toBe(2);

    const { data: lead } = await admin()
      .from("leads")
      .select("terminal_outcome")
      .eq("id", id)
      .single();
    expect(lead?.terminal_outcome).toBeNull();

    const { data: sup } = await admin()
      .from("suppressions")
      .select("id")
      .eq("lead_id", id);
    expect(sup).toHaveLength(0);
  }, 120_000);

  // -------------------------------------------------------------------------

  it("refuses to overwrite a send that is already booked", async () => {
    const id = await seedLead("Booked Co", {
      status: "first_touch",
      first_touch: "22/07/26 19:14",
    });

    const { error } = await admin().from("scheduled_sends").insert({
      org_id: org.id,
      lead_id: id,
      step_number: 1,
      touch_kind: "first",
      status: "planned",
      scheduled_at: "2027-01-04T14:00:00Z",
      scheduled_local: "2027-01-04T09:00:00",
      prospect_timezone: "America/New_York",
      // A live row needs words, per scheduled_sends_require_content. Written
      // ones need no template fixture.
      composed_subject: "already booked",
      composed_body: "already booked",
    });
    expect(error).toBeNull();

    const row = rowFor(await runBackfill(), id);
    expect(row?.outcome).toBe("step_conflict");

    // The live row is untouched, and no historical one was added beside it.
    const sends = await sendsFor(id);
    expect(sends).toHaveLength(1);
    expect(sends[0]!.status).toBe("planned");
  }, 120_000);

  // 0027 widened scheduled_sends_require_content so a historical row may carry
  // neither a template nor a body. This is the fence around that: a row that
  // could still be DISPATCHED is bound exactly as it was before, because a
  // wordless planned row is one the dispatcher cannot send.
  it("still refuses a live send with no words", async () => {
    const id = await seedLead("Wordless Co", { status: "pending" });

    const { error } = await admin().from("scheduled_sends").insert({
      org_id: org.id,
      lead_id: id,
      step_number: 1,
      touch_kind: "first",
      status: "planned",
      scheduled_at: "2027-01-04T14:00:00Z",
      scheduled_local: "2027-01-04T09:00:00",
      prospect_timezone: "America/New_York",
    });

    expect(error).not.toBeNull();
    expect(error?.message).toContain("template or a written body");

    // And `sent` alone is not the loophole either: the exemption also requires
    // the instant it actually went out.
    const { error: noSentAt } = await admin().from("scheduled_sends").insert({
      org_id: org.id,
      lead_id: id,
      step_number: 2,
      touch_kind: "followup",
      status: "sent",
      scheduled_at: "2027-01-04T14:00:00Z",
      scheduled_local: "2027-01-04T09:00:00",
      prospect_timezone: "America/New_York",
    });
    expect(noSentAt).not.toBeNull();

    expect(await sendsFor(id)).toHaveLength(0);
  }, 120_000);

  it("refuses a plain member, and the refusal is a refusal", async () => {
    const id = await seedLead("Member Co", {
      status: "first_touch",
      first_touch: "22/07/26 19:14",
    });

    const { error } = await mate.client.rpc("backfill_sheet_touch_history", {
      p_dry_run: false,
    });
    expect(error).not.toBeNull();
    expect(error?.message).toContain("admin");

    // Re-read as a privileged client. A PostgREST write refused by RLS comes
    // back 204 with no error at all, so asserting on the error alone would pass
    // against a policy that does nothing.
    expect(await sendsFor(id)).toHaveLength(0);
    const { data: events } = await admin()
      .from("lead_events")
      .select("id")
      .eq("lead_id", id);
    expect(events).toHaveLength(0);
  }, 120_000);

  it("rejects a zone name it does not recognise", async () => {
    const { error } = await owner.client.rpc("backfill_sheet_touch_history", {
      p_zone: "Mars/Olympus_Mons",
      p_dry_run: true,
    });
    // Not 262 identical `unparseable` rows for a reason that has nothing to do
    // with the data.
    expect(error).not.toBeNull();
    expect(error?.message).toContain("time zone");
  }, 120_000);

  it("does not reach into another org", async () => {
    const otherOrg = await createTestOrg("sheet-touch-other");
    try {
      const { data: seeded } = await admin()
        .from("leads")
        .insert({
          org_id: otherOrg.id,
          company_name: "Outsider Co",
          work_email: "outsider@elsewhere.test",
          timezone: "America/New_York",
          timezone_source: "manual",
          raw: { status: "first_touch", first_touch: "22/07/26 19:14" },
        })
        .select("id")
        .single();

      const report = await runBackfill();
      expect(rowFor(report, seeded!.id)).toBeUndefined();

      const { data: sends } = await admin()
        .from("scheduled_sends")
        .select("id")
        .eq("lead_id", seeded!.id);
      expect(sends).toHaveLength(0);
    } finally {
      await cleanup([otherOrg.id], []);
    }
  }, 120_000);
});
