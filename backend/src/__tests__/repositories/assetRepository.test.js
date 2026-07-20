const assetRepository = require("../../repositories/assetRepository");
const {
  truncateAll,
  closePool,
  buildAsset,
  OWNER_A,
  OWNER_B,
} = require("../helpers/testDb");

beforeEach(async () => {
  await truncateAll();
});

afterAll(async () => {
  await closePool();
});

describe("assetRepository.create", () => {
  it("inserts an asset and returns the mapped row", async () => {
    const input = buildAsset({ tags: ["reasoning", "gpt-4"] });
    const asset = await assetRepository.create(input);

    expect(asset.id).toBe(input.id);
    expect(asset.owner).toBe(input.owner);
    expect(asset.name).toBe(input.name);
    expect(asset.assetType).toBe("Prompt");
    expect(asset.licenseType).toBe("Perpetual");
    expect(asset.price).toBe(1_000_000);
    expect(asset.version).toBe(1);
    expect(asset.availableVersions).toEqual([1]);
    expect(asset.usageCount).toBe(0);
    expect(asset.isActive).toBe(true);
    expect(asset.tags).toEqual(["reasoning", "gpt-4"]);
    expect(typeof asset.createdAt).toBe("number");
    expect(typeof asset.indexedAt).toBe("number");
  });

  it("upserts on conflicting id (re-index updates fields)", async () => {
    const input = buildAsset({ name: "Original" });
    await assetRepository.create(input);
    const updated = await assetRepository.create({
      ...input,
      name: "Renamed",
      price: 42,
      version: 3,
    });

    expect(updated.id).toBe(input.id);
    expect(updated.name).toBe("Renamed");
    expect(updated.price).toBe(42);
    expect(updated.version).toBe(3);
    expect(updated.availableVersions).toEqual([1, 2, 3]);

    const { meta } = await assetRepository.findAll();
    expect(meta.total).toBe(1);
  });

  it("preserves the stored version when a legacy upsert omits it", async () => {
    const input = buildAsset({ version: 7 });
    await assetRepository.create(input);
    const { version: _version, ...legacyInput } = input;

    const updated = await assetRepository.create({
      ...legacyInput,
      name: "Legacy re-index",
    });
    expect(updated.version).toBe(7);
    expect(updated.name).toBe("Legacy re-index");
  });

  it("upserts a version above the INTEGER range", async () => {
    const input = buildAsset();
    await assetRepository.create(input);

    const updated = await assetRepository.create({
      ...input,
      version: 3_000_000_000,
    });
    expect(updated.version).toBe(3_000_000_000);
    expect(typeof updated.version).toBe("number");
  });

  it("preserves an explicit createdAt timestamp (ms)", async () => {
    const createdAt = Date.now() - 86_400_000;
    const asset = await assetRepository.create(buildAsset({ createdAt }));
    // TIMESTAMPTZ round-trip is ms-precision
    expect(Math.abs(asset.createdAt - createdAt)).toBeLessThan(1000);
  });

  it("rejects an invalid asset type at the database boundary", async () => {
    await expect(
      assetRepository.create(buildAsset({ assetType: "NotAThing" }))
    ).rejects.toThrow();
  });

  it.each([
    [1, [1]],
    [3, [1, 2, 3]],
    [7, [3, 4, 5, 6, 7]],
  ])("maps available versions for current version %i", async (version, expected) => {
    const asset = await assetRepository.create(buildAsset({ version }));
    expect(asset.version).toBe(version);
    expect(asset.availableVersions).toEqual(expected);
  });

  it("maps a u32 version above INTEGER range and its availability as numbers", async () => {
    const version = 3_000_000_000;
    const asset = await assetRepository.create(buildAsset({ version }));

    expect(asset.version).toBe(version);
    expect(typeof asset.version).toBe("number");
    expect(asset.availableVersions).toEqual([
      2_999_999_996,
      2_999_999_997,
      2_999_999_998,
      2_999_999_999,
      3_000_000_000,
    ]);
    asset.availableVersions.forEach((availableVersion) =>
      expect(typeof availableVersion).toBe("number")
    );
  });
});

