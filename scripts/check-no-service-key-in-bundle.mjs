// Build-time guard: prove the service-role key never reached a browser bundle.
//
// The ESLint rule in eslint.config.mjs stops the obvious case (importing the
// admin client from a component). This catches everything else — a stray
// `process.env.SUPABASE_SERVICE_ROLE_KEY` in a "use client" file, a key pasted
// into a constant, a server module pulled into the client graph by a barrel
// import. Run after `next build`; exits non-zero on a hit.
//
// Usage: node scripts/check-no-service-key-in-bundle.mjs

import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";
import { config } from "dotenv";

config({ path: ".env", quiet: true });

const BUNDLE_DIRS = [".next/static", ".next/server/app"];

// Literal variable names that should never appear in client output.
const FORBIDDEN_NAMES = [
  "SUPABASE_SERVICE_ROLE_KEY",
  "SUPABASE_SECRET_KEY",
  "AR_INGEST_SECRET",
  "CRON_SECRET",
  "GOOGLE_OAUTH_CLIENT_SECRET",
];

// Actual secret values from the environment, when present. Short values are
// skipped — a 6-character secret would match half the bundle by chance.
const FORBIDDEN_VALUES = FORBIDDEN_NAMES.map((n) => process.env[n])
  .filter((v) => typeof v === "string" && v.length >= 20)
  .map((v) => v.trim());

function* walk(dir) {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) yield* walk(full);
    else if (/\.(js|mjs|cjs|json|txt|map)$/.test(entry)) yield full;
  }
}

const hits = [];

for (const dir of BUNDLE_DIRS) {
  // .next/server/** is server code and may legitimately reference the names,
  // but must still never contain a literal secret VALUE (that would mean the
  // key was inlined at build time rather than read at runtime).
  const isServer = dir.includes("/server");
  for (const file of walk(dir)) {
    const text = readFileSync(file, "utf8");
    if (!isServer) {
      for (const name of FORBIDDEN_NAMES) {
        if (text.includes(name)) hits.push(`${file}: references ${name}`);
      }
    }
    for (const value of FORBIDDEN_VALUES) {
      if (text.includes(value)) {
        hits.push(`${file}: contains a literal secret VALUE`);
      }
    }
  }
}

if (!existsSync(".next")) {
  console.error("No .next directory. Run `npm run build` first.");
  process.exit(1);
}

if (hits.length > 0) {
  console.error("\nSecret leak detected in build output:\n");
  for (const hit of hits) console.error("  " + hit);
  console.error(
    `\n${hits.length} problem(s). A server-only value reached the client graph.\n`,
  );
  process.exit(1);
}

console.log("Bundle check passed: no server secrets in client output.");
