// Applies pending migrations to the hosted Supabase project.
//
// `supabase db push` is ADDITIVE — it runs migrations that have not been
// applied yet and records them in supabase_migrations.schema_migrations. It
// does not drop anything. That is why this exists as a script while
// `db:reset`, which DROPS AND RECREATES the database, is left pointing at the
// local stack only and is never given a --db-url.
//
// Usage: npm run db:push [-- --dry-run]

import { execFileSync } from "node:child_process";
import { config } from "dotenv";

config({ path: ".env", quiet: true });

// The direct connection (db.<ref>.supabase.co) is IPv6-only on newer projects
// and does not resolve from every network. The SESSION pooler on port 5432
// speaks full Postgres including DDL, so it is what we use. Do not substitute
// the TRANSACTION pooler on 6543: it breaks prepared statements and
// session-scoped advisory locks, which the scheduler depends on.
const dbUrl = process.env.SUPABASE_POOLER_URL;

if (!dbUrl) {
  console.error("SUPABASE_POOLER_URL is not set in .env.");
  process.exit(1);
}

const host = new URL(dbUrl).hostname;
const passthrough = process.argv.slice(2);

console.log(`Applying migrations to ${host} ...`);

try {
  execFileSync(
    process.platform === "win32" ? "npx.cmd" : "npx",
    ["supabase", "db", "push", "--db-url", dbUrl, "--include-all", ...passthrough],
    { stdio: "inherit" },
  );
} catch {
  // The CLI prints its own diagnostics; do not double-report, and never echo
  // the connection string, which carries the database password.
  process.exit(1);
}
