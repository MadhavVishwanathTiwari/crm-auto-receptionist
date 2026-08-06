// Loads env for tests. Integration tests run against the LOCAL Supabase stack
// (`npm run db:start`), never against the hosted project — they create and
// destroy orgs, users and leads, which would be destructive against real data.
//
// The local stack's keys are the well-known Supabase demo keys, so they are
// hardcoded here rather than read from .env. That is deliberate: it makes it
// impossible to accidentally point the integration suite at production by
// having the wrong thing in your shell.

import { config } from "dotenv";

config({ path: ".env", quiet: true });

const LOCAL_API_URL = "http://127.0.0.1:54321";

process.env.TEST_SUPABASE_URL ??= LOCAL_API_URL;

// Fail loudly rather than silently testing nothing if someone points these at a
// remote host.
if (!process.env.TEST_SUPABASE_URL.includes("127.0.0.1") &&
    !process.env.TEST_SUPABASE_URL.includes("localhost")) {
  throw new Error(
    `Integration tests may only run against a local Supabase stack. ` +
      `Got TEST_SUPABASE_URL=${process.env.TEST_SUPABASE_URL}. ` +
      `Run "npm run db:start" and unset the override.`,
  );
}
