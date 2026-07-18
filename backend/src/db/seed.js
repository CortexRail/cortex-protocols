/**
 * Development seed data.
 *
 * Inserts the sample assets and agents that used to live in the in-memory
 * services. Goes through the repository layer (create() is an upsert), so
 * running it repeatedly is safe.
 *
 * CLI: node src/db/seed.js
 */

const assetRepository = require("../repositories/assetRepository");
const agentRepository = require("../repositories/agentRepository");
const { closePool } = require("./connection");

const DAY_MS = 86_400_000;

const SAMPLE_ASSETS = [
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
    createdAt: Date.now() - DAY_MS * 14,
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
    createdAt: Date.now() - DAY_MS * 7,
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
    createdAt: Date.now() - DAY_MS * 3,
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
    createdAt: Date.now() - DAY_MS * 21,
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
    createdAt: Date.now() - DAY_MS * 5,
    tags: ["memory", "vector-search", "long-term", "semantic"],
  },
];

const SAMPLE_AGENTS = [
  {
    id: 1,
    owner: "GBQNX4XFBKZ2S2GZPB2XVVZ5VVQYHXQAQYYVRJXPVDGXNVKGKBFLR3",
    name: "Cortex-Alpha",
    description:
      "General-purpose reasoning and analysis agent. Specializes in breaking down complex queries into structured chains-of-thought.",
    capabilities: ["Reasoning", "TextGeneration", "DataAnalysis"],
    reputation: 8_200,
    totalTransactions: 1_432,
    isActive: true,
    registeredAt: Date.now() - DAY_MS * 30,
  },
  {
    id: 2,
    owner: "GCEZWKCA5VLDNRLN3RPRJMRZOX3Z6G5CHCGGEWNG5PZWXU2CQKM4PAT",
    name: "CodeWeaver",
    description:
      "Expert code generation agent. Handles TypeScript, Rust, Python, and Solidity. Ships with self-testing capabilities.",
    capabilities: ["CodeGeneration", "Reasoning", "TextGeneration"],
    reputation: 9_100,
    totalTransactions: 3_788,
    isActive: true,
    registeredAt: Date.now() - DAY_MS * 60,
  },
  {
    id: 3,
    owner: "GDRXE2BQUC3AZNPVFSCEZ76NJ3WWL25FYFK6RGZGIEKWE4SOOHSUJUJ",
    name: "VisionBot",
    description:
      "Multi-modal vision understanding agent. Processes images, charts, and diagrams to extract structured data and insights.",
    capabilities: ["VisionUnderstanding", "DataAnalysis", "TextGeneration"],
    reputation: 7_400,
    totalTransactions: 654,
    isActive: true,
    registeredAt: Date.now() - DAY_MS * 10,
  },
];

async function seed() {
  for (const asset of SAMPLE_ASSETS) {
    await assetRepository.create(asset);
  }
  for (const agent of SAMPLE_AGENTS) {
    await agentRepository.create(agent);
  }
  return { assets: SAMPLE_ASSETS.length, agents: SAMPLE_AGENTS.length };
}

module.exports = { seed, SAMPLE_ASSETS, SAMPLE_AGENTS };

// ── CLI entrypoint ────────────────────────────────────────────────────────────
if (require.main === module) {
  require("dotenv").config();

  seed()
    .then(({ assets, agents }) => {
      console.info(`[seed] upserted ${assets} assets, ${agents} agents`);
    })
    .catch((err) => {
      console.error("[seed] failed:", err.message);
      process.exitCode = 1;
    })
    .finally(() => closePool());
}
