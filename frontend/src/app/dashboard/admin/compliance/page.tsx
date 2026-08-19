"use client";

/**
 * Admin Compliance Dashboard
 *
 * Provides the UI for:
 *  - Viewing and submitting GDPR/compliance export requests
 *  - Submitting erasure requests with an explicit immutability warning
 *  - Downloading export bundles
 *  - Viewing the request queue
 *  - Triggering the audit chain verifier
 *  - Browsing audit log entries
 *  - Browsing Merkle anchor records
 *
 * Auth: All API calls include x-admin-key from the adminKey state field.
 * In production this would come from a secure store or session; here the
 * admin enters it in the UI (suitable for an internal operator tool).
 */

import { useState, useCallback, useEffect } from "react";

const API = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";

// ── Types ──────────────────────────────────────────────────────────────────────

interface ComplianceRequest {
  id: number;
  requestType: "export" | "erasure";
  subjectId: string;
  requestedBy: string;
  status: "pending" | "processing" | "completed" | "failed";
  resultSummary: Record<string, unknown> | null;
  downloadToken: string | null;
  errorMessage: string | null;
  createdAt: number;
  completedAt: number | null;
  hasBundleAvailable?: boolean;
}

interface VerifyResult {
  valid: boolean;
  checkedCount: number;
  durationMs: number;
  brokenAt?: number;
  reason?: string;
}

interface AuditEntry {
  id: number;
  seq: number;
  eventType: string;
  actor: string;
  subjectId: string | null;
  payload: Record<string, unknown>;
  entryHash: string;
  prevHash: string | null;
  createdAt: string | number;
}

interface AnchorRecord {
  id: number;
  fromSeq: number;
  toSeq: number;
  entryCount: number;
  merkleRoot: string;
  onChainTx: string | null;
  anchorIndex: number | null;
  status: string;
  anchoredAt: number;
}

interface ListMeta {
  total: number;
  page: number;
  limit: number;
  pages: number;
}

type AdminTab = "requests" | "verify" | "entries" | "anchors";

// ── Main component ────────────────────────────────────────────────────────────

