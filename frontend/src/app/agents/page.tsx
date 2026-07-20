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

interface ListResponse {
  data: Agent[];
  meta: {
    total: number;
    page: number;
    limit: number;
    pages: number;
  };
}

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

const SORT_OPTIONS = [
  { label: "Reputation (High)", value: "reputation" },
  { label: "Activity (High)", value: "activity" },
  { label: "Recently Active", value: "recent" },
];

export default function AgentsPage() {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [selectedCapabilities, setSelectedCapabilities] = useState<string[]>([]);
  const [sortBy, setSortBy] = useState("reputation");
  const [page, setPage] = useState(1);

  const fetchAgents = useCallback(async () => {
    try {
      const params = new URLSearchParams();
      if (search) params.append("search", search);
      if (selectedCapabilities.length === 1) {
        params.append("capability", selectedCapabilities[0]);
      }
      params.append("page", String(page));
      params.append("limit", "12");

      const res = await fetch(`http://localhost:4000/api/v1/agents?${params}`);
      const data: ListResponse = await res.json();
      return data.data || [];
    } catch (err) {
      console.error("Failed to fetch agents:", err);
      return [];
    }
  }, [page, search, selectedCapabilities]);

  useEffect(() => {
    let cancelled = false;

    fetchAgents().then((nextAgents) => {
      if (cancelled) return;
      setAgents(nextAgents);
      setLoading(false);
    });

    return () => {
      cancelled = true;
    };
  }, [fetchAgents]);

  function getReputationColor(rep: number) {
    const pct = rep / 100;
    if (pct < 40) return "text-red-500";
    if (pct < 70) return "text-yellow-500";
    return "text-green-500";
  }

  function getReputationBg(rep: number) {
    const pct = rep / 100;
    if (pct < 40) return "bg-red-500/10";
    if (pct < 70) return "bg-yellow-500/10";
    return "bg-green-500/10";
  }

  const toggleCapability = (cap: string) => {
    setLoading(true);
    setSelectedCapabilities((prev) =>
      prev.includes(cap) ? prev.filter((c) => c !== cap) : [cap]
    );
    setPage(1);
  };

  return (
    <main className="min-h-screen bg-black text-white pt-12 px-6">
      <div className="max-w-7xl mx-auto">
        {/* Header */}
        <div className="mb-12">
          <div className="flex items-center justify-between mb-6">
            <div>
              <h1 className="text-4xl font-bold mb-2">Agent Directory</h1>
              <p className="text-zinc-400">Discover and explore registered AI agents</p>
            </div>
            <Link
              href="/agents/register"
              className="px-4 py-2 bg-purple-600 hover:bg-purple-700 rounded-lg font-semibold transition-colors"
            >
              Register Agent
            </Link>
          </div>

          {/* Search */}
          <div className="mb-6">
            <input
              type="text"
              placeholder="Search by name or description..."
              value={search}
              onChange={(e) => {
                setLoading(true);
                setSearch(e.target.value);
                setPage(1);
              }}
              className="w-full px-4 py-2 bg-zinc-900 border border-zinc-800 rounded-lg text-white placeholder-zinc-500 focus:outline-none focus:border-purple-500"
            />
          </div>

          {/* Filters & Sort */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            {/* Capability Filter */}
            <div>
              <label className="text-sm font-semibold text-zinc-300 mb-3 block">
                Capabilities
              </label>
              <div className="flex flex-wrap gap-2">
                {CAPABILITIES.map((cap) => (
                  <button
                    key={cap}
                    onClick={() => toggleCapability(cap)}
                    className={`px-3 py-1 rounded-full text-sm transition-colors ${
                      selectedCapabilities.includes(cap)
                        ? "bg-purple-600 text-white"
                        : "bg-zinc-800 text-zinc-400 hover:bg-zinc-700"
                    }`}
                  >
                    {cap}
                  </button>
                ))}
              </div>
            </div>

            {/* Sort */}
            <div>
              <label className="text-sm font-semibold text-zinc-300 mb-3 block">
                Sort By
              </label>
              <select
                value={sortBy}
                onChange={(e) => {
                  setLoading(true);
                  setSortBy(e.target.value);
                }}
                className="w-full px-3 py-2 bg-zinc-900 border border-zinc-800 rounded-lg text-white focus:outline-none focus:border-purple-500"
              >
                {SORT_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </select>
            </div>
          </div>
        </div>

        {/* Agent Grid */}
        {loading ? (
          <div className="text-center py-12">
            <p className="text-zinc-400">Loading agents...</p>
          </div>
        ) : agents.length === 0 ? (
          <div className="text-center py-12">
            <p className="text-zinc-400">No agents found</p>
          </div>
        ) : (
          <>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6 mb-12">
              {agents.map((agent) => (
                <Link
                  key={agent.id}
                  href={`/agents/${agent.id}`}
                  className="group"
                >
                  <div className="h-full p-6 bg-zinc-900 border border-zinc-800 rounded-lg hover:border-purple-500 transition-colors">
                    {/* Reputation Badge */}
                    <div className={`inline-block px-3 py-1 rounded-full text-sm font-semibold mb-4 ${getReputationBg(agent.reputation)} ${getReputationColor(agent.reputation)}`}>
                      Rep: {Math.round(agent.reputation / 100)}%
                    </div>

                    {/* Name & Description */}
                    <h3 className="text-lg font-bold mb-2 group-hover:text-purple-400 transition-colors">
                      {agent.name}
                    </h3>
                    <p className="text-sm text-zinc-400 mb-4 line-clamp-2">
                      {agent.description}
                    </p>

                    {/* Capabilities */}
                    <div className="mb-4">
                      <p className="text-xs text-zinc-500 mb-2">Capabilities</p>
                      <div className="flex flex-wrap gap-1">
                        {agent.capabilities.slice(0, 3).map((cap) => (
                          <span
                            key={cap}
                            className="px-2 py-1 text-xs bg-zinc-800 text-zinc-300 rounded"
                          >
                            {cap}
                          </span>
                        ))}
                        {agent.capabilities.length > 3 && (
                          <span className="px-2 py-1 text-xs text-zinc-400">
                            +{agent.capabilities.length - 3}
                          </span>
                        )}
                      </div>
                    </div>

                    {/* Stats */}
                    <div className="grid grid-cols-2 gap-2 pt-4 border-t border-zinc-800">
                      <div>
                        <p className="text-xs text-zinc-500">Transactions</p>
                        <p className="font-semibold">{agent.totalTransactions}</p>
                      </div>
                      <div>
                        <p className="text-xs text-zinc-500">Member Since</p>
                        <p className="font-semibold text-sm">
                          {new Date(agent.registeredAt).toLocaleDateString("en-US", {
                            month: "short",
                            year: "2-digit",
                          })}
                        </p>
                      </div>
                    </div>
                  </div>
                </Link>
              ))}
            </div>

            {/* Pagination */}
            <div className="flex justify-center gap-2 mb-12">
              <button
                onClick={() => {
                  setLoading(true);
                  setPage(Math.max(1, page - 1));
                }}
                disabled={page === 1}
                className="px-3 py-1 text-sm bg-zinc-900 border border-zinc-800 rounded disabled:opacity-50"
              >
                ← Previous
              </button>
              <span className="px-3 py-1 text-sm text-zinc-400">
                Page {page}
              </span>
              <button
                onClick={() => {
                  setLoading(true);
                  setPage(page + 1);
                }}
                className="px-3 py-1 text-sm bg-zinc-900 border border-zinc-800 rounded hover:border-purple-500"
              >
                Next →
              </button>
            </div>
          </>
        )}
      </div>
    </main>
  );
}
