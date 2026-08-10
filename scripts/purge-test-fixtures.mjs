// Deletes the leftover integration-test fixtures from the hosted project.
//
// The suites create an org and a user per run and clean up after themselves,
// but a run that dies between the two — a rate-limited sign-in, a killed
// process — leaves orphans behind. They are harmless, but they make the leads
// grid and the dedupe counts confusing to read.
//
// Usage: npm run db:purge-fixtures [-- --dry-run]
//
// Two things this deliberately will NOT touch:
//
//   1. Any auth user whose email is not on the reserved `.test` TLD. That is
//      the only kind the harness creates, so anything else is a real person.
//   2. Any org named in app.login_allowlist, and PROTECTED_SLUGS below.
//      login_allowlist.org_id is ON DELETE CASCADE, so deleting the real org
//      would silently take the allowlist with it and lock everybody out.

import { config } from "dotenv";
import pg from "pg";
import { createClient } from "@supabase/supabase-js";

config({ path: ".env", quiet: true });

const dryRun = process.argv.includes("--dry-run");

const PROTECTED_SLUGS = ["auto-receptionist"];
const TEST_EMAIL_SUFFIX = "@example.test";

const apiUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey =
  process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_SECRET_KEY;
const dbUrl = process.env.SUPABASE_POOLER_URL;

if (!apiUrl || !serviceKey) {
  console.error("Missing NEXT_PUBLIC_SUPABASE_URL or the service-role key.");
  process.exit(1);
}

const admin = createClient(apiUrl, serviceKey, { auth: { persistSession: false } });

// --- which orgs are spoken for -----------------------------------------------
// app schema is not exposed over PostgREST, so this needs a direct connection.
// Without it we cannot prove an org is unreferenced, and guessing is exactly
// the failure this script exists to avoid.
const protectedOrgIds = new Set();

if (!dbUrl) {
  console.error("SUPABASE_POOLER_URL is not set; cannot read app.login_allowlist.");
  process.exit(1);
}

const client = new pg.Client({
  connectionString: dbUrl,
  ssl: { rejectUnauthorized: false },
  connectionTimeoutMillis: 20_000,
});

try {
  await client.connect();
  const { rows } = await client.query("select distinct org_id from app.login_allowlist");
  for (const row of rows) protectedOrgIds.add(row.org_id);
} catch (error) {
  console.error(`Could not read the allowlist, so nothing was deleted: ${error.message}`);
  process.exit(1);
} finally {
  await client.end().catch(() => {});
}

// --- users -------------------------------------------------------------------
const { data: page, error: listError } = await admin.auth.admin.listUsers({
  perPage: 1000,
});
if (listError) {
  console.error("Could not list users:", listError.message);
  process.exit(1);
}

const testUsers = page.users.filter((u) => u.email?.endsWith(TEST_EMAIL_SUFFIX));
const keptUsers = page.users.length - testUsers.length;

// --- orgs --------------------------------------------------------------------
const { data: orgs, error: orgError } = await admin.from("orgs").select("id, name, slug");
if (orgError) {
  console.error("Could not list orgs:", orgError.message);
  process.exit(1);
}

const doomedOrgs = (orgs ?? []).filter(
  (o) => !PROTECTED_SLUGS.includes(o.slug) && !protectedOrgIds.has(o.id),
);
const keptOrgs = (orgs ?? []).length - doomedOrgs.length;

console.log(
  `Orgs:  ${doomedOrgs.length} to delete, ${keptOrgs} protected.\n` +
    `Users: ${testUsers.length} to delete, ${keptUsers} kept.`,
);

if (dryRun) {
  for (const o of doomedOrgs) console.log(`  would delete org ${o.name} (${o.slug})`);
  process.exit(0);
}

// Orgs first: leads, members, settings, imports and reviews all cascade.
let deletedOrgs = 0;
for (const org of doomedOrgs) {
  const { error } = await admin.from("orgs").delete().eq("id", org.id);
  if (error) console.error(`  org ${org.slug}: ${error.message}`);
  else deletedOrgs++;
}

let deletedUsers = 0;
for (const user of testUsers) {
  const { error } = await admin.auth.admin.deleteUser(user.id);
  if (error) console.error(`  user ${user.email}: ${error.message}`);
  else deletedUsers++;
}

console.log(`Deleted ${deletedOrgs} orgs and ${deletedUsers} users.`);

for (const table of ["orgs", "org_members", "leads", "lead_events", "imports"]) {
  const { count } = await admin.from(table).select("*", { count: "exact", head: true });
  console.log(`  ${table}: ${count}`);
}