describe("assetRepository.findById", () => {
  it("returns null for a missing id", async () => {
    expect(await assetRepository.findById(99_999)).toBeNull();
  });

  it("finds an asset by id", async () => {
    const input = buildAsset();
    await assetRepository.create(input);
    const asset = await assetRepository.findById(input.id);
    expect(asset).not.toBeNull();
    expect(asset.id).toBe(input.id);
  });

  it("hides soft-deleted assets unless includeInactive is set", async () => {
    const input = buildAsset();
    await assetRepository.create(input);
    await assetRepository.softDelete(input.id);

    expect(await assetRepository.findById(input.id)).toBeNull();
    const hidden = await assetRepository.findById(input.id, {
      includeInactive: true,
    });
    expect(hidden).not.toBeNull();
    expect(hidden.isActive).toBe(false);
  });
});

describe("assetRepository.findAll", () => {
  beforeEach(async () => {
    await assetRepository.create(
      buildAsset({ assetType: "Prompt", licenseType: "Perpetual", price: 100, owner: OWNER_A })
    );
    await assetRepository.create(
      buildAsset({ assetType: "Workflow", licenseType: "UsageBased", price: 500, owner: OWNER_B })
    );
    await assetRepository.create(
      buildAsset({ assetType: "Tool", licenseType: "Perpetual", price: 1000, owner: OWNER_A })
    );
  });

  it("returns everything active with pagination meta", async () => {
    const { data, meta } = await assetRepository.findAll();
    expect(data).toHaveLength(3);
    expect(meta).toEqual({ total: 3, page: 1, limit: 20, pages: 1 });
  });

  it("filters by assetType", async () => {
    const { data } = await assetRepository.findAll({ assetType: "Workflow" });
    expect(data).toHaveLength(1);
    expect(data[0].assetType).toBe("Workflow");
  });

  it("filters by licenseType", async () => {
    const { data } = await assetRepository.findAll({ licenseType: "Perpetual" });
    expect(data).toHaveLength(2);
  });

  it("filters by price range", async () => {
    const { data } = await assetRepository.findAll({ minPrice: 200, maxPrice: 700 });
    expect(data).toHaveLength(1);
    expect(data[0].price).toBe(500);
  });

  it("filters by owner", async () => {
    const { data } = await assetRepository.findAll({ owner: OWNER_B });
    expect(data).toHaveLength(1);
    expect(data[0].owner).toBe(OWNER_B);
  });

  it("filters by tag containment", async () => {
    await assetRepository.create(buildAsset({ tags: ["finance", "special-tag"] }));
    const { data } = await assetRepository.findAll({ tag: "special-tag" });
    expect(data).toHaveLength(1);
    expect(data[0].tags).toContain("special-tag");
  });

  it("paginates", async () => {
    const page1 = await assetRepository.findAll({}, { page: 1, limit: 2 });
    const page2 = await assetRepository.findAll({}, { page: 2, limit: 2 });
    expect(page1.data).toHaveLength(2);
    expect(page2.data).toHaveLength(1);
    expect(page1.meta.pages).toBe(2);
    const ids = [...page1.data, ...page2.data].map((a) => a.id);
    expect(new Set(ids).size).toBe(3);
  });

  it("excludes soft-deleted assets", async () => {
    const victim = buildAsset();
    await assetRepository.create(victim);
    await assetRepository.softDelete(victim.id);
    const { data, meta } = await assetRepository.findAll();
    expect(meta.total).toBe(3);
    expect(data.map((a) => a.id)).not.toContain(victim.id);
  });
});

describe("assetRepository.update", () => {
  it("applies a partial patch and bumps updatedAt", async () => {
    const input = buildAsset();
    const created = await assetRepository.create(input);
    const updated = await assetRepository.update(input.id, {
      name: "Patched",
      price: 777,
    });

    expect(updated.name).toBe("Patched");
    expect(updated.price).toBe(777);
    expect(updated.description).toBe(created.description);
    expect(updated.updatedAt).toBeGreaterThanOrEqual(created.updatedAt);
  });

  it("returns null for unknown id", async () => {
    expect(await assetRepository.update(12_345, { name: "x" })).toBeNull();
  });

  it("rejects an empty patch", async () => {
    const input = buildAsset();
    await assetRepository.create(input);
    await expect(assetRepository.update(input.id, {})).rejects.toThrow();
  });
});

