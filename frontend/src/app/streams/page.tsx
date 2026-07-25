"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { API_BASE_URL } from "@/lib/constants";
import { stroopsToXlm } from "@/lib/stroops";

interface Stream {
  id: number;
  sender: string;
  recipient: string;
  token: string;
  /** Stroops. */
  deposit: number;
  /** Stroops per second. */
  ratePerSecond: number;
  /** Unix seconds. */
  startTime: number;
  /** Unix seconds. */
  endTime: number;
  status: StreamStatus;
  /** Stroops. */
  withdrawn: number;
  indexedAt: number;
  updatedAt: number;
}

interface ListResponse {
  data: Stream[];
  meta: {
    total: number;
    page: number;
    limit: number;
    pages: number;
  };
}

const STREAM_STATUSES = ["Active", "Paused", "Completed", "Cancelled"] as const;
type StreamStatus = (typeof STREAM_STATUSES)[number];

const PAGE_SIZE = 50;

const STATUS_STYLES: Record<StreamStatus, string> = {
  Active: "bg-green-500/10 text-green-500",
  Paused: "bg-yellow-500/10 text-yellow-500",
  Completed: "bg-purple-500/10 text-purple-400",
  Cancelled: "bg-red-500/10 text-red-500",
};

/** GABC…WXYZ — Stellar addresses are too long to show whole in a table. */
function truncateAddress(address: string): string {
  if (address.length <= 12) return address;
  return `${address.slice(0, 4)}…${address.slice(-4)}`;
}

/**
 * Stroops streamed to the recipient so far. For live streams this advances
 * every second; settled streams report their final amounts.
 */
function streamedStroops(stream: Stream, nowSeconds: number): bigint {
  const deposit = BigInt(stream.deposit);
  switch (stream.status) {
    case "Completed":
      return deposit;
    case "Cancelled":
    case "Paused":
      return BigInt(stream.withdrawn);
    case "Active": {
      const elapsed = BigInt(
        Math.max(0, Math.min(nowSeconds, stream.endTime) - stream.startTime)
      );
      const streamed = BigInt(stream.ratePerSecond) * elapsed;
      return streamed > deposit ? deposit : streamed;
    }
  }
}

function progressPercent(stream: Stream, nowSeconds: number): number {
  if (stream.deposit <= 0) return 0;
  const pct =
    Number((streamedStroops(stream, nowSeconds) * 1000n) / BigInt(stream.deposit)) / 10;
  return Math.min(100, pct);
}

