const { v4: uuidv4 } = require("uuid");

// In-memory store for indexing (replace with a DB in production)
const assetsIndex = new Map();

/**
 * Asset types matching the on-chain enum.
 */
const ASSET_TYPES = [
  "Prompt",
  "Workflow",
  "ReasoningChain",
  "Dataset",
  "Evaluator",
  "MemorySystem",
  "ModelInstruction",
  "Tool",
];

/**
 * License types matching the on-chain enum.
 */
const LICENSE_TYPES = ["Perpetual", "UsageBased", "Subscription", "OpenSource"];

/**
 * Index an asset from an on-chain event or direct API call.
 */
function indexAsset(assetData) {
  const {
    id,
    owner,
    name,
    description,
    assetType,
    licenseType,
    price,
    usageCount = 0,
    isActive = true,
    createdAt,
    tags = [],
  } = assetData;

  const indexed = {
    id,
    owner,
    name,
    description,
    assetType,
    licenseType,
    price,
    usageCount,
    isActive,
    createdAt: createdAt || Date.now(),
    tags,
    indexedAt: Date.now(),
  };

  assetsIndex.set(String(id), indexed);
  return indexed;
}

/**
 * Get all active assets with optional filtering.
 */
function listAssets({ assetType, licenseType, minPrice, maxPrice, search, page = 1, limit = 20 } = {}) {
  let results = Array.from(assetsIndex.values()).filter((a) => a.isActive);

  if (assetType) {
    results = results.filter((a) => a.assetType === assetType);
  }
  if (licenseType) {
    results = results.filter((a) => a.licenseType === licenseType);
  }
  if (minPrice !== undefined) {
    results = results.filter((a) => a.price >= minPrice);
  }
  if (maxPrice !== undefined) {
    results = results.filter((a) => a.price <= maxPrice);
  }
  if (search) {
    const q = search.toLowerCase();
    results = results.filter(
      (a) =>
        a.name.toLowerCase().includes(q) ||
        a.description.toLowerCase().includes(q) ||
        (a.tags || []).some((t) => t.toLowerCase().includes(q))
    );
  }

  const total = results.length;
  const offset = (page - 1) * limit;
  const paginated = results.slice(offset, offset + limit);

  return {
    data: paginated,
    meta: {
      total,
      page,
      limit,
      pages: Math.ceil(total / limit),
    },
  };
}

/**
 * Get a single asset by ID.
 */
function getAsset(id) {
  return assetsIndex.get(String(id)) || null;
}

/**
 * Remove an asset from the index (called on delist event).
 */
function removeAsset(id) {
  const asset = assetsIndex.get(String(id));
  if (asset) {
    asset.isActive = false;
    assetsIndex.set(String(id), asset);
  }
}

/**
 * Seed some sample assets for development.
 */
function seedSampleAssets() {
  const samples = [
    {
      id: 1,
      owner: "GBQNX4XFBKZ2S2GZPB2XVVZ5VVQYHXQAQYYVRJXPVDGXNVKGKBFLR3",
      name: "GPT-4 Chain-of-Thought Prompt",
      description:
        "Advanced reasoning prompt template that breaks down complex problems into explicit reasoning steps. Optimized for accuracy on multi-step analysis tasks.",
      assetType: "Prompt",
      licenseType: "Perpetual",
      price: 5_000_000,
      usageCount: 142,
      isActive: true,
      createdAt: Date.now() - 86400000 * 14,
      tags: ["reasoning", "gpt-4", "chain-of-thought", "analysis"],
    },
    {
      id: 2,
      owner: "GCEZWKCA5VLDNRLN3RPRJMRZOX3Z6G5CHCGGEWNG5PZWXU2CQKM4PAT",
      name: "Legal Document Analyzer Workflow",
      description:
        "Multi-agent workflow for extracting key clauses, obligations, and risk factors from legal documents. Returns structured JSON output.",
      assetType: "Workflow",
      licenseType: "UsageBased",
      price: 500_000,
      usageCount: 89,
      isActive: true,
      createdAt: Date.now() - 86400000 * 7,
      tags: ["legal", "document-analysis", "workflow", "structured-output"],
    },
    {
      id: 3,
      owner: "GBQNX4XFBKZ2S2GZPB2XVVZ5VVQYHXQAQYYVRJXPVDGXNVKGKBFLR3",
      name: "Financial Data Reasoning Chain",
      description:
        "Step-by-step reasoning template for interpreting financial statements and generating investment thesis summaries.",
      assetType: "ReasoningChain",
      licenseType: "Subscription",
      price: 20_000_000,
      usageCount: 34,
      isActive: true,
      createdAt: Date.now() - 86400000 * 3,
      tags: ["finance", "investing", "reasoning", "analysis"],
    },
    {
      id: 4,
      owner: "GDRXE2BQUC3AZNPVFSCEZ76NJ3WWL25FYFK6RGZGIEKWE4SOOHSUJUJ",
      name: "Web Research Agent Tool",
      description:
        "Composable tool enabling agents to perform structured web research, extract entities, and summarize findings with citation tracking.",
      assetType: "Tool",
      licenseType: "Perpetual",
      price: 10_000_000,
      usageCount: 201,
      isActive: true,
      createdAt: Date.now() - 86400000 * 21,
      tags: ["research", "web", "tool", "citations"],
    },
    {
      id: 5,
      owner: "GCEZWKCA5VLDNRLN3RPRJMRZOX3Z6G5CHCGGEWNG5PZWXU2CQKM4PAT",
      name: "Persistent Vector Memory System",
      description:
        "Plug-and-play memory module that gives agents semantic long-term memory via vector similarity search. Supports up to 10K entries.",
      assetType: "MemorySystem",
      licenseType: "Subscription",
      price: 50_000_000,
      usageCount: 17,
      isActive: true,
      createdAt: Date.now() - 86400000 * 5,
      tags: ["memory", "vector-search", "long-term", "semantic"],
    },
  ];

  samples.forEach((s) => indexAsset(s));
}

// Seed on startup in development
if (process.env.NODE_ENV !== "production") {
  seedSampleAssets();
}

module.exports = {
  indexAsset,
  listAssets,
  getAsset,
  removeAsset,
  ASSET_TYPES,
  LICENSE_TYPES,
};
