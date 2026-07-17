// In-memory agent registry index (replace with DB in production)
const agentsIndex = new Map();
const reputationHistoryIndex = new Map(); // Map<agentId, array of { score, timestamp, voter }>
const activityFeedIndex = new Map(); // Map<agentId, array of events>

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

const ACTIVITY_TYPES = ["AGENT_REGISTERED", "ASSET_LISTED", "LICENSE_PURCHASED", "STREAM_OPENED", "STREAM_CLOSED", "REPUTATION_VOTED"];

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

function submitReputation(agentId, score, voter) {
  // score is 0-100, stored as-is
  if (!reputationHistoryIndex.has(String(agentId))) {
    reputationHistoryIndex.set(String(agentId), []);
  }
  const history = reputationHistoryIndex.get(String(agentId));
  history.push({ score, voter, timestamp: Date.now() });
  
  // Update agent's reputation (simple average for now; use weighted in production)
  const agent = getAgent(agentId);
  if (agent) {
    const avg = Math.round(history.reduce((sum, h) => sum + h.score, 0) / history.length * 100);
    agent.reputation = Math.min(10000, Math.max(0, avg));
    agentsIndex.set(String(agentId), agent);
  }
  
  recordActivity(agentId, "REPUTATION_VOTED", { score, voter });
  return history[history.length - 1];
}

function getReputationHistory(agentId, limit = 30) {
  const history = reputationHistoryIndex.get(String(agentId)) || [];
  return history.slice(-limit);
}

function recordActivity(agentId, type, data) {
  if (!activityFeedIndex.has(String(agentId))) {
    activityFeedIndex.set(String(agentId), []);
  }
  const feed = activityFeedIndex.get(String(agentId));
  feed.push({
    type,
    data,
    timestamp: Date.now(),
  });
}

function getActivityFeed(agentId, page = 1, limit = 20) {
  const feed = activityFeedIndex.get(String(agentId)) || [];
  const sorted = [...feed].sort((a, b) => b.timestamp - a.timestamp);
  const total = sorted.length;
  const offset = (page - 1) * limit;
  return {
    data: sorted.slice(offset, offset + limit),
    meta: { total, page, limit, pages: Math.ceil(total / limit) },
  };
}

function getLeaderboard(sortBy = "reputation", limit = 20) {
  let results = Array.from(agentsIndex.values()).filter((a) => a.isActive);
  
  if (sortBy === "reputation") {
    results.sort((a, b) => b.reputation - a.reputation);
  } else if (sortBy === "activity") {
    results.sort((a, b) => b.totalTransactions - a.totalTransactions);
  } else if (sortBy === "earnings") {
    // For now, derive from totalTransactions; in production use earnings from stream service
    results.sort((a, b) => (b.totalTransactions * 50000) - (a.totalTransactions * 50000));
  }
  
  return results.slice(0, limit);
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
  // Seed some reputation history
  reputationHistoryIndex.set("1", [
    { score: 82, voter: "VOTER1", timestamp: Date.now() - 86400000 * 30 },
    { score: 75, voter: "VOTER2", timestamp: Date.now() - 86400000 * 25 },
    { score: 88, voter: "VOTER3", timestamp: Date.now() - 86400000 * 20 },
    { score: 85, voter: "VOTER4", timestamp: Date.now() - 86400000 * 15 },
    { score: 90, voter: "VOTER5", timestamp: Date.now() - 86400000 * 10 },
  ]);
  activityFeedIndex.set("1", [
    { type: "AGENT_REGISTERED", data: { name: "Cortex-Alpha" }, timestamp: Date.now() - 86400000 * 30 },
    { type: "ASSET_LISTED", data: { assetId: 1 }, timestamp: Date.now() - 86400000 * 25 },
    { type: "LICENSE_PURCHASED", data: { assetId: 1, buyer: "BUYER1" }, timestamp: Date.now() - 86400000 * 20 },
    { type: "REPUTATION_VOTED", data: { score: 85 }, timestamp: Date.now() - 86400000 * 15 },
  ]);
}

module.exports = { 
  registerAgent, 
  listAgents, 
  getAgent, 
  submitReputation,
  getReputationHistory,
  recordActivity,
  getActivityFeed,
  getLeaderboard,
  CAPABILITIES,
  ACTIVITY_TYPES 
};

// Note: reputation is stored in basis points (0-10000); divide by 100 for percentage display
