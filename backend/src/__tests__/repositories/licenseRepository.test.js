const assetRepository = require("../../repositories/assetRepository");
const licenseRepository = require("../../repositories/licenseRepository");
const {
  truncateAll,
  closePool,
  buildAsset,
  OWNER_A,
  OWNER_B,
} = require("../helpers/testDb");

let asset;

beforeEach(async () => {
  await truncateAll();
  asset = await assetRepository.create(buildAsset({ licenseType: "UsageBased" }));
});

afterAll(async () => {
  await closePool();
});

function buildLicense(overrides = {}) {
  return {
    assetId: asset.id,
    assetVersion: asset.version,
    buyer: OWNER_B,
    licenseType: "UsageBased",
    pricePaid: 500_000,
    callsRemaining: 100,
    expiresAt: null,
    ...overrides,
  };
}

describe("licenseRepository.create", () => {
  it("creates a license row referencing the asset", async () => {
    const license = await licenseRepository.create(buildLicense());

    expect(license.id).toBeGreaterThan(0);
    expect(license.assetId).toBe(asset.id);
    expect(license.assetVersion).toBe(1);
    expect(license.buyer).toBe(OWNER_B);
    expect(license.licenseType).toBe("UsageBased");
    expect(license.pricePaid).toBe(500_000);
    expect(license.callsRemaining).toBe(100);
    expect(license.expiresAt).toBeNull();
    expect(license.isActive).toBe(true);
    expect(typeof license.purchasedAt).toBe("number");
  });

  it("supports NULL callsRemaining for unlimited licenses", async () => {
    const license = await licenseRepository.create(
      buildLicense({ licenseType: "Perpetual", callsRemaining: null })
    );
    expect(license.callsRemaining).toBeNull();
  });

  it("stores expiresAt for subscriptions", async () => {
    const expiresAt = Date.now() + 30 * 86_400_000;
    const license = await licenseRepository.create(
      buildLicense({ licenseType: "Subscription", callsRemaining: null, expiresAt })
    );
    expect(Math.abs(license.expiresAt - expiresAt)).toBeLessThan(1000);
  });

  it("rejects a second ACTIVE license for the same buyer+asset", async () => {
    await licenseRepository.create(buildLicense());
    await expect(licenseRepository.create(buildLicense())).rejects.toThrow();
  });

  it("allows a new license after the previous one expired", async () => {
    const first = await licenseRepository.create(buildLicense());
    await licenseRepository.expire(first.id);
    const second = await licenseRepository.create(buildLicense());
    expect(second.id).not.toBe(first.id);
  });

  it("enforces the FK to assets", async () => {
    await expect(
      licenseRepository.create(buildLicense({ assetId: 987_654 }))
    ).rejects.toThrow();
  });

  it("stores a pinned asset version", async () => {
    const license = await licenseRepository.create(
      buildLicense({ assetVersion: 3 })
    );
    expect(license.assetVersion).toBe(3);
  });

  it("maps a u32 asset version above INTEGER range as a number", async () => {
    const license = await licenseRepository.create(
      buildLicense({ assetVersion: 3_000_000_000 })
    );

    expect(license.assetVersion).toBe(3_000_000_000);
    expect(typeof license.assetVersion).toBe("number");
  });

  it("rejects an invalid asset version", async () => {
    await expect(
      licenseRepository.create(buildLicense({ assetVersion: 0 }))
    ).rejects.toThrow();
  });
});

describe("licenseRepository.findByBuyerAndAsset", () => {
  it("finds the active license", async () => {
    const created = await licenseRepository.create(buildLicense());
    const found = await licenseRepository.findByBuyerAndAsset(OWNER_B, asset.id);
    expect(found.id).toBe(created.id);
  });

  it("returns null when the buyer holds no license", async () => {
    expect(
      await licenseRepository.findByBuyerAndAsset(OWNER_A, asset.id)
    ).toBeNull();
  });

  it("ignores expired licenses", async () => {
    const created = await licenseRepository.create(buildLicense());
    await licenseRepository.expire(created.id);
    expect(
      await licenseRepository.findByBuyerAndAsset(OWNER_B, asset.id)
    ).toBeNull();
  });
});

describe("licenseRepository.findAllByBuyer", () => {
  it("lists every license the buyer holds, newest first", async () => {
    const asset2 = await assetRepository.create(buildAsset());
    await licenseRepository.create(buildLicense());
    await licenseRepository.create(buildLicense({ assetId: asset2.id }));

    const { data, meta } = await licenseRepository.findAllByBuyer(OWNER_B);
    expect(data).toHaveLength(2);
    expect(meta.total).toBe(2);
    data.forEach((l) => expect(l.buyer).toBe(OWNER_B));
  });

  it("paginates", async () => {
    const asset2 = await assetRepository.create(buildAsset());
    await licenseRepository.create(buildLicense());
    await licenseRepository.create(buildLicense({ assetId: asset2.id }));

    const { data, meta } = await licenseRepository.findAllByBuyer(OWNER_B, {
      page: 2,
      limit: 1,
    });
    expect(data).toHaveLength(1);
    expect(meta.pages).toBe(2);
  });
});

describe("licenseRepository.updateCallsRemaining", () => {
  it("sets the counter to the given value", async () => {
    const created = await licenseRepository.create(buildLicense());
    const updated = await licenseRepository.updateCallsRemaining(created.id, 42);
    expect(updated.callsRemaining).toBe(42);
  });

  it("returns null for unknown license", async () => {
    expect(await licenseRepository.updateCallsRemaining(555_555, 1)).toBeNull();
  });

  it("rejects negative values via CHECK constraint", async () => {
    const created = await licenseRepository.create(buildLicense());
    await expect(
      licenseRepository.updateCallsRemaining(created.id, -1)
    ).rejects.toThrow();
  });
});

describe("licenseRepository.consumeCall", () => {
  it("atomically decrements callsRemaining", async () => {
    const created = await licenseRepository.create(
      buildLicense({ callsRemaining: 2 })
    );
    const afterOne = await licenseRepository.consumeCall(created.id);
    expect(afterOne.callsRemaining).toBe(1);
  });

  it("refuses to go below zero", async () => {
    const created = await licenseRepository.create(
      buildLicense({ callsRemaining: 0 })
    );
    expect(await licenseRepository.consumeCall(created.id)).toBeNull();
  });

  it("leaves unlimited (NULL) licenses untouched but returns them", async () => {
    const created = await licenseRepository.create(
      buildLicense({ licenseType: "Perpetual", callsRemaining: null })
    );
    const result = await licenseRepository.consumeCall(created.id);
    expect(result.callsRemaining).toBeNull();
  });
});

describe("licenseRepository.expire", () => {
  it("marks the license inactive", async () => {
    const created = await licenseRepository.create(buildLicense());
    const expired = await licenseRepository.expire(created.id);
    expect(expired.isActive).toBe(false);
  });

  it("returns null for unknown license", async () => {
    expect(await licenseRepository.expire(444_444)).toBeNull();
  });
});
