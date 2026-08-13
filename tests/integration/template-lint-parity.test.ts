import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { lintTemplateRules } from "@/lib/templates/lint";

import { CLEAN_BODY, CLEAN_SUBJECT, TEMPLATE_VECTORS } from "../fixtures/template-vectors";
import { adminClient, cleanup, createTestOrg, type TestOrg } from "../setup/stack";

// The copy rules exist twice: as app.template_lint() behind the trigger that
// blocks activation, and as lib/templates/lint.ts in the editor. If they
// disagree, an operator writes copy the editor calls clean and the database
// refuses, or worse, the editor warns about copy the database happily ships.
//
// Driven through the ACTIVATION path rather than by calling the SQL function
// directly. app.template_lint lives in the `app` schema precisely so PostgREST
// cannot reach it, and the trigger is the thing that actually decides. Its
// error message carries the rule codes, which is what makes a rule-for-rule
// comparison possible without a raw 5432 connection.

let org: TestOrg;

beforeAll(async () => {
  org = await createTestOrg("lint");
}, 60_000);

afterAll(async () => {
  await cleanup([org.id], []);
}, 60_000);

/** Rule codes out of the trigger's message, or [] if it let the template live. */
async function rulesFromDatabase(
  subject: string,
  body: string,
): Promise<string[]> {
  const admin = adminClient();
  const name = `probe-${randomUUID().slice(0, 8)}`;

  const { data: created, error: insertError } = await admin
    .from("templates")
    .insert({
      org_id: org.id,
      name,
      step_number: 1,
      subject,
      body,
      // A draft may be as bad as you like; activation is where the rules apply.
      is_active: false,
    })
    .select("id")
    .single();

  if (insertError) throw new Error(`could not seed template: ${insertError.message}`);

  const { error } = await admin
    .from("templates")
    .update({ is_active: true })
    .eq("id", created.id)
    .select("id");

  if (!error) {
    // Freed immediately: templates_active_step_key allows one active template
    // per step per angle, and every vector here is step 1.
    await admin.from("templates").update({ is_active: false }).eq("id", created.id);
    return [];
  }

  const match = error.message.match(/does not lint clean:\s*([a-z_, ]+)/);
  if (!match) throw new Error(`unexpected refusal: ${error.message}`);

  return match[1]!
    .split(",")
    .map((rule) => rule.trim())
    .filter(Boolean);
}

describe("template lint parity", () => {
  for (const vector of TEMPLATE_VECTORS) {
    it(`agrees on ${vector.label}`, async () => {
      const fromDb = await rulesFromDatabase(vector.subject, vector.body);
      const fromTs = lintTemplateRules(vector.subject, vector.body);

      expect(fromTs, `ts: ${vector.label}`).toEqual(vector.expected);
      expect(fromDb, `db: ${vector.label}`).toEqual(vector.expected);
    }, 120_000);
  }

  it("refuses to activate dirty copy, and the template stays a draft", async () => {
    const admin = adminClient();
    const { data: created } = await admin
      .from("templates")
      .insert({
        org_id: org.id,
        name: `stays-draft-${randomUUID().slice(0, 8)}`,
        step_number: 2,
        subject: "Quick question —",
        body: "Interested?",
        is_active: false,
      })
      .select("id")
      .single();

    const { error } = await admin
      .from("templates")
      .update({ is_active: true })
      .eq("id", created!.id)
      .select("id");

    expect(error).not.toBeNull();

    // Re-read privileged. A refusal that left the row active anyway would be
    // the only failure mode that matters here, and asserting on the error alone
    // would never catch it.
    const { data: after } = await admin
      .from("templates")
      .select("is_active")
      .eq("id", created!.id)
      .single();

    expect(after?.is_active).toBe(false);
  }, 120_000);

  it("allows exactly one active template per step and angle", async () => {
    const admin = adminClient();
    const rows = [1, 2].map((n) => ({
      org_id: org.id,
      name: `dup-${n}-${randomUUID().slice(0, 8)}`,
      step_number: 3,
      subject: CLEAN_SUBJECT,
      body: CLEAN_BODY,
      is_active: true,
    }));

    const first = await admin.from("templates").insert(rows[0]!).select("id");
    expect(first.error).toBeNull();

    const second = await admin.from("templates").insert(rows[1]!).select("id");
    // Without this the planner would have to pick between two candidates, and
    // "whichever the index returned first" is not a decision anyone made.
    expect(second.error?.code).toBe("23505");
  }, 120_000);
});
