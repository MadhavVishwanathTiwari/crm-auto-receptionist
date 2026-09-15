import { describe, expect, it } from "vitest";

import { classifyLead, suppressionIndex, type BlockerLead } from "@/lib/queue/blockers";

const READY: BlockerLead = {
  status: "queued",
  claimed_by: "user-1",
  timezone: "America/Phoenix",
  is_qualified: true,
  halted_at: null,
  terminal_outcome: null,
  work_email_norm: "owner@prospect.test",
  website_domain: "prospect.test",
};

const NONE = suppressionIndex([]);

describe("classifyLead", () => {
  it("is ready with nothing booked", () => {
    expect(classifyLead(READY, NONE)).toBe("ready");
  });

  it("is booked, not ready, once an email is booked", () => {
    // /queue listed these under "Ready to send".
    expect(classifyLead(READY, NONE, true)).toBe("booked");
  });

  it("is booked even when never audited, because writing it was the decision", () => {
    expect(classifyLead({ ...READY, status: "claimed" }, NONE, true)).toBe("booked");
  });

  it("still says halted or suppressed first", () => {
    expect(classifyLead({ ...READY, halted_at: "2026-09-01T00:00:00Z" }, NONE, true)).toBe(
      "halted",
    );
    const suppressed = suppressionIndex([{ email_norm: "owner@prospect.test", domain: null }]);
    expect(classifyLead(READY, suppressed, true)).toBe("suppressed");
  });
});
