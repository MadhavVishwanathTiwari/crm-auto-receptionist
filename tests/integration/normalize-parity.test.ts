import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Client } from "pg";

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
import { dbUrl } from "../setup/db";

// Every dedupe key in this system exists twice: as an IMMUTABLE SQL function
// backing a generated column on `leads`, and as a TypeScript function used to
// group rows in memory during import, before anything is written.
//
// Two implementations of a dedupe key is a latent data-corruption bug — if they
// disagree, the importer decides a row is new and the database decides it is a
// duplicate (or worse, the reverse). This suite is the only thing that makes
// keeping them identical non-optional.

let client: Client;

beforeAll(async () => {
  const { Client: PgClient } = await import("pg");
  client = new PgClient({ connectionString: dbUrl() });
  await client.connect();
});

afterAll(async () => {
  await client?.end();
});

async function sqlNormalize(fn: string, input: string | null) {
  const { rows } = await client.query<{ result: string | null }>(
    `select app.${fn}($1) as result`,
    [input],
  );
  return rows[0]!.result;
}

describe("normalize_email parity", () => {
  it("agrees with the TypeScript implementation on every vector", async () => {
    const mismatches: string[] = [];

    for (const [input, expected] of EMAIL_VECTORS) {
      const fromSql = await sqlNormalize("normalize_email", input);
      const fromTs = normalizeEmail(input);

      if (fromSql !== fromTs) {
        mismatches.push(
          `${JSON.stringify(input)}: sql=${JSON.stringify(fromSql)} ts=${JSON.stringify(fromTs)}`,
        );
      }
      // Also pin both to the documented expectation, so a matched pair of wrong
      // answers still fails.
      expect(fromSql, `sql: ${input}`).toBe(expected);
      expect(fromTs, `ts: ${input}`).toBe(expected);
    }

    expect(mismatches).toEqual([]);
  });
});

describe("normalize_domain parity", () => {
  it("agrees with the TypeScript implementation on every vector", async () => {
    for (const [input, expected] of DOMAIN_VECTORS) {
      const fromSql = await sqlNormalize("normalize_domain", input);
      expect(fromSql, `sql: ${input}`).toBe(expected);
      expect(normalizeDomain(input), `ts: ${input}`).toBe(expected);
    }
  });
});

describe("normalize_phone parity", () => {
  it("agrees with the TypeScript implementation on every vector", async () => {
    for (const [input, expected] of PHONE_VECTORS) {
      const fromSql = await sqlNormalize("normalize_phone", input);
      expect(fromSql, `sql: ${input}`).toBe(expected);
      expect(normalizePhone(input), `ts: ${input}`).toBe(expected);
    }
  });
});

describe("normalizers are usable in generated columns", () => {
  it("declares all three IMMUTABLE", async () => {
    // A generated column requires IMMUTABLE. If someone relaxes one of these to
    // STABLE, the next migration that adds a generated column fails with a
    // confusing error far from the cause — catch it here instead.
    const { rows } = await client.query<{ proname: string; provolatile: string }>(
      `select proname, provolatile
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'app'
          and proname in ('normalize_email', 'normalize_domain', 'normalize_phone')
        order by proname`,
    );

    expect(rows).toHaveLength(3);
    for (const row of rows) {
      expect(row.provolatile, `${row.proname} must be IMMUTABLE`).toBe("i");
    }
  });
});
