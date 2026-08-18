/**
 * Migration runner.
 *
 * Reads every `NNN_name.sql` file in ./migrations in lexical order and applies
 * the ones not yet recorded in `schema_migrations`. Each migration runs inside
 * its own transaction, and the whole run is serialized behind an advisory lock
 * so two processes booting at once cannot race each other.
 *
 * Idempotent: re-running applies nothing and exits cleanly.
 *
 * CLI:
 *   node src/db/migrate.js          # apply pending migrations
 *   node src/db/migrate.js status   # list applied / pending
 */

const fs = require("fs");
const path = require("path");
const { getPool, closePool } = require("./connection");

const MIGRATIONS_DIR = path.join(__dirname, "migrations");

// Arbitrary constant identifying "the migration lock" application-wide.
const ADVISORY_LOCK_KEY = 727274;

const MIGRATION_FILE_PATTERN = /^\d{3,}_[\w-]+\.sql$/;

/**
 * List migration files on disk, sorted by their numeric prefix.
 */
function listMigrationFiles(dir = MIGRATIONS_DIR) {
  return fs
    .readdirSync(dir)
    .filter((f) => MIGRATION_FILE_PATTERN.test(f))
    .sort();
}

async function ensureMigrationsTable(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
}

async function appliedVersions(client) {
  const { rows } = await client.query(
    "SELECT version FROM schema_migrations ORDER BY version"
  );
  return new Set(rows.map((r) => r.version));
}

/**
 * Apply all pending migrations.
 *
 * @param {{ dir?: string, log?: (msg: string) => void }} [options]
 * @returns {Promise<{ applied: string[], skipped: number }>}
 */
async function migrate({ dir = MIGRATIONS_DIR, log = console.info } = {}) {
  const files = listMigrationFiles(dir);
  const client = await getPool().connect();
  const applied = [];

  try {
    // Serialize concurrent runners (e.g. several app instances booting).
    await client.query("SELECT pg_advisory_lock($1)", [ADVISORY_LOCK_KEY]);
    await ensureMigrationsTable(client);
    const done = await appliedVersions(client);

    for (const file of files) {
      if (done.has(file)) continue;

      const sql = fs.readFileSync(path.join(dir, file), "utf8");
      try {
        await client.query("BEGIN");
        await client.query(sql);
        await client.query(
          "INSERT INTO schema_migrations (version) VALUES ($1)",
          [file]
        );
        await client.query("COMMIT");
        applied.push(file);
        log(`[migrate] applied ${file}`);
      } catch (err) {
        await client.query("ROLLBACK");
        err.message = `migration ${file} failed: ${err.message}`;
        throw err;
      }
    }

    return { applied, skipped: files.length - applied.length };
  } finally {
    await client.query("SELECT pg_advisory_unlock($1)", [ADVISORY_LOCK_KEY]);
    client.release();
  }
}

/**
 * Report applied vs pending migrations without changing anything.
 *
 * @returns {Promise<{ applied: string[], pending: string[] }>}
 */
async function status({ dir = MIGRATIONS_DIR } = {}) {
  const files = listMigrationFiles(dir);
  const client = await getPool().connect();
  try {
    await ensureMigrationsTable(client);
    const done = await appliedVersions(client);
    return {
      applied: files.filter((f) => done.has(f)),
      pending: files.filter((f) => !done.has(f)),
    };
  } finally {
    client.release();
  }
}

module.exports = { migrate, status, listMigrationFiles };

// ── CLI entrypoint ────────────────────────────────────────────────────────────
if (require.main === module) {
  require("dotenv").config();

  const command = process.argv[2] || "up";

  const run = async () => {
    if (command === "status") {
      const result = await status();
      console.info("[migrate] applied:", result.applied.length ? result.applied.join(", ") : "(none)");
      console.info("[migrate] pending:", result.pending.length ? result.pending.join(", ") : "(none)");
    } else {
      const { applied, skipped } = await migrate();
      console.info(
        `[migrate] done — ${applied.length} applied, ${skipped} already up to date`
      );
    }
  };

  run()
    .catch((err) => {
      console.error("[migrate] failed:", err.message);
      process.exitCode = 1;
    })
    .finally(() => closePool());
}
