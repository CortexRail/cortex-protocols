// In-memory agent registry index (replace with DB in production)
const agentsIndex = new Map();

const CAPABILITIES = [
  "TextGeneration",
  "CodeGeneration",
  "Reasoning",
  "VisionUnderstanding",
  "AudioProcessing",
  "DataAnalysis",
  "WebResearch",
  "ActionExecution",
];

function registerAgent(agentData) {
  const {
    id,
    owner,
    name,
    description,
    capabilities = [],
    reputation = 5000,
    totalTransactions = 0,
    isActive = true,
    registeredAt,
  } = agentData;

  const agent = {
    id,
    owner,
    name,
    description,
    capabilities,
    reputation,
    totalTransactions,
    isActive,
    registeredAt: registeredAt || Date.now(),
    indexedAt: Date.now(),
  };

  agentsIndex.set(String(id), agent);
  return agent;
}

function listAgents({
  capability,
  minReputation,
  search,
  page = 1,
  limit = 20,
} = {}) {
  let results = Array.from(agentsIndex.values()).filter((a) => a.isActive);

  if (capability) {
    results = results.filter((a) => a.capabilities.includes(capability));
  }
  if (minReputation !== undefined) {
    results = results.filter((a) => a.reputation >= minReputation);
  }
  if (search) {
    const q = search.toLowerCase();
    results = results.filter(
      (a) =>
        a.name.toLowerCase().includes(q) ||
        a.description.toLowerCase().includes(q)
    );
  }

  const total = results.length;
  const offset = (page - 1) * limit;
  return {
    data: results.slice(offset, offset + limit),
    meta: { total, page, limit, pages: Math.ceil(total / limit) },
  };
}

function getAgent(id) {
  return agentsIndex.get(String(id)) || null;
}

function seedSampleAgents() {
  const samples = [
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
      registeredAt: Date.now() - 86400000 * 30,
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
      registeredAt: Date.now() - 86400000 * 60,
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
      registeredAt: Date.now() - 86400000 * 10,
    },
  ];

  samples.forEach((s) => registerAgent(s));
}

if (process.env.NODE_ENV !== "production") {
  seedSampleAgents();
}

module.exports = { registerAgent, listAgents, getAgent, CAPABILITIES };
