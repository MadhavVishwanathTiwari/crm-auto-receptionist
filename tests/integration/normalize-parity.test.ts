import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  normalizeDomain,
  normalizeEmail,
  normalizePhone,
} from "@/lib/normalize";
import {
  DOMAIN_VECTORS,
  EMAIL_VECTORS,
  PHONE_VECTORS,
} from "../fixtures/normalize-vectors";
import { adminClient, cleanup, createTestOrg, type TestOrg } from "../setup/stack";

// Every dedupe key in this system exists twice: as an IMMUTABLE SQL function
// backing a generated column on `leads`, and as a TypeScript function used to
// group rows in memory during import, before anything is written.
//
// Two implementations of a dedupe key is a latent data-corruption bug — if they
// disagree, the importer decides a row is new and the database decides it is a
// duplicate, or the reverse. This suite is the only thing that makes keeping
// them identical non-optional.
//
// It drives the GENERATED COLUMNS rather than calling app.normalize_*()
// directly, which is both a stronger assertion (it is the column that dedupe
// actually reads) and avoids a raw 5432 connection to a pooler on the other
// side of the Pacific.

let org: TestOrg;
let leadId: string;

beforeAll(async () => {
  org = await createTestOrg("parity");
  const { data, error } = await adminClient()
    .from("leads")
    .insert({ org_id: org.id, company_name: "Parity Probe" })
    .select("id")
    .single();
  if (error) throw new Error(error.message);
  leadId = data.id;
});

afterAll(async () => {
  await cleanup([org.id], []);
});

/** Writes one raw value and reads back what the database computed from it. */
async function roundTrip(
  column: "work_email" | "website" | "phone",
  generated: "work_email_norm" | "website_domain" | "phone_e164",
  value: string | null,
): Promise<string | null> {
  const { data, error } = await adminClient()
    .from("leads")
    .update({ [column]: value })
    .eq("id", leadId)
    .select(generated)
    .single();

  if (error) throw new Error(`${column}=${value}: ${error.message}`);
  return (data as Record<string, string | null>)[generated];
}

describe("normalize_email parity", () => {
  it("agrees with TypeScript on every vector", async () => {
    for (const [input, expected] of EMAIL_VECTORS) {
      const fromDb = await roundTrip("work_email", "work_email_norm", input);
      expect(fromDb, `db: ${JSON.stringify(input)}`).toBe(expected);
      expect(normalizeEmail(input), `ts: ${JSON.stringify(input)}`).toBe(expected);
    }
  });
});

describe("normalize_domain parity", () => {
  it("agrees with TypeScript on every vector", async () => {
    for (const [input, expected] of DOMAIN_VECTORS) {
      const fromDb = await roundTrip("website", "website_domain", input);
      expect(fromDb, `db: ${JSON.stringify(input)}`).toBe(expected);
      expect(normalizeDomain(input), `ts: ${JSON.stringify(input)}`).toBe(expected);
    }
  });
});

describe("normalize_phone parity", () => {
  it("agrees with TypeScript on every vector", async () => {
    for (const [input, expected] of PHONE_VECTORS) {
      const fromDb = await roundTrip("phone", "phone_e164", input);
      expect(fromDb, `db: ${JSON.stringify(input)}`).toBe(expected);
      expect(normalizePhone(input), `ts: ${JSON.stringify(input)}`).toBe(expected);
    }
  });
});