export default function CompliancePage() {
  const [adminKey, setAdminKey] = useState("");
  const [activeTab, setActiveTab] = useState<AdminTab>("requests");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  // Export / erase form
  const [exportSubject, setExportSubject] = useState("");
  const [eraseSubject, setEraseSubject] = useState("");
  const [eraseConfirmed, setEraseConfirmed] = useState(false);
  const [operatorId, setOperatorId] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [submitMessage, setSubmitMessage] = useState<string | null>(null);

  // Requests list
  const [requests, setRequests] = useState<ComplianceRequest[]>([]);
  const [requestsMeta, setRequestsMeta] = useState<ListMeta | null>(null);
  const [requestsPage, setRequestsPage] = useState(1);

  // Verify
  const [verifyResult, setVerifyResult] = useState<VerifyResult | null>(null);
  const [verifying, setVerifying] = useState(false);

  // Audit entries
  const [auditEntries, setAuditEntries] = useState<AuditEntry[]>([]);
  const [auditMeta, setAuditMeta] = useState<ListMeta | null>(null);
  const [auditPage, setAuditPage] = useState(1);

  // Anchors
  const [anchors, setAnchors] = useState<AnchorRecord[]>([]);
  const [anchorMeta, setAnchorMeta] = useState<ListMeta | null>(null);
  const [anchorPage, setAnchorPage] = useState(1);
  const [anchoring, setAnchoring] = useState(false);

  function adminHeaders(): HeadersInit {
    return { "Content-Type": "application/json", "x-admin-key": adminKey };
  }

  async function apiFetch<T>(path: string, opts?: RequestInit): Promise<T> {
    const res = await fetch(`${API}${path}`, {
      ...opts,
      headers: { ...(opts?.headers || {}), ...adminHeaders() },
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error((data as { error?: string }).error ?? `HTTP ${res.status}`);
    return data as T;
  }

  // ── Load requests ────────────────────────────────────────────────────────────

  const loadRequests = useCallback(async () => {
    if (!adminKey) return;
    setLoading(true);
    setError(null);
    try {
      const data = await apiFetch<{ data: ComplianceRequest[]; meta: ListMeta }>(
        `/api/v1/admin/compliance/requests?page=${requestsPage}&limit=20`
      );
      setRequests(data.data);
      setRequestsMeta(data.meta);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [adminKey, requestsPage]);

  useEffect(() => {
    if (activeTab === "requests") loadRequests();
  }, [activeTab, loadRequests]);

  // ── Load audit entries ────────────────────────────────────────────────────────

  const loadAuditEntries = useCallback(async () => {
    if (!adminKey) return;
    setLoading(true);
    setError(null);
    try {
      const data = await apiFetch<{ data: AuditEntry[]; meta: ListMeta }>(
        `/api/v1/admin/audit/entries?page=${auditPage}&limit=50`
      );
      setAuditEntries(data.data);
      setAuditMeta(data.meta);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [adminKey, auditPage]);

  useEffect(() => {
    if (activeTab === "entries") loadAuditEntries();
  }, [activeTab, loadAuditEntries]);

  // ── Load anchors ──────────────────────────────────────────────────────────────

  const loadAnchors = useCallback(async () => {
    if (!adminKey) return;
    setLoading(true);
    setError(null);
    try {
      const data = await apiFetch<{ data: AnchorRecord[]; meta: ListMeta }>(
        `/api/v1/admin/audit/anchors?page=${anchorPage}&limit=20`
      );
      setAnchors(data.data);
      setAnchorMeta(data.meta);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [adminKey, anchorPage]);

  useEffect(() => {
    if (activeTab === "anchors") loadAnchors();
  }, [activeTab, loadAnchors]);

  // ── Submit export ─────────────────────────────────────────────────────────────

  async function handleExport() {
    if (!exportSubject.trim() || !operatorId.trim()) return;
    setSubmitting(true);
    setSubmitMessage(null);
    setError(null);
    try {
      const data = await apiFetch<{ message: string; request: ComplianceRequest }>(
        "/api/v1/admin/compliance/export",
        {
          method: "POST",
          body: JSON.stringify({ subjectId: exportSubject.trim(), requestedBy: operatorId.trim() }),
        }
      );
      setSubmitMessage(data.message);
      setExportSubject("");
      loadRequests();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSubmitting(false);
    }
  }

  // ── Submit erasure ────────────────────────────────────────────────────────────

  async function handleErase() {
    if (!eraseSubject.trim() || !operatorId.trim() || !eraseConfirmed) return;
    setSubmitting(true);
    setSubmitMessage(null);
    setError(null);
    try {
      const data = await apiFetch<{ message: string; request: ComplianceRequest }>(
        "/api/v1/admin/compliance/erase",
        {
          method: "POST",
          body: JSON.stringify({
            subjectId: eraseSubject.trim(),
            requestedBy: operatorId.trim(),
            confirmed: "true",
          }),
        }
      );
      setSubmitMessage(data.message);
      setEraseSubject("");
      setEraseConfirmed(false);
      loadRequests();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSubmitting(false);
    }
  }

  // ── Chain verify ──────────────────────────────────────────────────────────────

  async function handleVerify() {
    if (!adminKey) return;
    setVerifying(true);
    setVerifyResult(null);
    setError(null);
    try {
      const result = await apiFetch<VerifyResult>("/api/v1/admin/audit/verify");
      setVerifyResult(result);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setVerifying(false);
    }
  }

  // ── On-demand anchor ──────────────────────────────────────────────────────────

  async function handleAnchorNow() {
    if (!adminKey) return;
    setAnchoring(true);
    setError(null);
    try {
      await apiFetch("/api/v1/admin/audit/anchor", { method: "POST" });
      await loadAnchors();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setAnchoring(false);
    }
  }

  // ── Download export bundle ────────────────────────────────────────────────────

  async function handleDownload(req: ComplianceRequest) {
    if (!req.downloadToken) return;
    const url = `${API}/api/v1/admin/compliance/requests/${req.id}/download?token=${req.downloadToken}`;
    try {
      const res = await fetch(url, { headers: adminHeaders() });
      if (!res.ok) { setError("Download failed"); return; }
      const blob = await res.blob();
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `compliance_export_${req.subjectId}_${req.id}.json`;
      a.click();
      URL.revokeObjectURL(a.href);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  function fmt(ts: number | string | null) {
    if (!ts) return "—";
    return new Date(typeof ts === "string" ? ts : ts).toLocaleString();
  }

  function truncate(s: string, n = 20) {
    return s.length > n ? s.slice(0, n) + "…" : s;
  }

  // ── Auth gate ─────────────────────────────────────────────────────────────────

  if (!adminKey) {
    return (
      <main className="min-h-screen bg-black text-white pt-12 px-6">
        <div className="max-w-lg mx-auto py-24 text-center">
          <p className="text-sm font-mono text-purple-400 tracking-widest uppercase mb-4">
            Admin Access Required
          </p>
          <h1 className="text-3xl font-bold mb-6">Compliance &amp; Audit</h1>
          <input
            type="password"
            placeholder="Enter admin API key"
            value={adminKey}
            onChange={(e) => setAdminKey(e.target.value)}
            className="w-full px-4 py-3 bg-zinc-900 border border-zinc-700 rounded-lg
                       font-mono text-sm focus:outline-none focus:border-purple-500"
          />
          <p className="text-xs text-zinc-500 mt-3">
            The key is sent as the <code className="text-zinc-400">x-admin-key</code> header.
          </p>
        </div>
      </main>
    );
  }

  // ── Main UI ────────────────────────────────────────────────────────────────────

  return (
    <main className="min-h-screen bg-black text-white pt-12 px-6 pb-16">
      <div className="max-w-7xl mx-auto">

        {/* Header */}
        <div className="mb-8 pb-6 border-b border-zinc-800 flex items-center justify-between">
          <div>
            <p className="text-sm font-mono text-purple-400 tracking-widest uppercase mb-1">Admin</p>
            <h1 className="text-3xl font-bold">Compliance &amp; Audit</h1>
          </div>
          <button
            onClick={() => setAdminKey("")}
            className="text-xs text-zinc-500 hover:text-red-400"
          >
            Clear key
          </button>
        </div>

        {error && (
          <div className="mb-6 px-4 py-3 bg-red-500/10 border border-red-500/30 rounded-lg text-red-400 text-sm">
            {error}
          </div>
        )}

        {submitMessage && (
          <div className="mb-6 px-4 py-3 bg-green-500/10 border border-green-500/30 rounded-lg text-green-400 text-sm">
            {submitMessage}
          </div>
        )}

        {/* Tabs */}
        <div className="flex gap-4 mb-8 border-b border-zinc-800">
          {(["requests", "verify", "entries", "anchors"] as const).map((tab) => (
            <button
              key={tab}
              onClick={() => { setActiveTab(tab); setError(null); }}
              className={`px-4 py-3 text-sm font-semibold border-b-2 transition-colors capitalize ${
                activeTab === tab
                  ? "border-purple-500 text-white"
                  : "border-transparent text-zinc-400 hover:text-white"
              }`}
            >
              {tab === "requests" ? "Request Queue" :
               tab === "verify" ? "Chain Verify" :
               tab === "entries" ? "Audit Log" : "Anchors"}
            </button>
          ))}
        </div>

        {/* ── Request Queue tab ─────────────────────────────────────────────── */}
        {activeTab === "requests" && (
          <div className="space-y-8">

            {/* New Export form */}
            <section className="p-6 bg-zinc-900 border border-zinc-800 rounded-lg">
              <h2 className="text-lg font-semibold mb-4">New Export Request</h2>
              <p className="text-xs text-zinc-500 mb-4">
                Collects all data associated with a subject identifier (Stellar public key or agent id)
                across agents, assets, licenses, streams, reports, and the audit log.
              </p>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4">
                <div>
                  <label className="block text-xs text-zinc-400 mb-1">Subject ID</label>
                  <input
                    value={exportSubject}
                    onChange={(e) => setExportSubject(e.target.value)}
                    placeholder="GXXX... or agent ID"
                    className="w-full px-3 py-2 bg-zinc-800 border border-zinc-700 rounded
                               text-sm font-mono focus:outline-none focus:border-purple-500"
                  />
                </div>
                <div>
                  <label className="block text-xs text-zinc-400 mb-1">Operator ID</label>
                  <input
                    value={operatorId}
                    onChange={(e) => setOperatorId(e.target.value)}
                    placeholder="Your operator identifier"
                    className="w-full px-3 py-2 bg-zinc-800 border border-zinc-700 rounded
                               text-sm focus:outline-none focus:border-purple-500"
                  />
                </div>
              </div>
              <button
                onClick={handleExport}
                disabled={submitting || !exportSubject.trim() || !operatorId.trim()}
                className="px-5 py-2 bg-purple-600 hover:bg-purple-700 disabled:opacity-50
                           rounded text-sm font-semibold transition-colors"
              >
                {submitting ? "Submitting…" : "Request Export"}
              </button>
            </section>

            {/* Erasure form */}
            <section className="p-6 bg-zinc-900 border border-amber-700/40 rounded-lg">
              <h2 className="text-lg font-semibold mb-1 text-amber-400">Erasure Request</h2>
              <p className="text-xs text-zinc-500 mb-4">
                Pseudonymises PII fields for a subject. This action is partially irreversible — read the constraints below before proceeding.
              </p>

              {/* Immutability warning */}
              <div className="mb-5 p-4 bg-amber-500/5 border border-amber-700/50 rounded-lg text-xs space-y-2">
                <p className="font-semibold text-amber-300 mb-2">⚠ What erasure does and does not remove</p>
                <div>
                  <p className="text-amber-400 font-semibold mb-1">Cannot be erased (immutable by design):</p>
                  <ul className="list-disc list-inside space-y-0.5 text-zinc-400">
                    <li>On-chain Stellar transactions — permanent on the network</li>
                    <li>events_log — raw on-chain event records</li>
                    <li>merkle_anchors — on-chain Merkle commitments</li>
                    <li>Audit log entry_hash / prev_hash / seq — preserved to maintain chain integrity</li>
                  </ul>
                </div>
                <div>
                  <p className="text-green-400 font-semibold mb-1">Will be pseudonymised (off-chain):</p>
                  <ul className="list-disc list-inside space-y-0.5 text-zinc-400">
                    <li>agents.owner, assets.owner, licenses.buyer</li>
                    <li>streams.sender / recipient</li>
                    <li>reports.reporter</li>
                    <li>admin_actions.operator + args/result payload content</li>
                    <li>audit_log.actor + subject_id + payload content</li>
                  </ul>
                </div>
                <p className="text-zinc-500">
                  Each original value is replaced with a stable{" "}
                  <code className="text-zinc-400">PSEUDONYM_&#8203;&lt;hash&gt;</code> token.
                  The same original value always maps to the same token.
                  Pseudonymisation is idempotent — repeating the request makes no additional changes.
                  <br />
                  <strong className="text-zinc-300">
                    The audit log hash chain will no longer verify the pseudonymised payload content, but
                    the structural ordering (seq continuity and prev_hash linkage) remains valid.
                    On-chain Merkle anchors continue to prove the log was intact at anchor time.
                  </strong>
                </p>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4">
                <div>
                  <label className="block text-xs text-zinc-400 mb-1">Subject ID</label>
                  <input
                    value={eraseSubject}
                    onChange={(e) => setEraseSubject(e.target.value)}
                    placeholder="GXXX... or agent ID"
                    className="w-full px-3 py-2 bg-zinc-800 border border-zinc-700 rounded
                               text-sm font-mono focus:outline-none focus:border-amber-600"
                  />
                </div>
                <div>
                  <label className="block text-xs text-zinc-400 mb-1">Operator ID</label>
                  <input
                    value={operatorId}
                    onChange={(e) => setOperatorId(e.target.value)}
                    placeholder="Your operator identifier"
                    className="w-full px-3 py-2 bg-zinc-800 border border-zinc-700 rounded
                               text-sm focus:outline-none focus:border-purple-500"
                  />
                </div>
              </div>
              <label className="flex items-start gap-2 mb-4 cursor-pointer">
                <input
                  type="checkbox"
                  checked={eraseConfirmed}
                  onChange={(e) => setEraseConfirmed(e.target.checked)}
                  className="mt-0.5"
                />
                <span className="text-xs text-zinc-300">
                  I have read the constraints above. I understand that on-chain data cannot be erased,
                  that the audit log hash chain will show payload mismatches after pseudonymisation,
                  and that this action is intended to honour a data-subject erasure request to the
                  maximum extent possible given the immutability constraints.
                </span>
              </label>
              <button
                onClick={handleErase}
                disabled={submitting || !eraseSubject.trim() || !operatorId.trim() || !eraseConfirmed}
                className="px-5 py-2 bg-amber-600 hover:bg-amber-700 disabled:opacity-40
                           rounded text-sm font-semibold transition-colors"
              >
                {submitting ? "Submitting…" : "Request Erasure"}
              </button>
            </section>

            {/* Request list */}
            <section>
              <div className="flex items-center justify-between mb-4">
                <h2 className="text-lg font-semibold">
                  Request Queue
                  {requestsMeta && <span className="text-zinc-500 font-normal text-sm ml-2">({requestsMeta.total} total)</span>}
                </h2>
                <button onClick={loadRequests} className="text-xs text-purple-400 hover:text-purple-300">
                  Refresh
                </button>
              </div>

              {loading ? (
                <p className="text-zinc-500 text-sm">Loading…</p>
              ) : requests.length === 0 ? (
                <p className="text-zinc-500 text-sm">No requests yet.</p>
              ) : (
                <div className="space-y-3">
                  {requests.map((req) => (
                    <div
                      key={req.id}
                      className="p-4 bg-zinc-900 border border-zinc-800 rounded-lg flex items-center justify-between gap-4"
                    >
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 mb-1">
                          <span className={`px-2 py-0.5 text-xs rounded-full font-semibold ${
                            req.requestType === "export"
                              ? "bg-blue-500/10 text-blue-400"
                              : "bg-amber-500/10 text-amber-400"
                          }`}>
                            {req.requestType}
                          </span>
                          <StatusBadge status={req.status} />
                          <span className="text-xs text-zinc-500">#{req.id}</span>
                        </div>
                        <p className="text-sm font-mono text-zinc-300 truncate">{req.subjectId}</p>
                        <p className="text-xs text-zinc-500">
                          by {req.requestedBy} · {fmt(req.createdAt)}
                        </p>
                        {req.errorMessage && (
                          <p className="text-xs text-red-400 mt-1">{req.errorMessage}</p>
                        )}
                        {req.resultSummary && (
                          <p className="text-xs text-zinc-500 mt-1">
                            {(req.resultSummary as { total_records?: number }).total_records ?? "?"} records
                          </p>
                        )}
                      </div>
                      {req.status === "completed" && req.requestType === "export" && req.downloadToken && (
                        <button
                          onClick={() => handleDownload(req)}
                          className="px-3 py-1.5 text-xs font-semibold bg-purple-600/20 text-purple-400
                                     hover:bg-purple-600/40 rounded transition-colors whitespace-nowrap"
                        >
                          Download JSON
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              )}

              {requestsMeta && requestsMeta.pages > 1 && (
                <div className="flex gap-2 mt-4">
                  <button
                    disabled={requestsPage <= 1}
                    onClick={() => setRequestsPage((p) => p - 1)}
                    className="px-3 py-1 text-xs bg-zinc-800 rounded disabled:opacity-40"
                  >
                    Prev
                  </button>
                  <span className="px-3 py-1 text-xs text-zinc-500">
                    {requestsPage} / {requestsMeta.pages}
                  </span>
                  <button
                    disabled={requestsPage >= requestsMeta.pages}
                    onClick={() => setRequestsPage((p) => p + 1)}
                    className="px-3 py-1 text-xs bg-zinc-800 rounded disabled:opacity-40"
                  >
                    Next
                  </button>
                </div>
              )}
            </section>
          </div>
        )}

        {/* ── Chain verify tab ──────────────────────────────────────────────── */}
        {activeTab === "verify" && (
          <div className="space-y-6">
            <section className="p-6 bg-zinc-900 border border-zinc-800 rounded-lg">
              <h2 className="text-lg font-semibold mb-2">Audit Chain Verification</h2>
              <p className="text-xs text-zinc-500 mb-4">
                Walks the entire audit log and recomputes every entry_hash. Detects any
                retroactive modification and reports the exact first broken seq.
              </p>
              <button
                onClick={handleVerify}
                disabled={verifying}
                className="px-5 py-2 bg-purple-600 hover:bg-purple-700 disabled:opacity-50
                           rounded text-sm font-semibold transition-colors"
              >
                {verifying ? "Verifying…" : "Run Chain Verifier"}
              </button>
            </section>

            {verifyResult && (
              <section className={`p-6 border rounded-lg ${
                verifyResult.valid
                  ? "bg-green-500/5 border-green-700/40"
                  : "bg-red-500/5 border-red-700/40"
              }`}>
                <div className="flex items-center gap-3 mb-4">
                  <span className={`text-2xl ${verifyResult.valid ? "text-green-400" : "text-red-400"}`}>
                    {verifyResult.valid ? "✓" : "✗"}
                  </span>
                  <div>
                    <p className={`font-semibold ${verifyResult.valid ? "text-green-300" : "text-red-300"}`}>
                      {verifyResult.valid ? "Chain Intact" : "Chain Tampered"}
                    </p>
                    <p className="text-xs text-zinc-500">
                      {verifyResult.checkedCount} entries verified in {verifyResult.durationMs}ms
                    </p>
                  </div>
                </div>
                {!verifyResult.valid && (
                  <div className="text-sm space-y-1">
                    <p className="text-red-400">
                      First broken link at <strong>seq {verifyResult.brokenAt}</strong>
                    </p>
                    <p className="text-zinc-400">{verifyResult.reason}</p>
                  </div>
                )}
              </section>
            )}
          </div>
        )}

        {/* ── Audit log entries tab ─────────────────────────────────────────── */}
        {activeTab === "entries" && (
          <div>
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-lg font-semibold">
                Audit Log Entries
                {auditMeta && <span className="text-zinc-500 font-normal text-sm ml-2">({auditMeta.total} total)</span>}
              </h2>
              <button onClick={loadAuditEntries} className="text-xs text-purple-400 hover:text-purple-300">
                Refresh
              </button>
            </div>
            {loading ? (
              <p className="text-zinc-500 text-sm">Loading…</p>
            ) : auditEntries.length === 0 ? (
              <p className="text-zinc-500 text-sm">No entries yet.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-xs text-left">
                  <thead>
                    <tr className="border-b border-zinc-800 text-zinc-500">
                      <th className="pb-2 pr-4">Seq</th>
                      <th className="pb-2 pr-4">Event Type</th>
                      <th className="pb-2 pr-4">Actor</th>
                      <th className="pb-2 pr-4">Subject</th>
                      <th className="pb-2 pr-4">Hash (trunc)</th>
                      <th className="pb-2">Created</th>
                    </tr>
                  </thead>
                  <tbody>
                    {auditEntries.map((e) => (
                      <tr key={e.id} className="border-b border-zinc-900 hover:bg-zinc-900/50">
                        <td className="py-2 pr-4 font-mono text-purple-400">{e.seq}</td>
                        <td className="py-2 pr-4 text-zinc-300">{e.eventType}</td>
                        <td className="py-2 pr-4 font-mono text-zinc-400">{truncate(e.actor, 24)}</td>
                        <td className="py-2 pr-4 font-mono text-zinc-500">{e.subjectId ? truncate(e.subjectId, 18) : "—"}</td>
                        <td className="py-2 pr-4 font-mono text-zinc-600">{e.entryHash.slice(0, 12)}…</td>
                        <td className="py-2 text-zinc-500">{fmt(e.createdAt)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {auditMeta && auditMeta.pages > 1 && (
              <div className="flex gap-2 mt-4">
                <button disabled={auditPage <= 1} onClick={() => setAuditPage((p) => p - 1)}
                  className="px-3 py-1 text-xs bg-zinc-800 rounded disabled:opacity-40">Prev</button>
                <span className="px-3 py-1 text-xs text-zinc-500">{auditPage} / {auditMeta.pages}</span>
                <button disabled={auditPage >= auditMeta.pages} onClick={() => setAuditPage((p) => p + 1)}
                  className="px-3 py-1 text-xs bg-zinc-800 rounded disabled:opacity-40">Next</button>
              </div>
            )}
          </div>
        )}

        {/* ── Anchors tab ───────────────────────────────────────────────────── */}
        {activeTab === "anchors" && (
          <div>
            <div className="flex items-center justify-between mb-6">
              <div>
                <h2 className="text-lg font-semibold">
                  Merkle Anchors
                  {anchorMeta && <span className="text-zinc-500 font-normal text-sm ml-2">({anchorMeta.total} total)</span>}
                </h2>
                <p className="text-xs text-zinc-500 mt-0.5">
                  Periodic Merkle roots committed on-chain. Each root independently proves the
                  integrity of the covered audit log segment.
                </p>
              </div>
              <div className="flex gap-2">
                <button onClick={loadAnchors} className="text-xs text-purple-400 hover:text-purple-300">
                  Refresh
                </button>
                <button
                  onClick={handleAnchorNow}
                  disabled={anchoring}
                  className="px-3 py-1.5 text-xs font-semibold bg-purple-600/20 text-purple-400
                             hover:bg-purple-600/40 rounded transition-colors disabled:opacity-50"
                >
                  {anchoring ? "Anchoring…" : "Anchor Now"}
                </button>
              </div>
            </div>

            {loading ? (
              <p className="text-zinc-500 text-sm">Loading…</p>
            ) : anchors.length === 0 ? (
              <p className="text-zinc-500 text-sm">No anchors yet. Click "Anchor Now" to create one.</p>
            ) : (
              <div className="space-y-3">
                {anchors.map((a) => (
                  <div key={a.id} className="p-4 bg-zinc-900 border border-zinc-800 rounded-lg">
                    <div className="flex items-center justify-between mb-2">
                      <div className="flex items-center gap-2">
                        <span className="text-xs font-mono text-purple-400">Anchor #{a.id}</span>
                        <AnchorStatusBadge status={a.status} />
                      </div>
                      <span className="text-xs text-zinc-500">{fmt(a.anchoredAt)}</span>
                    </div>
                    <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-xs">
                      <div>
                        <p className="text-zinc-500">Seq Range</p>
                        <p className="font-mono text-zinc-300">{a.fromSeq}–{a.toSeq}</p>
                      </div>
                      <div>
                        <p className="text-zinc-500">Entries</p>
                        <p className="text-zinc-300">{a.entryCount}</p>
                      </div>
                      <div className="col-span-2">
                        <p className="text-zinc-500">Merkle Root</p>
                        <p className="font-mono text-zinc-400 truncate">{a.merkleRoot}</p>
                      </div>
                    </div>
                    {a.onChainTx && (
                      <p className="mt-2 text-xs font-mono text-zinc-600 truncate">
                        tx: {a.onChainTx}
                      </p>
                    )}
                  </div>
                ))}
              </div>
            )}

            {anchorMeta && anchorMeta.pages > 1 && (
              <div className="flex gap-2 mt-4">
                <button disabled={anchorPage <= 1} onClick={() => setAnchorPage((p) => p - 1)}
                  className="px-3 py-1 text-xs bg-zinc-800 rounded disabled:opacity-40">Prev</button>
                <span className="px-3 py-1 text-xs text-zinc-500">{anchorPage} / {anchorMeta.pages}</span>
                <button disabled={anchorPage >= anchorMeta.pages} onClick={() => setAnchorPage((p) => p + 1)}
                  className="px-3 py-1 text-xs bg-zinc-800 rounded disabled:opacity-40">Next</button>
              </div>
            )}
          </div>
        )}
      </div>
    </main>
  );
}

// ── Sub-components ────────────────────────────────────────────────────────────

function StatusBadge({ status }: { status: string }) {
  const cls: Record<string, string> = {
    pending:    "bg-zinc-700/50 text-zinc-400",
    processing: "bg-yellow-500/10 text-yellow-400",
    completed:  "bg-green-500/10 text-green-400",
    failed:     "bg-red-500/10 text-red-400",
  };
  return (
    <span className={`px-2 py-0.5 text-xs rounded-full font-semibold ${cls[status] ?? cls.pending}`}>
      {status}
    </span>
  );
}

function AnchorStatusBadge({ status }: { status: string }) {
  const cls: Record<string, string> = {
    pending:   "bg-zinc-700/50 text-zinc-400",
    submitted: "bg-yellow-500/10 text-yellow-400",
    confirmed: "bg-green-500/10 text-green-400",
    failed:    "bg-red-500/10 text-red-400",
  };
  return (
    <span className={`px-2 py-0.5 text-xs rounded-full font-semibold ${cls[status] ?? cls.pending}`}>
      {status}
    </span>
  );
}
