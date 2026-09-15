import { describe, expect, it } from "vitest";

import { describeRun } from "@/lib/ops/describeRun";

function poll(reports: Record<string, unknown>[]) {
  return {
    job: "poll-replies",
    ok: true,
    status: 200,
    body: { mailboxes: reports.length, reports },
  };
}

function report(mailbox: string, counts: Record<string, unknown> = {}) {
  return {
    mailbox,
    examined: 0,
    replies: 0,
    bounces: 0,
    unsubscribes: 0,
    ignored: 0,
    unmatched: 0,
    vanished: 0,
    rebaselined: false,
    caught_up: true,
    ...counts,
  };
}

describe("what Poll replies says it did", () => {
  it("names the unsubscribe it found, not 'Done.'", () => {
    // The run from the E2E pass (15 Sep, lead 2's "remove me"), which the panel
    // reported as "Done." above a toggle.
    const result = describeRun(
      poll([
        report("madhav@tryautoreceptionist.com", { examined: 1, unsubscribes: 1 }),
        report("ojas@getautoreceptionist.com"),
      ]),
    );
    expect(result.problem).toBe(false);
    expect(result.text).toBe("Found 1 unsubscribe. That lead's emails are stopped; see Alerts.");
  });

  it("totals across mailboxes", () => {
    const result = describeRun(
      poll([
        report("a@x.test", { examined: 3, replies: 2 }),
        report("b@x.test", { examined: 2, replies: 1, bounces: 1 }),
      ]),
    );
    expect(result.text).toBe("Found 3 replies, 1 bounce. Those leads' emails are stopped; see Alerts.");
  });

  it("says when it read mail and none of it was from a lead", () => {
    expect(describeRun(poll([report("a@x.test", { examined: 4, ignored: 3, unmatched: 1 })])).text).toBe(
      "Read 4 new messages; none was a reply, bounce or unsubscribe from a lead.",
    );
  });

  it("says when there was nothing new", () => {
    expect(describeRun(poll([report("a@x.test"), report("b@x.test")])).text).toBe(
      "Nothing new in any mailbox.",
    );
  });

  it("flags a mailbox that could not be read, even inside a 200", () => {
    const result = describeRun(
      poll([
        report("a@x.test", { examined: 1, replies: 1 }),
        report("b@x.test", { caught_up: false, error: "invalid_grant" }),
      ]),
    );
    expect(result.problem).toBe(true);
    expect(result.text).toContain("Found 1 reply.");
    expect(result.text).toContain("b@x.test could not be read: invalid_grant");
  });

  it("asks for another run when a mailbox stopped short", () => {
    const result = describeRun(
      poll([report("a@x.test", { examined: 40, caught_up: false, stopped: "out of time" })]),
    );
    expect(result.problem).toBe(true);
    expect(result.text).toContain("a@x.test stopped before the end (out of time); run it again.");
  });

  it("explains a rebaselined cursor", () => {
    expect(describeRun(poll([report("a@x.test", { rebaselined: true })])).text).toContain(
      "restarted from now",
    );
  });
});

describe("the other runs", () => {
  it("still describes resolve-timezones", () => {
    const result = describeRun({
      job: "resolve-timezones",
      ok: true,
      status: 200,
      body: { resolved: 2, unresolved: 0, placed: 1, unplaced: 12, deferred: 0, more: false },
    });
    expect(result.text).toBe(
      "Gave 3 leads a timezone: 2 from coordinates, 1 from their city. 12 leads still need one set by hand on the lead, and are never scheduled until then.",
    );
  });

  it("reports a failed route as a problem", () => {
    expect(
      describeRun({ job: "poll-replies", ok: false, status: 500, body: { error: "boom" } }),
    ).toEqual({ text: "Failed (500). boom", problem: true });
  });

  it("falls back to 'Done.' for a job with no sentence", () => {
    expect(describeRun({ job: "plan-sends", ok: true, status: 200, body: {} })).toEqual({
      text: "Done.",
      problem: false,
    });
  });
});
