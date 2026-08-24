const usageEventRepository = require("../../repositories/usageEventRepository");
const assetRepository = require("../../repositories/assetRepository");
const { truncateAll, closePool, buildAsset, buildUsageEvent, OWNER_A, OWNER_B } = require("../helpers/testDb");

let assetOne;
let assetTwo;

beforeEach(async () => {
  await truncateAll();
  assetOne = await assetRepository.create(buildAsset());
  assetTwo = await assetRepository.create(buildAsset());
});

afterAll(async () => {
  await closePool();
});

describe("usageEventRepository.callCountsByBucket with assetId", () => {
  const now = Date.now();

  it("scopes the series to a single asset when assetId is given", async () => {
    await usageEventRepository.record(
      buildUsageEvent({ assetId: assetOne.id, occurredAt: now, pricePaid: 100 })
    );
    await usageEventRepository.record(
      buildUsageEvent({ assetId: assetOne.id, occurredAt: now, pricePaid: 200 })
    );
    await usageEventRepository.record(
      buildUsageEvent({ assetId: assetTwo.id, occurredAt: now, pricePaid: 999 })
    );

    const series = await usageEventRepository.callCountsByBucket({
      subject: "asset",
      assetId: assetOne.id,
      from: now - 60_000,
      to: now + 60_000,
      bucketSeconds: 3600,
    });

    expect(series).toHaveLength(1);
    expect(series[0].subject).toBe(assetOne.id);
    expect(series[0].calls).toBe(2);
    expect(series[0].revenue).toBe(300);
  });

  it("returns every asset's buckets when assetId is omitted", async () => {
    await usageEventRepository.record(buildUsageEvent({ assetId: assetOne.id, occurredAt: now }));
    await usageEventRepository.record(buildUsageEvent({ assetId: assetTwo.id, occurredAt: now }));

    const series = await usageEventRepository.callCountsByBucket({
      subject: "asset",
      from: now - 60_000,
      to: now + 60_000,
    });

    const subjects = series.map((row) => row.subject).sort();
    expect(subjects).toEqual([assetOne.id, assetTwo.id].sort());
  });
});

describe("usageEventRepository.assetUsageByCaller with assetId", () => {
  const now = Date.now();

  it("scopes caller breakdown to a single asset", async () => {
    await usageEventRepository.record(
      buildUsageEvent({ assetId: assetOne.id, caller: OWNER_A, occurredAt: now })
    );
    await usageEventRepository.record(
      buildUsageEvent({ assetId: assetOne.id, caller: OWNER_B, occurredAt: now })
    );
    await usageEventRepository.record(
      buildUsageEvent({ assetId: assetTwo.id, caller: OWNER_A, occurredAt: now })
    );

    const rows = await usageEventRepository.assetUsageByCaller({
      assetId: assetOne.id,
      from: now - 60_000,
      to: now + 60_000,
    });

    expect(rows).toHaveLength(2);
    rows.forEach((row) => expect(row.assetId).toBe(assetOne.id));
  });

  it("sorts callers by call count, busiest first", async () => {
    await usageEventRepository.record(
      buildUsageEvent({ assetId: assetOne.id, caller: OWNER_B, occurredAt: now })
    );
    await usageEventRepository.record(
      buildUsageEvent({ assetId: assetOne.id, caller: OWNER_A, occurredAt: now })
    );
    await usageEventRepository.record(
      buildUsageEvent({ assetId: assetOne.id, caller: OWNER_A, occurredAt: now })
    );

    const rows = await usageEventRepository.assetUsageByCaller({
      assetId: assetOne.id,
      from: now - 60_000,
      to: now + 60_000,
    });

    expect(rows[0].caller).toBe(OWNER_A);
    expect(rows[0].calls).toBe(2);
    expect(rows[1].caller).toBe(OWNER_B);
    expect(rows[1].calls).toBe(1);
  });
});
