"use client";

/**
 * Admin Fraud Dashboard
 *
 * The triage queue for automated fraud findings:
 *  - browse signals, sorted by score or recency, filtered by tier/detector/status
 *  - read exactly which detectors fired and on what evidence
 *  - visualise the sybil cluster behind an address
 *  - dismiss a false positive, with a reason that feeds detector tuning
 *
 * Auth: every call carries x-admin-key, entered by the operator, matching the
 * pattern the compliance dashboard already uses.
 */

import { useCallback, useEffect, useState } from "react";
import SybilGraphView, { Subgraph } from "./SybilGraphView";
import SignalExplainability, { FraudSignal, RiskTierBadge } from "./SignalExplainability";

const API = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";

const DETECTORS = ["composite", "velocity", "sybil_graph", "wash_usage", "replay_abuse"] as const;
const RISK_TIERS = ["critical", "high", "medium", "low"] as const;
const STATUSES = ["open", "reported", "dismissed"] as const;

interface ListMeta {
  total: number;
  page: number;
  limit: number;
  pages: number;
}

interface GraphResponse {
  address: string;
  found: boolean;
  cluster: { size: number; density: number; members: string[]; withinScanBounds: boolean } | null;
  subgraph: Subgraph | null;
  score: {
    value: number;
    fired: boolean;
    threshold: number;
    measuredWeight: number;
    subScores: Record<string, number | null>;
  } | null;
}

