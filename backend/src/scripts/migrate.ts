#!/usr/bin/env node
// Bring a database up to the schema this build expects.
//
//   node dist/scripts/migrate.js            # do whatever this database needs
//   node dist/scripts/migrate.js --dry-run
//   node dist/scripts/migrate.js --init     # force the fresh-database path
//   node dist/scripts/migrate.js --baseline # adopt an existing database: record
//                                           # every migration as applied without
//                                           # running any of them
//
// Why this exists: docker-compose seeds a *new* database by mounting
// db/initdb/00-auth-shim.sql and schema.sql into the Postgres entrypoint, which
// only fires on an empty data directory. UAT and production point at a Postgres
// nobody mounts anything into, so that hook does not exist and there was no
// other way to create the schema. This runs as a Kubernetes Job from the same
// backend image, before the Deployment rolls.
//
// It decides for itself which of the two paths a database needs:
//
//   fresh (public.user_profiles absent)
//     -> auth shim, then schema.sql, then record every migration filename as
//        applied. schema.sql is the whole current shape, so replaying the
//        historical migrations over it would be pointless work; baselining is
//        what stops the next run trying.
//
//   existing
//     -> apply the dated files in migrations/ that this database has not
//        recorded yet, oldest first, each in its own transaction.
//
// That makes the Job safe to run on every deploy, which is the point: the
// pipeline should not need to know whether it is looking at a new environment.
//
// One connection, one advisory lock: two pipelines racing (a UAT deploy and a
// re-run of the same job) would otherwise both decide the database was fresh.

import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { Client } from "pg";

/** Any 64-bit constant; it only has to be the same in every replica. */
const LOCK_KEY = 8_246_113_907_442_001n;

const BACKEND_ROOT = path.resolve(__dirname, "..", "..");
const SHIM_SQL = path.join(BACKEND_ROOT, "db", "initdb", "00-auth-shim.sql");
const SCHEMA_SQL = path.join(BACKEND_ROOT, "schema.sql");
const MIGRATIONS_DIR = path.join(BACKEND_ROOT, "migrations");

const args = new Set(process.argv.slice(2));
const dryRun = args.has("--dry-run");
const forceInit = args.has("--init");
const baseline = args.has("--baseline");

function log(message: string): void {
  console.log(`[migrate] ${message}`);
}

function migrationFilenames(): string[] {
  if (!fs.existsSync(MIGRATIONS_DIR)) return [];
  // Dated YYYYMMDD_* names, so lexical order is chronological order.
  return fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((name) => name.endsWith(".sql"))
    .sort();
}

function readSql(file: string): string {
  if (!fs.existsSync(file)) {
    throw new Error(
      `${file} is missing. The backend image must ship schema.sql, ` +
        `db/initdb/ and migrations/ for this to run — check the Dockerfile.`,
    );
  }
  return fs.readFileSync(file, "utf8");
}

/**
 * Run a whole .sql file as one statement batch.
 *
 * Deliberately not split on semicolons: several of these files define
 * functions with $$-quoted bodies, and any splitter naive enough to be worth
 * writing would cut them in half. node-postgres sends a parameterless query
 * through the simple protocol, which accepts multiple statements.
 */
async function runFile(client: Client, file: string): Promise<void> {
  await client.query(readSql(file));
}

async function tableExists(
  client: Client,
  schema: string,
  table: string,
): Promise<boolean> {
  const { rows } = await client.query(
    "select to_regclass($1) is not null as present",
    [`${schema}.${table}`],
  );
  return rows[0]?.present === true;
}

async function ensureLedger(client: Client): Promise<void> {
  await client.query(`
    create table if not exists public.schema_migrations (
      filename text primary key,
      applied_at timestamptz not null default now()
    )
  `);
}

async function appliedMigrations(client: Client): Promise<Set<string>> {
  const { rows } = await client.query<{ filename: string }>(
    "select filename from public.schema_migrations",
  );
  return new Set(rows.map((r) => r.filename));
}

