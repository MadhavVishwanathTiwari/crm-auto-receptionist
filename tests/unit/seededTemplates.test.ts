import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { lintTemplateRules, TEMPLATE_VARIABLES } from "@/lib/templates/lint";
import { renderTemplate } from "@/lib/templates/render";

// The seed migration is the source of truth, not a copy of it. Reading the SQL
// means the day someone edits the copy in place, this test moves with it.
const SQL = readFileSync("supabase/migrations/0019_seed_templates.sql", "utf8");

const SUBJECTS = [...SQL.matchAll(/\$subj\$([\s\S]*?)\$subj\$/g)].map((m) => m[1]!);
const BODIES = [...SQL.matchAll(/\$tpl\$([\s\S]*?)\$tpl\$/g)].map((m) => m[1]!);

/**
 * The seeded copy has to be activatable.
 *
 * app.template_lint() runs in a trigger the moment is_active flips, so a seeded
 * template that does not lint clean is a migration that ships an email nobody
 * can turn on. Catching that here costs a second; catching it in the UI costs
 * an operator their first send.
 */
describe("the seeded templates", () => {
  it("seeds four touches", () => {
    expect(SUBJECTS).toHaveLength(4);
    expect(BODIES).toHaveLength(4);
  });

  for (let i = 0; i < 4; i++) {
    it(`lints clean at step ${i + 1}`, () => {
      expect(lintTemplateRules(SUBJECTS[i]!, BODIES[i]!)).toEqual([]);
    });
  }

  it("renders with nothing left hollow when the lead is fully populated", () => {
    // renderTemplate refuses nothing; the DISPATCHER skips a send whose render
    // reported a missing variable. So "which variables does this copy demand"
    // is the question that decides whether a lead can be sent to at all.
    const values = Object.fromEntries(
      TEMPLATE_VARIABLES.map((name) => [name, `<${name}>`]),
    );

    for (const text of [...SUBJECTS, ...BODIES]) {
      expect(renderTemplate(text, values).missing).toEqual([]);
    }
  });

  it("never asks for first_name, which is null on plenty of scraped rows", () => {
    // Not a style rule. A template that interpolates a variable the lead does
    // not have is skipped at dispatch and alerted on, which looks like the
    // pipeline stalling rather than like a copy decision.
    for (const text of [...SUBJECTS, ...BODIES]) {
      expect(text).not.toContain("{{first_name}}");
    }
  });
});
