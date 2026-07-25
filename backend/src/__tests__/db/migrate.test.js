const fs = require("fs");
const path = require("path");
const { migrate, status, listMigrationFiles } = require("../../db/migrate");
const { query, getClient, closePool } = require("../../db/connection");

const versionMigration = fs.readFileSync(
  path.join(
    __dirname,
    "../../db/migrations/007_add_asset_versions.sql"
  ),
  "utf8"
);

async function createLegacyVersionTables(client) {
  await client.query("CREATE TEMP TABLE assets (id INTEGER PRIMARY KEY)");
  await client.query(
    "CREATE TEMP TABLE licenses (id INTEGER PRIMARY KEY, asset_id INTEGER)"
  );
  await client.query("INSERT INTO assets (id) VALUES (1)");
  await client.query("INSERT INTO licenses (id, asset_id) VALUES (1, 1)");
  await client.query(versionMigration);
}

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

  it("backfills existing assets and licenses to version 1", async () => {
    const client = await getClient();
    try {
      await client.query("BEGIN");
      await createLegacyVersionTables(client);
      const assetResult = await client.query("SELECT version FROM assets");
      const licenseResult = await client.query(
        "SELECT asset_version FROM licenses"
      );
      expect(assetResult.rows[0].version).toBe(1);
      expect(licenseResult.rows[0].asset_version).toBe(1);
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  });

  it.each([
    ["assets", "version"],
    ["licenses", "asset_version"],
  ])("uses BIGINT for %s.%s", async (table, column) => {
    const client = await getClient();
    try {
      await client.query("BEGIN");
      await createLegacyVersionTables(client);
      const { rows } = await client.query(
        `SELECT data_type FROM information_schema.columns
         WHERE table_schema LIKE 'pg_temp_%'
           AND table_name = $1
           AND column_name = $2`,
        [table, column]
      );
      expect(rows[0].data_type).toBe("bigint");
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  });

  it.each([
    ["assets", "version"],
    ["licenses", "asset_version"],
  ])(
    "accepts u32 values above INTEGER range for %s.%s",
    async (table, column) => {
      const client = await getClient();
      try {
        await client.query("BEGIN");
        await createLegacyVersionTables(client);
        await expect(
          client.query(`UPDATE ${table} SET ${column} = $1`, [3_000_000_000])
        ).resolves.toBeDefined();
        const { rows } = await client.query(
          `SELECT ${column} AS version FROM ${table}`
        );
        expect(Number(rows[0].version)).toBe(3_000_000_000);
      } finally {
        await client.query("ROLLBACK");
        client.release();
      }
    }
  );

  it.each([
    ["assets", "version", 0],
    ["assets", "version", -1],
    ["licenses", "asset_version", 0],
    ["licenses", "asset_version", -1],
  ])("rejects %s.%s value %i", async (table, column, value) => {
    const client = await getClient();
    try {
      await client.query("BEGIN");
      await createLegacyVersionTables(client);
      await expect(
        client.query(`UPDATE ${table} SET ${column} = $1`, [value])
      ).rejects.toThrow();
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  });
});
