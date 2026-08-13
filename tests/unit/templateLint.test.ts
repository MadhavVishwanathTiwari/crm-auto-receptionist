import { describe, expect, it } from "vitest";

import {
  lintsClean,
  lintTemplate,
  lintTemplateRules,
  unknownVariables,
} from "@/lib/templates/lint";
import { buildTemplateValues, renderTemplate } from "@/lib/templates/render";

import { CLEAN_BODY, CLEAN_SUBJECT, TEMPLATE_VECTORS } from "../fixtures/template-vectors";

describe("the copy linter", () => {
  for (const vector of TEMPLATE_VECTORS) {
    it(`reports ${vector.expected.join(", ") || "nothing"} for ${vector.label}`, () => {
      expect(lintTemplateRules(vector.subject, vector.body)).toEqual(vector.expected);
    });
  }

  it("attaches a sentence to every rule it reports", () => {
    const violations = lintTemplate("Quick question —", "Interested? Want a demo?");
    expect(violations.length).toBeGreaterThan(0);
    for (const violation of violations) {
      expect(violation.message.trim().length).toBeGreaterThan(10);
    }
  });

  it("names the variables it did not recognise", () => {
    expect(unknownVariables(CLEAN_SUBJECT, "Hi {{firstname}} at {{companyname}}?")).toEqual([
      "firstname",
      "companyname",
    ]);
  });

  it("does not mistake `for` or `word` for the binary close's `or`", () => {
    // The close test looks for a standalone "or". Without word boundaries,
    // "for" and "word" both satisfy it and every open-ended question passes.
    const body = [
      "Hi {{first_name}},",
      "",
      "You are losing calls for {{company_name}}, word for word the same story.",
      "",
      "What should I do?",
    ].join("\n");
    expect(lintTemplateRules("Subject", body)).toContain("binary_close");
  });

  it("lets the reference template through", () => {
    expect(lintsClean(CLEAN_SUBJECT, CLEAN_BODY)).toBe(true);
  });
});

describe("rendering", () => {
  const lead = {
    first_name: "Dana",
    last_name: "Reyes",
    company_name: "Bright Smile Dental",
    city: "Austin",
    state: "TX",
    industry: "Dentist",
    demo_txt_url: null,
    demo_web_url: null,
  };

  const evidence = {
    // A `timestamp` reading, frozen at audit time. No offset, on purpose.
    audited_at_local: "2026-08-11T03:12:00",
    audit_timezone: "America/Chicago",
    outcome: "no response",
    response_delay_seconds: null,
  };

  it("quotes the audit's own wall clock, not a recomputed one", () => {
    const values = buildTemplateValues({ lead, evidence, senderName: "Ojas" });
    expect(values.audit_time_local).toBe("3:12am");
    expect(values.audit_day_local).toBe("Tuesday");
    // Null delay means they never answered, which is the strongest version of
    // the pitch and must never render as "0 seconds later".
    expect(values.response_delay).toBe("never got a reply");
  });

  it("reports a hollow variable instead of rendering an empty string", () => {
    const values = buildTemplateValues({ lead, evidence, senderName: null });
    const result = renderTemplate("Thanks,\n{{sender_name}}", values);

    expect(result.missing).toEqual(["sender_name"]);
    // Left in place, so a half-rendered email is obviously half-rendered.
    expect(result.text).toContain("{{sender_name}}");
  });

  it("substitutes every known variable in the reference template", () => {
    const values = buildTemplateValues({ lead, evidence, senderName: "Ojas" });
    const result = renderTemplate(CLEAN_BODY, values);

    expect(result.missing).toEqual([]);
    expect(result.text).toContain("Dana");
    expect(result.text).toContain("Bright Smile Dental");
    expect(result.text).not.toContain("{{");
  });
});
