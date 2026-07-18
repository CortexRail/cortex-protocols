"use client";

import { useCallback, useEffect, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";

interface Agent {
  id: number;
  name: string;
  owner: string;
  description: string;
  capabilities: string[];
  reputation: number;
  totalTransactions: number;
  registeredAt: number;
  indexedAt: number;
  isActive: boolean;
}

interface ReputationHistoryResponse {
  data: ReputationHistoryEntry[];
  meta: { agentId: string; count: number };
}

interface ReputationHistoryEntry {
  score: number;
  voter: string;
  timestamp: number;
}

interface ActivityFeedResponse {
  data: ActivityEntry[];
  meta: { total: number; page: number; limit: number; pages: number };
}

interface ActivityEntry {
  type: string;
  data: unknown;
  timestamp: number;
}

export default function AgentProfilePage() {
  const params = useParams();
  const agentId = params.id as string;

  const [agent, setAgent] = useState<Agent | null>(null);
  const [reputationHistory, setReputationHistory] = useState<ReputationHistoryEntry[]>([]);
  const [activity, setActivity] = useState<ActivityEntry[]>([]);
  const [activeTab, setActiveTab] = useState<"overview" | "reputation" | "activity">("overview");
  const [voteScore, setVoteScore] = useState(50);
  const [loading, setLoading] = useState(true);

  const fetchAgent = useCallback(async () => {
    try {
      const res = await fetch(`http://localhost:4000/api/v1/agents/${agentId}`);
      if (res.ok) {
        return (await res.json()) as Agent;
      }
    } catch (err) {
      console.error("Failed to fetch agent:", err);
    }
    return null;
  }, [agentId]);

  const fetchReputationHistory = useCallback(async () => {
    try {
      const res = await fetch(
        `http://localhost:4000/api/v1/agents/${agentId}/reputation-history?limit=30`
      );
      if (res.ok) {
        const data: ReputationHistoryResponse = await res.json();
        return data.data;
      }
    } catch (err) {
      console.error("Failed to fetch reputation history:", err);
    }
    return null;
  }, [agentId]);

  const fetchActivity = useCallback(async () => {
    try {
      const res = await fetch(
        `http://localhost:4000/api/v1/agents/${agentId}/activity?limit=20`
      );
      if (res.ok) {
        const data: ActivityFeedResponse = await res.json();
        return data.data;
      }
    } catch (err) {
      console.error("Failed to fetch activity:", err);
    }
    return null;
  }, [agentId]);

  useEffect(() => {
    let cancelled = false;

    Promise.all([fetchAgent(), fetchReputationHistory(), fetchActivity()]).then(
      ([nextAgent, nextReputationHistory, nextActivity]) => {
        if (cancelled) return;
        if (nextAgent) setAgent(nextAgent);
        if (nextReputationHistory) setReputationHistory(nextReputationHistory);
        if (nextActivity) setActivity(nextActivity);
        setLoading(false);
      }
    );

    return () => {
      cancelled = true;
    };
  }, [fetchActivity, fetchAgent, fetchReputationHistory]);

  async function submitVote() {
    try {
      const res = await fetch(`http://localhost:4000/api/v1/agents/${agentId}/reputation`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          score: voteScore,
          voter: "G" + "X".repeat(55),  // Placeholder
        }),
      });
      if (res.ok) {
        alert("Vote submitted!");
        const nextReputationHistory = await fetchReputationHistory();
        if (nextReputationHistory) setReputationHistory(nextReputationHistory);
      }
    } catch (err) {
      console.error("Failed to submit vote:", err);
    }
  }

  if (loading || !agent) {
    return (
      <main className="min-h-screen bg-black text-white pt-12 px-6 flex items-center justify-center">
        <p className="text-zinc-400">Loading agent profile...</p>
      </main>
    );
  }

  const avgRep = Math.round(agent.reputation / 100);
  const isVerified = avgRep >= 80;

  const getRepColor = (score: number) => {
    if (score < 40) return "text-red-500";
    if (score < 70) return "text-yellow-500";
    return "text-green-500";
  };

  const getRepBg = (score: number) => {
    if (score < 40) return "bg-red-500/10";
    if (score < 70) return "bg-yellow-500/10";
    return "bg-green-500/10";
  };

  return (
    <main className="min-h-screen bg-black text-white pt-12 px-6 pb-12">
      <div className="max-w-4xl mx-auto">
        {/* Header */}
        <div className="flex items-start justify-between mb-8 pb-6 border-b border-zinc-800">
          <div className="flex-1">
            <Link
              href="/agents"
              className="text-zinc-400 hover:text-white mb-4 inline-block text-sm"
            >
              ← Back to Directory
            </Link>

            <div className="flex items-center gap-4">
              <div className="w-16 h-16 bg-gradient-to-br from-purple-500 to-pink-500 rounded-lg" />
              <div>
                <h1 className="text-3xl font-bold mb-2">{agent.name}</h1>
                <div className="flex items-center gap-3">
                  <p className="text-sm text-zinc-400 font-mono">
                    {agent.owner.slice(0, 20)}...
                  </p>
                  {isVerified && (
                    <span className="px-2 py-1 bg-green-500/20 text-green-400 text-xs rounded-full font-semibold">
                      Verified
                    </span>
                  )}
                </div>
              </div>
            </div>
          </div>

          <div className="text-right">
            <p className="text-sm text-zinc-500 mb-1">Reputation</p>
            <p className={`text-3xl font-bold ${getRepColor(avgRep)}`}>
              {avgRep}%
            </p>
          </div>
        </div>

        {/* Stats Grid */}
        <div className="grid grid-cols-3 gap-4 mb-8">
          {[
            { label: "Transactions", value: agent.totalTransactions },
            {
              label: "Member Since",
              value: new Date(agent.registeredAt).toLocaleDateString(),
            },
            {
              label: "Capabilities",
              value: agent.capabilities.length,
            },
          ].map(({ label, value }) => (
            <div key={label} className="p-4 bg-zinc-900 border border-zinc-800 rounded-lg">
              <p className="text-xs text-zinc-500 mb-2">{label}</p>
              <p className="text-xl font-bold">{value}</p>
            </div>
          ))}
        </div>

        {/* Description */}
        <div className="p-6 bg-zinc-900 border border-zinc-800 rounded-lg mb-8">
          <h3 className="font-semibold mb-2">About</h3>
          <p className="text-zinc-300">{agent.description}</p>
        </div>

        {/* Capabilities */}
        <div className="p-6 bg-zinc-900 border border-zinc-800 rounded-lg mb-8">
          <h3 className="font-semibold mb-4">Capabilities</h3>
          <div className="flex flex-wrap gap-2">
            {agent.capabilities.map((cap) => (
              <span key={cap} className="px-3 py-1 bg-purple-500/20 text-purple-300 rounded-full text-sm">
                {cap}
              </span>
            ))}
          </div>
        </div>

        {/* Tabs */}
        <div className="flex gap-4 mb-6 border-b border-zinc-800">
          {(["overview", "reputation", "activity"] as const).map((tab) => (
            <button
              key={tab}
              onClick={() => setActiveTab(tab)}
              className={`px-4 py-3 text-sm font-semibold border-b-2 transition-colors ${
                activeTab === tab
                  ? "border-purple-500 text-white"
                  : "border-transparent text-zinc-400 hover:text-white"
              }`}
            >
              {tab.charAt(0).toUpperCase() + tab.slice(1)}
            </button>
          ))}
        </div>

        {/* Tab Content */}
        {activeTab === "reputation" && (
          <div className="space-y-6">
            {/* Reputation Chart */}
            <div className="p-6 bg-zinc-900 border border-zinc-800 rounded-lg">
              <h3 className="font-semibold mb-4">Reputation History</h3>
              {reputationHistory.length > 0 ? (
                <div>
                  <p className="text-sm text-zinc-400 mb-4">
                    Last {reputationHistory.length} votes
                  </p>
                  <div className="space-y-2">
                    {reputationHistory.map((entry, idx) => (
                      <div key={idx} className="flex items-center justify-between">
                        <div className="flex-1">
                          <div
                            className={`h-2 ${getRepBg(entry.score)} rounded-full`}
                            style={{ width: `${entry.score}%` }}
                          />
                        </div>
                        <span className={`ml-3 font-semibold min-w-fit ${getRepColor(entry.score)}`}>
                          {entry.score}%
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              ) : (
                <p className="text-zinc-400 text-sm">No reputation votes yet</p>
              )}
            </div>

            {/* Vote Form */}
            <div className="p-6 bg-zinc-900 border border-zinc-800 rounded-lg">
              <h3 className="font-semibold mb-4">Vote on Reputation</h3>
              <div className="space-y-4">
                <div>
                  <label className="text-sm text-zinc-400 mb-2 block">
                    Score: {voteScore}%
                  </label>
                  <input
                    type="range"
                    min="0"
                    max="100"
                    value={voteScore}
                    onChange={(e) => setVoteScore(Number(e.target.value))}
                    className="w-full"
                  />
                  <div className="flex justify-between text-xs text-zinc-500 mt-2">
                    <span>Poor</span>
                    <span>Fair</span>
                    <span>Good</span>
                    <span>Excellent</span>
                    <span>Outstanding</span>
                  </div>
                </div>
                <button
                  onClick={submitVote}
                  className="w-full px-4 py-2 bg-purple-600 hover:bg-purple-700 rounded-lg font-semibold transition-colors"
                >
                  Submit Vote
                </button>
              </div>
            </div>
          </div>
        )}

        {activeTab === "activity" && (
          <div className="space-y-3">
            {activity.length > 0 ? (
              activity.map((event, idx) => (
                <div key={idx} className="p-4 bg-zinc-900 border border-zinc-800 rounded-lg">
                  <div className="flex justify-between items-start">
                    <div>
                      <p className="font-semibold text-sm">{event.type}</p>
                      <p className="text-xs text-zinc-400 mt-1">
                        {new Date(event.timestamp).toLocaleString()}
                      </p>
                    </div>
                    <span className="text-xs text-zinc-500 bg-zinc-800 px-2 py-1 rounded">
                      {JSON.stringify(event.data).substring(0, 30)}...
                    </span>
                  </div>
                </div>
              ))
            ) : (
              <p className="text-zinc-400 text-sm">No activity yet</p>
            )}
          </div>
        )}
      </div>
    </main>
  );
}