function formatDate(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatRemaining(stream: Stream, nowSeconds: number): string {
  if (stream.status !== "Active") return "—";
  const remaining = stream.endTime - nowSeconds;
  if (remaining <= 0) return "settling";
  const days = Math.floor(remaining / 86_400);
  const hours = Math.floor((remaining % 86_400) / 3_600);
  const minutes = Math.floor((remaining % 3_600) / 60);
  if (days > 0) return `${days}d ${hours}h left`;
  if (hours > 0) return `${hours}h ${minutes}m left`;
  return `${minutes}m left`;
}

export default function StreamsPage() {
  const [streams, setStreams] = useState<Stream[]>([]);
  const [meta, setMeta] = useState<ListResponse["meta"] | null>(null);
  const [activeTotal, setActiveTotal] = useState<number | null>(null);
  const [statusFilter, setStatusFilter] = useState<StreamStatus | "All">("All");
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [nowSeconds, setNowSeconds] = useState(() => Math.floor(Date.now() / 1000));

  const fetchStreams = useCallback(async () => {
    const params = new URLSearchParams({
      page: String(page),
      limit: String(PAGE_SIZE),
    });
    if (statusFilter !== "All") params.append("status", statusFilter);

    const [listRes, activeRes] = await Promise.all([
      fetch(`${API_BASE_URL}/api/v1/streams?${params}`),
      fetch(`${API_BASE_URL}/api/v1/streams?status=Active&limit=1`),
    ]);
    if (!listRes.ok) throw new Error(`Request failed (${listRes.status})`);

    const list: ListResponse = await listRes.json();
    const active: ListResponse | null = activeRes.ok ? await activeRes.json() : null;
    return { list, activeTotal: active?.meta.total ?? null };
  }, [page, statusFilter]);

  // Initial load, filter/page changes, and a 15s refresh cycle.
  useEffect(() => {
    let cancelled = false;

    const load = () =>
      fetchStreams()
        .then(({ list, activeTotal: nextActiveTotal }) => {
          if (cancelled) return;
          setStreams(list.data);
          setMeta(list.meta);
          setActiveTotal(nextActiveTotal);
          setError(null);
          setLoading(false);
        })
        .catch((err) => {
          if (cancelled) return;
          setError(
            err instanceof Error && err.message.startsWith("Request failed")
              ? err.message
              : "Could not reach the backend. Is the API server running?"
          );
          setLoading(false);
        });

    load();
    const refresh = setInterval(load, 15_000);
    return () => {
      cancelled = true;
      clearInterval(refresh);
    };
  }, [fetchStreams]);

  // Once per second so live progress bars and streamed amounts advance.
  useEffect(() => {
    const tick = setInterval(
      () => setNowSeconds(Math.floor(Date.now() / 1000)),
      1000
    );
    return () => clearInterval(tick);
  }, []);

  const totals = useMemo(() => {
    let deposited = 0n;
    let streamed = 0n;
    let withdrawn = 0n;
    for (const stream of streams) {
      deposited += BigInt(stream.deposit);
      streamed += streamedStroops(stream, nowSeconds);
      withdrawn += BigInt(stream.withdrawn);
    }
    return { deposited, streamed, withdrawn };
  }, [streams, nowSeconds]);

  const statTiles = [
    { label: "Active Streams", value: activeTotal !== null ? String(activeTotal) : "—" },
    { label: "Total Streams", value: meta ? String(meta.total) : "—" },
    { label: "Deposited (XLM)", value: stroopsToXlm(totals.deposited) },
    { label: "Streamed (XLM)", value: stroopsToXlm(totals.streamed) },
  ];

  return (
    <main className="min-h-screen bg-white dark:bg-black text-black dark:text-white pt-20 px-6">
      <div className="max-w-7xl mx-auto">
        {/* Header */}
        <div className="mb-8">
          <h1 className="text-4xl font-bold mb-2">Payment Streams</h1>
          <p className="text-zinc-500 dark:text-zinc-400">
            Live view of on-chain micropayment streams between agents
          </p>
        </div>

        {/* Stat tiles */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
          {statTiles.map(({ label, value }) => (
            <div
              key={label}
              className="p-4 bg-zinc-50 dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-lg"
            >
              <p className="text-xs text-zinc-400 dark:text-zinc-500 uppercase tracking-wider mb-1">
                {label}
              </p>
              <p className="text-2xl font-bold font-mono">{value}</p>
            </div>
          ))}
        </div>

        {/* Status filter */}
        <div className="flex flex-wrap gap-2 mb-6">
          {(["All", ...STREAM_STATUSES] as const).map((status) => (
            <button
              key={status}
              onClick={() => {
                setLoading(true);
                setStatusFilter(status);
                setPage(1);
              }}
              className={`px-3 py-1 rounded-full text-sm transition-colors ${
                statusFilter === status
                  ? "bg-purple-600 text-white"
                  : "bg-zinc-100 dark:bg-zinc-800 text-zinc-500 dark:text-zinc-400 hover:bg-zinc-200 dark:hover:bg-zinc-700"
              }`}
            >
              {status}
            </button>
          ))}
        </div>

        {/* Stream table */}
        {loading ? (
          <div className="text-center py-12">
            <p className="text-zinc-500 dark:text-zinc-400">Loading streams...</p>
          </div>
        ) : error ? (
          <div className="text-center py-12 space-y-4">
            <p className="text-red-500">{error}</p>
            <button
              onClick={() => {
                setLoading(true);
                setError(null);
                setPage(1);
              }}
              className="px-4 py-2 bg-purple-600 hover:bg-purple-700 text-white rounded-lg font-semibold transition-colors"
            >
              Retry
            </button>
          </div>
        ) : streams.length === 0 ? (
          <div className="text-center py-12">
            <p className="text-zinc-500 dark:text-zinc-400">
              {statusFilter === "All"
                ? "No payment streams indexed yet"
                : `No ${statusFilter.toLowerCase()} streams`}
            </p>
          </div>
        ) : (
          <>
            <div className="overflow-x-auto border border-zinc-200 dark:border-zinc-800 rounded-lg mb-8">
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-zinc-50 dark:bg-zinc-900 text-left text-xs text-zinc-400 dark:text-zinc-500 uppercase tracking-wider">
                    <th className="px-4 py-3 font-semibold">ID</th>
                    <th className="px-4 py-3 font-semibold">Sender</th>
                    <th className="px-4 py-3 font-semibold">Recipient</th>
                    <th className="px-4 py-3 font-semibold text-right">Rate (XLM/s)</th>
                    <th className="px-4 py-3 font-semibold text-right">Deposit (XLM)</th>
                    <th className="px-4 py-3 font-semibold w-48">Streamed</th>
                    <th className="px-4 py-3 font-semibold text-right">Withdrawn (XLM)</th>
                    <th className="px-4 py-3 font-semibold">Status</th>
                    <th className="px-4 py-3 font-semibold">Timing</th>
                  </tr>
                </thead>
                <tbody>
                  {streams.map((stream) => {
                    const pct = progressPercent(stream, nowSeconds);
                    return (
                      <tr
                        key={stream.id}
                        className="border-t border-zinc-200 dark:border-zinc-800 hover:bg-zinc-50 dark:hover:bg-zinc-900/50 transition-colors"
                      >
                        <td className="px-4 py-3 font-mono">#{stream.id}</td>
                        <td className="px-4 py-3 font-mono" title={stream.sender}>
                          {truncateAddress(stream.sender)}
                        </td>
                        <td className="px-4 py-3 font-mono" title={stream.recipient}>
                          {truncateAddress(stream.recipient)}
                        </td>
                        <td className="px-4 py-3 font-mono text-right">
                          {stroopsToXlm(BigInt(stream.ratePerSecond))}
                        </td>
                        <td className="px-4 py-3 font-mono text-right">
                          {stroopsToXlm(BigInt(stream.deposit))}
                        </td>
                        <td className="px-4 py-3">
                          <div className="flex items-center gap-2">
                            <div className="flex-1 h-1.5 bg-zinc-100 dark:bg-zinc-800 rounded-full overflow-hidden">
                              <div
                                className={`h-full rounded-full ${
                                  stream.status === "Cancelled"
                                    ? "bg-red-500/60"
                                    : "bg-purple-500"
                                }`}
                                style={{ width: `${pct}%` }}
                              />
                            </div>
                            <span className="text-xs text-zinc-500 dark:text-zinc-400 font-mono w-12 text-right">
                              {pct.toFixed(1)}%
                            </span>
                          </div>
                          <p className="text-xs text-zinc-400 dark:text-zinc-500 font-mono mt-1">
                            {stroopsToXlm(streamedStroops(stream, nowSeconds))} XLM
                          </p>
                        </td>
                        <td className="px-4 py-3 font-mono text-right">
                          {stroopsToXlm(BigInt(stream.withdrawn))}
                        </td>
                        <td className="px-4 py-3">
                          <span
                            className={`inline-block px-2 py-1 rounded-full text-xs font-semibold ${STATUS_STYLES[stream.status]}`}
                          >
                            {stream.status}
                          </span>
                        </td>
                        <td className="px-4 py-3 text-xs text-zinc-500 dark:text-zinc-400">
                          <p>{formatDate(stream.startTime)}</p>
                          <p>{formatRemaining(stream, nowSeconds)}</p>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            {/* Pagination */}
            {meta && meta.pages > 1 && (
              <div className="flex justify-center gap-2 mb-12">
                <button
                  onClick={() => {
                    setLoading(true);
                    setPage(Math.max(1, page - 1));
                  }}
                  disabled={page === 1}
                  className="px-3 py-1 text-sm bg-zinc-50 dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded disabled:opacity-50"
                >
                  ← Previous
                </button>
                <span className="px-3 py-1 text-sm text-zinc-500 dark:text-zinc-400">
                  Page {meta.page} of {meta.pages}
                </span>
                <button
                  onClick={() => {
                    setLoading(true);
                    setPage(page + 1);
                  }}
                  disabled={page >= meta.pages}
                  className="px-3 py-1 text-sm bg-zinc-50 dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded hover:border-purple-500 disabled:opacity-50"
                >
                  Next →
                </button>
              </div>
            )}
          </>
        )}
      </div>
    </main>
  );
}
