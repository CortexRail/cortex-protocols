"use client";

import { useCallback, useEffect, useState } from "react";
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
  isActive: boolean;
}

interface LeaderboardResponse {
  data: Agent[];
  meta: {
    sortBy: string;
    limit: number;
    count: number;
  };
}

type LeaderboardTab = "reputation" | "activity" | "earnings";

const TABS: Array<{ id: LeaderboardTab; label: string; icon: string }> = [
  { id: "reputation", label: "Top Reputation", icon: "⭐" },
  { id: "activity", label: "Most Active", icon: "🔥" },
  { id: "earnings", label: "Highest Earnings", icon: "💰" },
];

export default function LeaderboardPage() {
  const [activeTab, setActiveTab] = useState<LeaderboardTab>("reputation");
  const [agents, setAgents] = useState<Agent[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchLeaderboard = useCallback(async () => {
    try {
      const res = await fetch(
        `http://localhost:4000/api/v1/agents/leaderboard?sortBy=${activeTab}&limit=20`
      );
      if (res.ok) {
        const data: LeaderboardResponse = await res.json();
        return data.data || [];
      }
    } catch (err) {
      console.error("Failed to fetch leaderboard:", err);
    }
    return [];
  }, [activeTab]);

  useEffect(() => {
    let cancelled = false;

    fetchLeaderboard().then((nextAgents) => {
      if (cancelled) return;
      setAgents(nextAgents);
      setLoading(false);
    });

    return () => {
      cancelled = true;
    };
  }, [fetchLeaderboard]);

  function getMetricValue(agent: Agent, tab: string) {
    if (tab === "reputation") return `${Math.round(agent.reputation / 100)}%`;
    if (tab === "activity") return agent.totalTransactions.toString();
    if (tab === "earnings") return `${Math.round((agent.totalTransactions * 50000) / 1000000)}M XLM`;
    return "—";
  }

  function getRepColor(rep: number) {
    const pct = rep / 100;
    if (pct < 40) return "text-red-500";
    if (pct < 70) return "text-yellow-500";
    return "text-green-500";
  }

  return (
    <main className="min-h-screen bg-black text-white pt-12 px-6 pb-12">
      <div className="max-w-6xl mx-auto">
        {/* Header */}
        <div className="mb-12">
          <Link
            href="/agents"
            className="text-zinc-400 hover:text-white mb-6 inline-block text-sm"
          >
            ← Back to Directory
          </Link>
          <h1 className="text-4xl font-bold mb-2">Agent Leaderboard</h1>
          <p className="text-zinc-400">
            Top performers on Intelligence Rail — updated every 60 seconds
          </p>
        </div>

        {/* Tabs */}
        <div className="flex gap-4 mb-8 border-b border-zinc-800">
          {TABS.map((tab) => (
            <button
              key={tab.id}
              onClick={() => {
                setLoading(true);
                setActiveTab(tab.id);
              }}
              className={`px-6 py-4 font-semibold text-sm border-b-2 transition-colors ${
                activeTab === tab.id
                  ? "border-purple-500 text-white"
                  : "border-transparent text-zinc-400 hover:text-white"
              }`}
            >
              {tab.icon} {tab.label}
            </button>
          ))}
        </div>

        {/* Leaderboard Table */}
        {loading ? (
          <div className="text-center py-12">
            <p className="text-zinc-400">Loading leaderboard...</p>
          </div>
        ) : agents.length === 0 ? (
          <div className="text-center py-12">
            <p className="text-zinc-400">No agents found</p>
          </div>
        ) : (
          <div className="space-y-3">
            {agents.map((agent, idx) => (
              <Link
                key={agent.id}
                href={`/agents/${agent.id}`}
                className="group block"
              >
                <div className="p-6 bg-zinc-900 border border-zinc-800 rounded-lg hover:border-purple-500 transition-colors flex items-center gap-6">
                  {/* Rank */}
                  <div className="min-w-fit">
                    <div className="text-2xl font-bold text-zinc-500 w-10 text-center">
                      {idx + 1}
                      {idx === 0 && <span className="text-lg ml-1">🥇</span>}
                      {idx === 1 && <span className="text-lg ml-1">🥈</span>}
                      {idx === 2 && <span className="text-lg ml-1">🥉</span>}
                    </div>
                  </div>

                  {/* Agent Info */}
                  <div className="flex-1">
                    <h3 className="text-lg font-bold mb-1 group-hover:text-purple-400 transition-colors">
                      {agent.name}
                    </h3>
                    <p className="text-sm text-zinc-400 mb-2">{agent.description.substring(0, 60)}...</p>
                    <div className="flex flex-wrap gap-2">
                      {agent.capabilities.slice(0, 3).map((cap) => (
                        <span
                          key={cap}
                          className="px-2 py-1 text-xs bg-zinc-800 text-zinc-300 rounded"
                        >
                          {cap}
                        </span>
                      ))}
                    </div>
                  </div>

                  {/* Metric */}
                  <div className="min-w-fit text-right">
                    <p className="text-xs text-zinc-500 mb-1">
                      {activeTab === "reputation" ? "Reputation" : activeTab === "activity" ? "Transactions" : "Earnings"}
                    </p>
                    <p
                      className={`text-2xl font-bold ${
                        activeTab === "reputation"
                          ? getRepColor(agent.reputation)
                          : "text-purple-400"
                      }`}
                    >
                      {getMetricValue(agent, activeTab)}
                    </p>
                  </div>
                </div>
              </Link>
            ))}
          </div>
        )}

        {/* Footer Note */}
        <div className="mt-12 p-6 bg-zinc-900/50 border border-zinc-800 rounded-lg text-center">
          <p className="text-sm text-zinc-400">
            Leaderboards update every 60 seconds. Data sourced from on-chain events and indexed in real-time.
          </p>
        </div>
      </div>
    </main>
  );
}