describe("assetRepository.softDelete", () => {
  it("marks the asset inactive and sets deletedAt", async () => {
    const input = buildAsset();
    await assetRepository.create(input);

    expect(await assetRepository.softDelete(input.id)).toBe(true);

    const gone = await assetRepository.findById(input.id, {
      includeInactive: true,
    });
    expect(gone.isActive).toBe(false);
    expect(gone.deletedAt).not.toBeNull();
  });

  it("returns false for unknown id", async () => {
    expect(await assetRepository.softDelete(999_999)).toBe(false);
  });

  it("data survives — the row still exists after soft delete", async () => {
    const input = buildAsset();
    await assetRepository.create(input);
    await assetRepository.softDelete(input.id);
    const row = await assetRepository.findById(input.id, { includeInactive: true });
    expect(row.name).toBe(input.name);
  });
});

describe("assetRepository.search (full-text)", () => {
  beforeEach(async () => {
    await assetRepository.create(
      buildAsset({
        name: "Financial Reasoning Chain",
        description: "Interprets financial statements step by step.",
        tags: ["finance"],
      })
    );
    await assetRepository.create(
      buildAsset({
        name: "Legal Analyzer",
        description: "Extracts clauses from legal documents.",
        tags: ["legal"],
      })
    );
  });

  it("matches words in the name", async () => {
    const { data } = await assetRepository.search("financial");
    expect(data).toHaveLength(1);
    expect(data[0].name).toBe("Financial Reasoning Chain");
  });

  it("matches words in the description", async () => {
    const { data } = await assetRepository.search("clauses");
    expect(data).toHaveLength(1);
    expect(data[0].name).toBe("Legal Analyzer");
  });

  it("matches via english stemming (statements ~ statement)", async () => {
    const { data } = await assetRepository.search("statement");
    expect(data).toHaveLength(1);
  });

  it("matches tags", async () => {
    const { data } = await assetRepository.search("legal");
    expect(data.map((a) => a.name)).toContain("Legal Analyzer");
  });

  it("returns empty result set for garbage", async () => {
    const { data, meta } = await assetRepository.search("zzzzqqqq");
    expect(data).toHaveLength(0);
    expect(meta.total).toBe(0);
  });

  it("combines search with filters", async () => {
    const { data } = await assetRepository.search("financial", {
      assetType: "Workflow",
    });
    expect(data).toHaveLength(0);
  });
});

describe("assetRepository.incrementUsage", () => {
  it("increments usage_count and returns the new value", async () => {
    const input = buildAsset({ usageCount: 5 });
    await assetRepository.create(input);
    const count = await assetRepository.incrementUsage(input.id);
    expect(count).toBe(6);
  });

  it("returns null for unknown asset", async () => {
    expect(await assetRepository.incrementUsage(424_242)).toBeNull();
  });
});

describe("assetRepository.updateVersion", () => {
  it("advances the current version without changing other asset data", async () => {
    const input = buildAsset({ version: 3, description: "keep this" });
    await assetRepository.create(input);

    const updated = await assetRepository.updateVersion(input.id, 4);
    expect(updated.version).toBe(4);
    expect(updated.availableVersions).toEqual([1, 2, 3, 4]);
    expect(updated.description).toBe("keep this");
  });

  it("does not regress on an out-of-order event", async () => {
    const input = buildAsset({ version: 7 });
    await assetRepository.create(input);
    expect((await assetRepository.updateVersion(input.id, 6)).version).toBe(7);
  });

  it("accepts an event version above the INTEGER range", async () => {
    const input = buildAsset({ version: 2_999_999_999 });
    await assetRepository.create(input);

    const updated = await assetRepository.updateVersion(input.id, 3_000_000_000);
    expect(updated.version).toBe(3_000_000_000);
    expect(typeof updated.version).toBe("number");
  });

  it("returns null for an asset that has not been indexed", async () => {
    expect(await assetRepository.updateVersion(987_654, 2)).toBeNull();
  });
});
