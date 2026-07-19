const { withTransaction, query } = require("../../db/connection");
const assetRepository = require("../../repositories/assetRepository");
const licenseRepository = require("../../repositories/licenseRepository");
const licenseService = require("../../services/licenseService");
const {
  truncateAll,
  closePool,
  buildAsset,
  OWNER_B,
} = require("../helpers/testDb");

beforeEach(async () => {
  await truncateAll();
});

afterAll(async () => {
  await closePool();
});

describe("withTransaction", () => {
  it("commits when the callback resolves", async () => {
    const asset = buildAsset();
    await withTransaction(async (client) => {
      await assetRepository.create(asset, client);
    });
    expect(await assetRepository.findById(asset.id)).not.toBeNull();
  });

  it("rolls back everything when the callback throws", async () => {
    const asset = buildAsset();
    await expect(
      withTransaction(async (client) => {
        await assetRepository.create(asset, client);
        throw new Error("boom");
      })
    ).rejects.toThrow("boom");

    expect(await assetRepository.findById(asset.id)).toBeNull();
  });

  it("rolls back on a failed SQL statement mid-transaction", async () => {
    const asset = buildAsset();
    await expect(
      withTransaction(async (client) => {
        await assetRepository.create(asset, client);
        // violates the FK constraint → aborts the transaction
        await licenseRepository.create(
          {
            assetId: 999_999,
            buyer: OWNER_B,
            licenseType: "Perpetual",
            pricePaid: 0,
            callsRemaining: null,
            expiresAt: null,
          },
          client
        );
      })
    ).rejects.toThrow();

    expect(await assetRepository.findById(asset.id)).toBeNull();
  });

  it("returns the callback's resolved value", async () => {
    const value = await withTransaction(async () => "the-result");
    expect(value).toBe("the-result");
  });

  it("does not leak connections under load (pool max is finite)", async () => {
    // 100 sequential-ish transactions against a pool of 20: if clients were
    // not released this would deadlock long before the test timeout.
    const runs = Array.from({ length: 100 }, (_, i) =>
      withTransaction(async (client) => {
        const { rows } = await client.query("SELECT $1::int AS n", [i]);
        return rows[0].n;
      })
    );
    const results = await Promise.all(runs);
    expect(results).toHaveLength(100);

    // afterwards the pool must be fully idle
    const { getPoolStats } = require("../../db/connection");
    const stats = getPoolStats();
    expect(stats.waiting).toBe(0);
    expect(stats.idle).toBe(stats.total);
  });
});

describe("licenseService.purchaseLicense (multi-table transaction)", () => {
  it("creates the license AND bumps asset usage_count atomically", async () => {
    const asset = await assetRepository.create(
      buildAsset({ licenseType: "UsageBased", usageCount: 10 })
    );

    const { license, usageCount } = await licenseService.purchaseLicense({
      assetId: asset.id,
      buyer: OWNER_B,
    });

    expect(license.assetId).toBe(asset.id);
    expect(license.buyer).toBe(OWNER_B);
    expect(usageCount).toBe(11);

    const reloaded = await assetRepository.findById(asset.id);
    expect(reloaded.usageCount).toBe(11);
  });

  it("rolls back the usage_count bump when license creation fails", async () => {
    const asset = await assetRepository.create(
      buildAsset({ licenseType: "UsageBased", usageCount: 10 })
    );

    await licenseService.purchaseLicense({ assetId: asset.id, buyer: OWNER_B });

    // Second purchase violates the one-active-license-per-buyer constraint.
    await expect(
      licenseService.purchaseLicense({ assetId: asset.id, buyer: OWNER_B })
    ).rejects.toThrow();

    // usage_count reflects exactly ONE successful purchase — the failed
    // attempt must not have half-applied.
    const reloaded = await assetRepository.findById(asset.id);
    expect(reloaded.usageCount).toBe(11);

    const { rows } = await query(
      "SELECT count(*) AS n FROM licenses WHERE asset_id = $1",
      [asset.id]
    );
    expect(Number(rows[0].n)).toBe(1);
  });

  it("refuses to sell an inactive asset", async () => {
    const asset = await assetRepository.create(buildAsset());
    await assetRepository.softDelete(asset.id);

    await expect(
      licenseService.purchaseLicense({ assetId: asset.id, buyer: OWNER_B })
    ).rejects.toThrow(/not found|inactive/i);
  });

  it("derives license terms from the asset's license type", async () => {
    const usageBased = await assetRepository.create(
      buildAsset({ licenseType: "UsageBased" })
    );
    const { license } = await licenseService.purchaseLicense({
      assetId: usageBased.id,
      buyer: OWNER_B,
    });
    // usage-based licenses start with a metered call allowance
    expect(license.callsRemaining).not.toBeNull();

    const perpetual = await assetRepository.create(
      buildAsset({ licenseType: "Perpetual" })
    );
    const { license: unlimited } = await licenseService.purchaseLicense({
      assetId: perpetual.id,
      buyer: OWNER_B,
    });
    expect(unlimited.callsRemaining).toBeNull();
    expect(unlimited.expiresAt).toBeNull();
  });
});
