const { migrate, status, listMigrationFiles } = require("../../db/migrate");
const { query, closePool } = require("../../db/connection");

afterAll(async () => {
  await closePool();
});

describe("migration runner", () => {
  it("is idempotent — a second run applies nothing and does not fail", async () => {
    // globalSetup already ran the migrations once against this database.
    const second = await migrate({ log: () => {} });
    expect(second.applied).toEqual([]);
    expect(second.skipped).toBe(listMigrationFiles().length);

    // And a third time, for luck.
    const third = await migrate({ log: () => {} });
    expect(third.applied).toEqual([]);
  });

  it("records every migration file in schema_migrations exactly once", async () => {
    const files = listMigrationFiles();
    const { rows } = await query(
      "SELECT version, count(*) AS n FROM schema_migrations GROUP BY version ORDER BY version"
    );
    expect(rows.map((r) => r.version)).toEqual(files);
    rows.forEach((r) => expect(Number(r.n)).toBe(1));
  });

  it("reports status with zero pending after a full run", async () => {
    const result = await status();
    expect(result.pending).toEqual([]);
    expect(result.applied).toEqual(listMigrationFiles());
  });

  it("created all six domain tables", async () => {
    const { rows } = await query(`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public'
      ORDER BY table_name
    `);
    const tables = rows.map((r) => r.table_name);
    for (const expected of [
      "assets",
      "agents",
      "licenses",
      "streams",
      "reports",
      "events_log",
      "schema_migrations",
    ]) {
      expect(tables).toContain(expected);
    }
  });

  it("created the GIN indexes for full-text search and tags", async () => {
    const { rows } = await query(
      "SELECT indexname FROM pg_indexes WHERE tablename = 'assets'"
    );
    const indexes = rows.map((r) => r.indexname);
    expect(indexes).toContain("idx_assets_search");
    expect(indexes).toContain("idx_assets_tags");
  });
});
