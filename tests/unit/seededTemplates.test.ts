import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { lintTemplateRules, TEMPLATE_VARIABLES } from "@/lib/templates/lint";
import { renderTemplate } from "@/lib/templates/render";

// The seed migrations are the source of truth, not a copy of them. Reading the
// SQL means the day someone edits the copy in place, this test moves with it.
//
// Two sets, and the difference between them is the point. 0019 quotes the audit
// back, so it can only be sent to a lead somebody audited. 0022 quotes nothing,
// so it can be sent to the rest of an import. Both have to lint clean, and the
// second has to demand strictly less data than the first.
const AUDIT_SQL = readFileSync(
  "supabase/migrations/0019_seed_templates.sql",
  "utf8",
);
const GENERIC_SQL = readFileSync(
  "supabase/migrations/0022_unaudited_sequence.sql",
  "utf8",
);

const subjects = (sql: string) =>
  [...sql.matchAll(/\$subj\$([\s\S]*?)\$subj\$/g)].map((m) => m[1]!);
const bodies = (sql: string) =>
  [...sql.matchAll(/\$tpl\$([\s\S]*?)\$tpl\$/g)].map((m) => m[1]!);

const SETS = [
  { label: "audit", subjects: subjects(AUDIT_SQL), bodies: bodies(AUDIT_SQL) },
  {
    label: "generic",
    subjects: subjects(GENERIC_SQL),
    bodies: bodies(GENERIC_SQL),
  },
];

/** Variables an unaudited lead cannot supply, because nobody texted it. */
const AUDIT_VARIABLES = [
  "audit_time_local",
  "audit_day_local",
  "audit_outcome",
  "response_delay",
];

/**
 * The seeded copy has to be activatable.
 *
 * app.template_lint() runs in a trigger the moment is_active flips, so a seeded
 * template that does not lint clean is a migration that ships an email nobody
 * can turn on. Catching that here costs a second; catching it in the UI costs
 * an operator their first send.
 */
describe("the seeded templates", () => {
  for (const set of SETS) {
    describe(`${set.label} set`, () => {
      it("seeds four touches", () => {
        expect(set.subjects).toHaveLength(4);
        expect(set.bodies).toHaveLength(4);
      });

      for (let i = 0; i < 4; i++) {
        it(`lints clean at step ${i + 1}`, () => {
          expect(lintTemplateRules(set.subjects[i]!, set.bodies[i]!)).toEqual([]);
        });
      }

      it("renders with nothing left hollow when the lead is fully populated", () => {
        // renderTemplate refuses nothing; the DISPATCHER skips a send whose
        // render reported a missing variable. So "which variables does this
        // copy demand" is the question that decides whether a lead can be sent
        // to at all.
        const values = Object.fromEntries(
          TEMPLATE_VARIABLES.map((name) => [name, `<${name}>`]),
        );

        for (const text of [...set.subjects, ...set.bodies]) {
          expect(renderTemplate(text, values).missing).toEqual([]);
        }
      });

      it("never asks for first_name, which is null on plenty of scraped rows", () => {
        // Not a style rule. A template that interpolates a variable the lead
        // does not have is skipped at dispatch and alerted on, which looks like
        // the pipeline stalling rather than like a copy decision.
        for (const text of [...set.subjects, ...set.bodies]) {
          expect(text).not.toContain("{{first_name}}");
        }
      });
    });
  }

  it("keeps the generic set free of every audit variable", () => {
    // The whole reason the generic set exists. One of these creeping into it
    // would make the copy unsendable to exactly the leads it was written for,
    // and the failure would show up as a skipped send rather than as a lint
    // error, days after the migration landed.
    const generic = SETS.find((s) => s.label === "generic")!;
    for (const text of [...generic.subjects, ...generic.bodies]) {
      for (const variable of AUDIT_VARIABLES) {
        expect(text).not.toContain(`{{${variable}}}`);
      }
    }
  });

  it("fixes the 'however' that should have read 'how'", () => {
    // 0022 rewrites it in place. If the seed in 0019 is ever corrected at
    // source, this test is what says the migration is now a no-op rather than
    // leaving both spellings live in different databases.
    expect(GENERIC_SQL).toContain("replace(subject, 'however ', 'how ')");
  });
});