async function initFresh(client: Client): Promise<void> {
  log("no public.user_profiles — treating this as a fresh database");
  if (dryRun) {
    log("dry run: would apply the auth shim, then schema.sql");
    log(`dry run: would baseline ${migrationFilenames().length} migration(s)`);
    return;
  }

  // The shim first: schema.sql is loaded unmodified and still carries
  // Supabase-era foreign keys to auth.users and grants to the anon /
  // authenticated / service_role roles, none of which exist in a plain
  // Postgres until this file creates them.
  log("applying db/initdb/00-auth-shim.sql");
  await runFile(client, SHIM_SQL);

  log("applying schema.sql");
  await runFile(client, SCHEMA_SQL);

  await ensureLedger(client);
  const count = await recordAll(client);
  log(
    `baselined ${count} migration(s): schema.sql already contains them, ` +
      `so they are recorded rather than replayed`,
  );
}

async function recordAll(client: Client): Promise<number> {
  const names = migrationFilenames();
  for (const name of names) {
    await client.query(
      "insert into public.schema_migrations (filename) values ($1) on conflict do nothing",
      [name],
    );
  }
  return names.length;
}

async function applyPending(client: Client): Promise<void> {
  // A database with the application schema but no ledger is one that was
  // deployed before this script existed — a Compose stack being adopted, most
  // likely. Its history is unknown, and guessing is not safe: several of the
  // older files move data rather than just adding columns, and replaying those
  // over live rows does real damage. So stop and make somebody say which case
  // this is.
  const hasLedger = await tableExists(client, "public", "schema_migrations");
  if (!hasLedger && !baseline) {
    throw new Error(
      "This database has Mike's tables but no public.schema_migrations, so " +
        "there is no record of which migrations it has already had. Applying " +
        "them all would replay data migrations over live rows.\n\n" +
        "  - If it is already up to date with this build (the usual case for a " +
        "docker-compose deployment being moved into Kubernetes), re-run with " +
        "--baseline to record them as applied without running them.\n" +
        "  - If it is genuinely behind, create public.schema_migrations by hand " +
        "and insert the filenames it HAS had applied, then re-run. " +
        "See docs/KUBERNETES.md.",
    );
  }

  await ensureLedger(client);

  if (baseline) {
    if (dryRun) {
      log(
        `dry run: would record ${migrationFilenames().length} migration(s) as ` +
          `applied without running them`,
      );
      return;
    }
    const count = await recordAll(client);
    log(`baselined ${count} migration(s) without running them`);
    return;
  }

  const already = await appliedMigrations(client);
  const pending = migrationFilenames().filter((name) => !already.has(name));

  if (pending.length === 0) {
    log("database is up to date; nothing to apply");
    return;
  }

  log(`${pending.length} migration(s) to apply:`);
  for (const name of pending) log(`  - ${name}`);
  if (dryRun) {
    log("dry run: stopping before applying anything");
    return;
  }

  for (const name of pending) {
    // One transaction per file, so a failure half way through leaves that
    // migration unrecorded and un-applied rather than partly done.
    await client.query("begin");
    try {
      await runFile(client, path.join(MIGRATIONS_DIR, name));
      await client.query(
        "insert into public.schema_migrations (filename) values ($1)",
        [name],
      );
      await client.query("commit");
      log(`applied ${name}`);
    } catch (err) {
      await client.query("rollback");
      throw new Error(
        `${name} failed and was rolled back: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
}

async function main(): Promise<void> {
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is not set.");
  }

  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    // Blocks rather than failing: a second Job started by a retried pipeline
    // should wait for the first and then find nothing to do.
    await client.query("select pg_advisory_lock($1)", [LOCK_KEY.toString()]);

    const fresh = forceInit || !(await tableExists(client, "public", "user_profiles"));
    if (fresh) await initFresh(client);
    else await applyPending(client);

    log(dryRun ? "dry run complete" : "done");
  } finally {
    await client.query("select pg_advisory_unlock($1)", [LOCK_KEY.toString()]);
    await client.end();
  }
}

main().catch((err) => {
  console.error(
    `[migrate] failed: ${err instanceof Error ? err.message : String(err)}`,
  );
  process.exit(1);
});
