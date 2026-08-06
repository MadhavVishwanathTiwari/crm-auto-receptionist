// Direct Postgres access for tests that need to assert on SQL itself —
// normalizer parity, trigger behaviour, constraint violations. Application code
// never does this; it goes through PostgREST so that RLS applies.

import { Client } from "pg";

// The local stack's default superuser connection. Hardcoded rather than read
// from .env so a stray environment variable can never point the destructive
// parts of the suite at the hosted project.
const LOCAL_DB_URL = "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

export function dbUrl(): string {
  const override = process.env.TEST_DATABASE_URL;
  if (!override) return LOCAL_DB_URL;
  if (!override.includes("127.0.0.1") && !override.includes("localhost")) {
    throw new Error(
      `Tests may only connect to a local database. Got: ${override}`,
    );
  }
  return override;
}

export async function withDb<T>(fn: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: dbUrl() });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}
