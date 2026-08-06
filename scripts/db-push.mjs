// Applies pending migrations to the hosted Supabase project.
//
// This talks to Postgres directly rather than shelling out to `supabase db
// push`, for two reasons found the hard way:
//
//   1. Node refuses to spawn a .cmd (npx.cmd, supabase.cmd) without
//      shell: true — the CVE-2024-27980 fix — and fails with a null exit
//      status and NO output. The CLI appeared to succeed while applying
//      nothing. Passing shell: true would fix the spawn but re-quote the
//      connection string through cmd.exe, which mangles a password containing
//      shell metacharacters.
//   2. Several CLI subcommands (`gen types`, `db diff`) shell out to Docker
//      even when handed a --db-url, and Docker is not always available.
//
// The tracking table is the CLI's own supabase_migrations.schema_migrations
// (version / name / statements), so the CLI stays interchangeable with this.
//
// This is ADDITIVE. It never drops anything. `db:reset`, which DROPS AND
// RECREATES the database, is deliberately left pointing at the local stack.
//
// Usage: npm run db:push [-- --dry-run]

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { config } from "dotenv";
import pg from "pg";

config({ path: ".env", quiet: true });

// The direct connection (db.<ref>.supabase.co) is IPv6-only on newer projects
// and does not resolve from every network. The SESSION pooler on 5432 speaks
// full Postgres including DDL. Do not substitute the TRANSACTION pooler on
// 6543: it breaks prepared statements and session-scoped advisory locks, which
// claim_due_sends() depends on.
const dbUrl = process.env.SUPABASE_POOLER_URL;
if (!dbUrl) {
  console.error("SUPABASE_POOLER_URL is not set in .env.");
  process.exit(1);
}

const dryRun = process.argv.includes("--dry-run");
const dir = "supabase/migrations";

const migrations = readdirSync(dir)
  .filter((f) => f.endsWith(".sql"))
  .sort()
  .map((file) => {
    const underscore = file.indexOf("_");
    return {
      file,
      version: file.slice(0, underscore),
      name: file.slice(underscore + 1).replace(/\.sql$/, ""),
    };
  });

// Raw 5432 to the hosted pooler is a long-haul TCP connection and intermittently
// times out where HTTPS to PostgREST does not. Retry rather than fail a
// migration run for a reason unrelated to the migration.
async function connect(attempts = 4) {
  let lastError;
  for (let i = 0; i < attempts; i++) {
    const candidate = new pg.Client({
      connectionString: dbUrl,
      ssl: { rejectUnauthorized: false },
      connectionTimeoutMillis: 20_000,
    });
    try {
      await candidate.connect();
      return candidate;
    } catch (error) {
      lastError = error;
      await candidate.end().catch(() => {});
      if (i < attempts - 1) {
        console.log(`  connection attempt ${i + 1} failed, retrying...`);
        await new Promise((r) => setTimeout(r, 2000 * (i + 1)));
      }
    }
  }
  console.error(`Could not connect after ${attempts} attempts: ${lastError?.message}`);
  process.exit(1);
}

const client = await connect();

console.log(`Target: ${new URL(dbUrl).hostname}`);

await client.query("create schema if not exists supabase_migrations");
await client.query(`
  create table if not exists supabase_migrations.schema_migrations (
    version text primary key,
    statements text[],
    name text
  )
`);

const { rows } = await client.query(
  "select version from supabase_migrations.schema_migrations",
);
const applied = new Set(rows.map((r) => r.version));
const pending = migrations.filter((m) => !applied.has(m.version));

if (pending.length === 0) {
  console.log(`Up to date (${applied.size} applied).`);
  await client.end();
  process.exit(0);
}

if (dryRun) {
  console.log(`Would apply: ${pending.map((m) => m.file).join(", ")}`);
  await client.end();
  process.exit(0);
}

let failed = null;

for (const migration of pending) {
  const sql = readFileSync(join(dir, migration.file), "utf8");
  process.stdout.write(`  ${migration.file} ... `);

  // Each migration is one transaction: it applies completely or not at all, and
  // its tracking row commits with it, so a crash can never leave the table
  // claiming a half-applied migration succeeded.
  try {
    await client.query("begin");
    await client.query(sql);
    await client.query(
      `insert into supabase_migrations.schema_migrations (version, name, statements)
       values ($1, $2, $3)`,
      [migration.version, migration.name, [sql]],
    );
    await client.query("commit");
    console.log("ok");
  } catch (error) {
    await client.query("rollback");
    console.log("FAILED");
    failed = { migration, error };
    break; // later migrations assume this one landed; do not compound the damage
  }
}

await client.end();

if (failed) {
  console.error(`\n${failed.migration.file} failed and was rolled back:\n`);
  console.error(`  ${failed.error.message}`);
  if (failed.error.position) {
    const sql = readFileSync(join(dir, failed.migration.file), "utf8");
    const upto = sql.slice(0, Number(failed.error.position));
    console.error(`  at line ${upto.split("\n").length}`);
  }
  if (failed.error.hint) console.error(`  hint: ${failed.error.hint}`);
  process.exit(1);
}

console.log(`Applied ${pending.length} migration(s).`);
