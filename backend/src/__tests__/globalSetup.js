/**
 * Jest global setup — boots a throwaway PostgreSQL container and runs all
 * migrations against it before any test file executes.
 *
 * The connection URI is exported via process.env.DATABASE_URL, which the
 * worker processes inherit.
 */

const { PostgreSqlContainer } = require("@testcontainers/postgresql");

module.exports = async () => {
  process.env.NODE_ENV = "test";

  const container = await new PostgreSqlContainer("postgres:16-alpine")
    .withDatabase("cortex_test")
    .start();

  process.env.DATABASE_URL = container.getConnectionUri();

  // Keep a handle for globalTeardown (runs in this same process).
  global.__PG_CONTAINER__ = container;

  // Apply the full migration set once; individual tests only truncate.
  const { migrate } = require("../db/migrate");
  const { closePool } = require("../db/connection");
  await migrate({ log: () => {} });
  await closePool();
};
