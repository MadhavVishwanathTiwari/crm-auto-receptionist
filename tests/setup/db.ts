// Direct Postgres access for tests that assert on SQL itself — normalizer
// parity, trigger behaviour, constraint violations, function volatility.
// Application code never does this; it goes through PostgREST so RLS applies.

import { Client } from "pg";

import { testTarget } from "./target";

export function dbUrl(): string {
  return testTarget().dbUrl;
}

export function newDbClient(): Client {
  const { dbUrl, target } = testTarget();
  return new Client({
    connectionString: dbUrl,
    // Supabase terminates TLS with its own CA. Verification is off only for
    // the test harness; nothing in the app connects this way.
    ssl: target === "cloud" ? { rejectUnauthorized: false } : undefined,
  });
}

export async function withDb<T>(fn: (client: Client) => Promise<T>): Promise<T> {
  const client = newDbClient();
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}