export default function FraudPage() {
  const [adminKey, setAdminKey] = useState("");
  const [operatorId, setOperatorId] = useState("");

  // `null` means "not fetched yet", which is also the loading indicator —
  // one less piece of state, and no synchronous setState inside the effect.
  const [signals, setSignals] = useState<FraudSignal[] | null>(null);
  const [meta, setMeta] = useState<ListMeta | null>(null);
  const [page, setPage] = useState(1);
  const [sort, setSort] = useState<"score" | "recent">("score");
  const [status, setStatus] = useState<string>("open");
  const [detector, setDetector] = useState<string>("");
  const [riskTier, setRiskTier] = useState<string>("");

  const [selected, setSelected] = useState<FraudSignal | null>(null);
  const [graph, setGraph] = useState<GraphResponse | null>(null);
  const [graphLoading, setGraphLoading] = useState(false);

  const [dismissReason, setDismissReason] = useState("");
  const [dismissing, setDismissing] = useState(false);

  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [refreshToken, setRefreshToken] = useState(0);

  const apiFetch = useCallback(
    async <T,>(path: string, opts?: RequestInit): Promise<T> => {
      const res = await fetch(`${API}${path}`, {
        ...opts,
        headers: { ...(opts?.headers || {}), "Content-Type": "application/json", "x-admin-key": adminKey },
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error((data as { error?: string }).error ?? `HTTP ${res.status}`);
      return data as T;
    },
    [adminKey]
  );

  // Fetching lives inside the effect rather than in a callback the effect
  // invokes: the effect body then holds no synchronous setState, which is what
  // the cascading-render rule is about. `refreshToken` is how an action such as
  // a dismissal asks for a reload.
  useEffect(() => {
    if (!adminKey) return;
    let cancelled = false;

    (async () => {
      const params = new URLSearchParams({ page: String(page), limit: "20", sort });
      if (status) params.set("status", status);
      if (detector) params.set("detector", detector);
      if (riskTier) params.set("riskTier", riskTier);

      try {
        const data = await apiFetch<{ data: FraudSignal[]; meta: ListMeta }>(
          `/api/v1/admin/fraud/signals?${params.toString()}`
        );
        if (cancelled) return;
        setSignals(data.data);
        setMeta(data.meta);
        setError(null);
      } catch (e) {
        if (cancelled) return;
        setSignals([]);
        setError((e as Error).message);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [adminKey, page, sort, status, detector, riskTier, refreshToken, apiFetch]);

  async function openSignal(signal: FraudSignal) {
    setSelected(signal);
    setGraph(null);
    setDismissReason("");
    setNotice(null);

    // The graph is only meaningful for findings that involve a cluster.
    if (signal.detector !== "sybil_graph" && signal.detector !== "composite") return;

    setGraphLoading(true);
    try {
      const data = await apiFetch<GraphResponse>(
        `/api/v1/admin/fraud/agents/${encodeURIComponent(signal.agentAddress)}/graph`
      );
      setGraph(data);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setGraphLoading(false);
    }
  }

  async function handleDismiss() {
    if (!selected || !operatorId.trim()) return;
    setDismissing(true);
    setError(null);
    try {
      await apiFetch(`/api/v1/admin/fraud/signals/${selected.id}/dismiss`, {
        method: "POST",
        body: JSON.stringify({
          dismissedBy: operatorId.trim(),
          reason: dismissReason.trim() || undefined,
        }),
      });
      setNotice(`Signal #${selected.id} dismissed.`);
      setSelected(null);
      setGraph(null);
      setSignals(null);
      setRefreshToken((token) => token + 1);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setDismissing(false);
    }
  }

  // ── Key gate ────────────────────────────────────────────────────────────────

  if (!adminKey) {
    return (
      <main className="min-h-screen bg-[var(--background)] text-[var(--foreground)] pt-12 px-6 pb-16">
        <div className="max-w-xl mx-auto">
          <p className="text-sm font-mono text-purple-600 dark:text-purple-400 tracking-widest uppercase mb-1">Admin</p>
          <h1 className="text-3xl font-bold mb-6">Fraud &amp; Anomaly Queue</h1>
          <label htmlFor="admin-key" className="block text-sm text-[var(--muted)] mb-2">
            Admin API key
          </label>
          <input
            id="admin-key"
            type="password"
            onChange={(e) => setAdminKey(e.target.value)}
            className="w-full px-4 py-3 bg-zinc-100 dark:bg-zinc-900 border border-[var(--border)] rounded-lg
                       font-mono text-sm focus:outline-none focus:border-purple-500"
          />
          <p className="text-xs text-[var(--muted)] mt-3">
            The key is sent as the <code className="text-[var(--foreground)]">x-admin-key</code> header.
          </p>
        </div>
      </main>
    );
  }

  // ── Main UI ─────────────────────────────────────────────────────────────────

  return (
    <main className="min-h-screen bg-[var(--background)] text-[var(--foreground)] pt-12 px-6 pb-16">
      <div className="max-w-7xl mx-auto">
        <div className="mb-8 pb-6 border-b border-[var(--border)] flex items-center justify-between">
          <div>
            <p className="text-sm font-mono text-purple-600 dark:text-purple-400 tracking-widest uppercase mb-1">Admin</p>
            <h1 className="text-3xl font-bold">Fraud &amp; Anomaly Queue</h1>
          </div>
          <button onClick={() => setAdminKey("")} className="text-xs text-[var(--muted)] hover:text-red-600 dark:hover:text-red-400">
            Clear key
          </button>
        </div>

        {error && (
          <div className="mb-6 px-4 py-3 bg-red-500/10 border border-red-500/30 rounded-lg text-red-600 dark:text-red-400 text-sm">
            {error}
          </div>
        )}
        {notice && (
          <div className="mb-6 px-4 py-3 bg-green-500/10 border border-green-500/30 rounded-lg text-green-600 dark:text-green-400 text-sm">
            {notice}
          </div>
        )}

        {/* Filters */}
        <div className="flex flex-wrap gap-3 mb-6">
          <select
            aria-label="Status"
            value={status}
            onChange={(e) => { setStatus(e.target.value); setPage(1); setSignals(null); }}
            className="px-3 py-2 bg-zinc-100 dark:bg-zinc-900 border border-[var(--border)] rounded text-sm"
          >
            <option value="">All statuses</option>
            {STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>

          <select
            aria-label="Detector"
            value={detector}
            onChange={(e) => { setDetector(e.target.value); setPage(1); setSignals(null); }}
            className="px-3 py-2 bg-zinc-100 dark:bg-zinc-900 border border-[var(--border)] rounded text-sm"
          >
            <option value="">All detectors</option>
            {DETECTORS.map((d) => <option key={d} value={d}>{d}</option>)}
          </select>

          <select
            aria-label="Risk tier"
            value={riskTier}
            onChange={(e) => { setRiskTier(e.target.value); setPage(1); setSignals(null); }}
            className="px-3 py-2 bg-zinc-100 dark:bg-zinc-900 border border-[var(--border)] rounded text-sm"
          >
            <option value="">All tiers</option>
            {RISK_TIERS.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>

          <select
            aria-label="Sort by"
            value={sort}
            onChange={(e) => { setSort(e.target.value as "score" | "recent"); setPage(1); setSignals(null); }}
            className="px-3 py-2 bg-zinc-100 dark:bg-zinc-900 border border-[var(--border)] rounded text-sm"
          >
            <option value="score">Highest score first</option>
            <option value="recent">Most recent first</option>
          </select>
        </div>

        <div className="grid lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-8">
          {/* Queue */}
          <section>
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-lg font-semibold">Risk queue</h2>
              <p className="text-xs text-[var(--muted)]">
                {signals === null
                  ? "Loading…"
                  : `${meta?.total ?? 0} signal${meta?.total === 1 ? "" : "s"}`}
              </p>
            </div>

            {signals !== null && signals.length === 0 && (
              <p className="text-sm text-[var(--muted)] py-8 text-center border border-[var(--border)] rounded-lg">
                Nothing in the queue.
              </p>
            )}

            <ul className="space-y-2">
              {(signals ?? []).map((signal) => (
                <li key={signal.id}>
                  <button
                    onClick={() => openSignal(signal)}
                    aria-current={selected?.id === signal.id}
                    className={`w-full text-left p-4 bg-zinc-100 dark:bg-zinc-900 border rounded-lg transition-colors ${
                      selected?.id === signal.id
                        ? "border-purple-500"
                        : "border-[var(--border)] hover:border-zinc-400 dark:hover:border-zinc-600"
                    }`}
                  >
                    <div className="flex items-center justify-between gap-3 mb-2">
                      <div className="flex items-center gap-2">
                        <RiskTierBadge tier={signal.riskTier} />
                        <span className="font-mono text-xs text-[var(--muted)]">{signal.detector}</span>
                      </div>
                      <span className="font-mono text-sm text-[var(--foreground)]">
                        {signal.score.toFixed(2)}
                      </span>
                    </div>
                    <p className="font-mono text-xs text-[var(--muted)] truncate">{signal.agentAddress}</p>
                    {signal.asset && (
                      <p className="text-xs text-[var(--muted)] mt-1 truncate">
                        {signal.asset.name} (#{signal.asset.id})
                      </p>
                    )}
                  </button>
                </li>
              ))}
            </ul>

            {meta && meta.pages > 1 && (
              <div className="flex items-center justify-between mt-4 text-sm">
                <button
                  onClick={() => setPage((p) => Math.max(1, p - 1))}
                  disabled={page <= 1}
                  className="px-3 py-1.5 bg-zinc-100 dark:bg-zinc-900 border border-[var(--border)] rounded disabled:opacity-40"
                >
                  Previous
                </button>
                <span className="text-[var(--muted)]">
                  Page {meta.page} of {meta.pages}
                </span>
                <button
                  onClick={() => setPage((p) => Math.min(meta.pages, p + 1))}
                  disabled={page >= meta.pages}
                  className="px-3 py-1.5 bg-zinc-100 dark:bg-zinc-900 border border-[var(--border)] rounded disabled:opacity-40"
                >
                  Next
                </button>
              </div>
            )}
          </section>

          {/* Detail */}
          <section>
            {!selected && (
              <p className="text-sm text-[var(--muted)] py-8 text-center border border-[var(--border)] rounded-lg">
                Select a signal to see why it fired.
              </p>
            )}

            {selected && (
              <div className="space-y-6">
                <SignalExplainability signal={selected} />

                {graphLoading && <p className="text-sm text-[var(--muted)]">Loading cluster graph…</p>}

                {graph && (
                  <div className="space-y-3">
                    <SybilGraphView
                      subgraph={graph.subgraph}
                      focusAddress={graph.address}
                    />
                    {graph.cluster && graph.score && (
                      <p className="text-xs text-[var(--muted)]">
                        Cluster of {graph.cluster.size}, density{" "}
                        {graph.cluster.density.toFixed(2)} · score {graph.score.value.toFixed(2)} vs
                        threshold {graph.score.threshold} · measured weight{" "}
                        {graph.score.measuredWeight.toFixed(2)}
                      </p>
                    )}
                  </div>
                )}

                {selected.status === "open" && (
                  <div className="p-4 bg-zinc-100 dark:bg-zinc-900 border border-[var(--border)] rounded-lg space-y-3">
                    <h3 className="text-sm font-semibold">Dismiss as a false positive</h3>
                    <label htmlFor="operator" className="block text-xs text-[var(--muted)]">
                      Operator
                    </label>
                    <input
                      id="operator"
                      value={operatorId}
                      onChange={(e) => setOperatorId(e.target.value)}
                      placeholder="you@example.com"
                      className="w-full px-3 py-2 bg-[var(--background)] border border-[var(--border)] rounded text-sm"
                    />
                    <label htmlFor="reason" className="block text-xs text-[var(--muted)]">
                      Reason (kept as detector tuning data)
                    </label>
                    <textarea
                      id="reason"
                      value={dismissReason}
                      onChange={(e) => setDismissReason(e.target.value)}
                      rows={2}
                      className="w-full px-3 py-2 bg-[var(--background)] border border-[var(--border)] rounded text-sm"
                    />
                    <button
                      onClick={handleDismiss}
                      disabled={dismissing || !operatorId.trim()}
                      className="px-4 py-2 bg-red-500/10 border border-red-500/40 text-red-600 dark:text-red-400
                                 rounded text-sm hover:bg-red-500/20 disabled:opacity-40"
                    >
                      {dismissing ? "Dismissing…" : "Dismiss signal"}
                    </button>
                  </div>
                )}
              </div>
            )}
          </section>
        </div>
      </div>
    </main>
  );
}
