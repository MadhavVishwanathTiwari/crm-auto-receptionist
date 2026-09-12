// Vitest setup, run in every worker before its test file loads. Target
// selection lives in target.ts, and global.ts points the app's own environment
// at the same target. This loads .env for whatever global.ts left alone, then
// checks that global.ts did its job.

import { config } from "dotenv";

config({ path: ".env", quiet: true });

// The route handlers the integration suites import build their Supabase client
// from these variables. If they still named the hosted project, a suite would
// seed a local fixture and then run the real planner, dispatcher or demo route
// against production, which is exactly what happened before global.ts existed.
// Refuse to load rather than find out.
if (process.env.TEST_TARGET !== "cloud") {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
  if (!/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?\/?$/.test(url)) {
    throw new Error(
      `The app's Supabase URL under test is ${url || "unset"}, not the local stack. ` +
        "tests/setup/global.ts should have set it; refusing to run anything " +
        "that could reach the hosted project.",
    );
  }
}
