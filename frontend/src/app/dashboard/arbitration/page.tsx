"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import EscrowStatusBadge from "@/components/marketplace/EscrowStatusBadge";

interface QueueItem {
  disputeId: number;
  licenseId: number;
  buyer: string;
  evidenceHash: string;
  evidenceText?: string;
  status: "Open" | "Resolved";
  decision?: string;
  createdAt: number;
  escrow?: {
    seller: string;
    amount: string;
    status: "Held" | "Released" | "Disputed" | "Resolved";
  };
  votes?: Array<{
    arbitrator: string;
    vote: string;
    bps?: number;
  }>;
}

export default function ArbitrationQueuePage() {
  const [arbitratorAddress, setArbitratorAddress] = useState("");
  const [isRegistered, setIsRegistered] = useState(true);
  const [queue, setQueue] = useState<QueueItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [selectedDispute, setSelectedDispute] = useState<QueueItem | null>(null);
  const [voteChoice, setVoteChoice] = useState<"FullRefund" | "PartialRefund" | "ReleaseToSeller">("FullRefund");
  const [refundBps, setRefundBps] = useState<number>(5000);
  const [voting, setVoting] = useState(false);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);

  useEffect(() => {
    fetchQueue();
  }, []);

  async function fetchQueue() {
    setLoading(true);
    try {
      const res = await fetch("/api/v1/disputes/queue");
      if (res.ok) {
        const data = await res.json();
        setQueue(data.queue || []);
      } else {
        // Fallback mock item for demonstration
        setQueue([
          {
            disputeId: 1,
            licenseId: 101,
            buyer: "GA7Q2Q7X...BUYER",
            evidenceHash: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
            evidenceText: "Purchased reasoning chain asset #101. The asset endpoint returns 500 error and fails all validation checks.",
            status: "Open",
            createdAt: Date.now() - 3600000,
            escrow: {
              seller: "GB43K6...SELLER",
              amount: "10000000",
              status: "Disputed",
            },
            votes: [],
          },
        ]);
      }
    } catch {
      setQueue([]);
    } finally {
      setLoading(false);
    }
  }

  async function handleCastVote(e: React.FormEvent) {
    e.preventDefault();
    if (!selectedDispute || !arbitratorAddress.trim()) {
      setStatusMessage("Enter your registered arbitrator wallet address.");
      return;
    }

    setVoting(true);
    setStatusMessage(null);

    try {
      const res = await fetch(`/api/v1/disputes/${selectedDispute.disputeId}/vote`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          arbitrator: arbitratorAddress.trim(),
          vote: voteChoice,
          bps: voteChoice === "PartialRefund" ? refundBps : undefined,
        }),
      });

      if (!res.ok) {
        const errorData = await res.json().catch(() => ({}));
        throw new Error(errorData.error || errorData.message || "Failed to cast vote.");
      }

      setStatusMessage(`Vote recorded successfully for dispute #${selectedDispute.disputeId}!`);
      setSelectedDispute(null);
      fetchQueue();
    } catch (err: unknown) {
      setStatusMessage(err instanceof Error ? err.message : "Failed to submit vote on-chain.");
    } finally {
      setVoting(false);
    }
  }

  return (
    <div className="max-w-6xl mx-auto px-4 py-8">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-8">
        <div>
          <h1 className="text-3xl font-bold text-neutral-100">Arbitration Queue</h1>
          <p className="text-sm text-neutral-400 mt-1">
            Registered Arbitrator Committee portal — Review buyer evidence & vote on dispute payouts.
          </p>
        </div>
        <div className="flex items-center gap-3">
          <input
            type="text"
            value={arbitratorAddress}
            onChange={(e) => setArbitratorAddress(e.target.value)}
            placeholder="Arbitrator Address (G...)"
            className="bg-neutral-900 border border-neutral-800 rounded-lg px-3.5 py-2 text-xs font-mono text-neutral-100 focus:outline-none focus:border-amber-500 w-64"
          />
        </div>
      </div>

      {statusMessage && (
        <div className="mb-6 p-4 bg-neutral-900 border border-amber-500/40 text-amber-300 rounded-xl text-sm">
          {statusMessage}
        </div>
      )}

      {loading ? (
        <div className="text-center py-16 text-neutral-400">Loading arbitration queue...</div>
      ) : queue.length === 0 ? (
        <div className="bg-neutral-900 border border-neutral-800 rounded-xl p-12 text-center text-neutral-400">
          No open disputes requiring arbitration at this time.
        </div>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {queue.map((item) => (
            <div
              key={item.disputeId}
              className="bg-neutral-900 border border-neutral-800 rounded-xl p-6 hover:border-neutral-700 transition-colors flex flex-col justify-between"
            >
              <div>
                <div className="flex items-center justify-between mb-4">
                  <span className="text-xs font-mono font-semibold px-2.5 py-1 bg-neutral-800 text-amber-400 rounded">
                    Dispute #{item.disputeId}
                  </span>
                  <EscrowStatusBadge status={item.escrow?.status || "Disputed"} />
                </div>

                <div className="space-y-3 mb-6">
                  <div>
                    <div className="text-xs text-neutral-500 uppercase tracking-wider">License ID</div>
                    <div className="text-sm font-semibold text-neutral-200">#{item.licenseId}</div>
                  </div>
                  <div>
                    <div className="text-xs text-neutral-500 uppercase tracking-wider">Buyer</div>
                    <div className="text-xs font-mono text-neutral-300 break-all">{item.buyer}</div>
                  </div>
                  <div>
                    <div className="text-xs text-neutral-500 uppercase tracking-wider">Evidence Hash</div>
                    <div className="text-xs font-mono text-neutral-400 break-all">{item.evidenceHash}</div>
                  </div>
                  {item.evidenceText && (
                    <div>
                      <div className="text-xs text-neutral-500 uppercase tracking-wider mb-1">
                        Buyer Evidence Description
                      </div>
                      <div className="text-xs text-neutral-300 bg-neutral-950 p-3 rounded border border-neutral-850">
                        {item.evidenceText}
                      </div>
                    </div>
                  )}
                </div>
              </div>

              <div className="pt-4 border-t border-neutral-800 flex items-center justify-between">
                <span className="text-xs text-neutral-400">
                  {item.votes?.length || 0} votes cast
                </span>
                <button
                  onClick={() => setSelectedDispute(item)}
                  className="px-4 py-2 bg-amber-600 hover:bg-amber-500 text-neutral-950 font-semibold rounded-lg text-xs transition-colors"
                >
                  Review & Cast Vote
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Vote Modal */}
      {selectedDispute && (
        <div className="fixed inset-0 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4 z-50">
          <div className="bg-neutral-900 border border-neutral-800 rounded-xl p-6 max-w-lg w-full">
            <h2 className="text-xl font-bold text-neutral-100 mb-2">
              Cast Arbitrator Vote — Dispute #{selectedDispute.disputeId}
            </h2>
            <p className="text-xs text-neutral-400 mb-6">
              Majority vote across fixed committee decides exact contract payout math.
            </p>

            <form onSubmit={handleCastVote} className="space-y-5">
              <div>
                <label className="block text-xs font-medium text-neutral-300 mb-2">
                  Voting Decision
                </label>
                <div className="space-y-2">
                  {[
                    { id: "FullRefund", title: "Full Refund (100% to Buyer)", desc: "Asset non-functional or misrepresented" },
                    { id: "PartialRefund", title: "Partial Refund (Basis Points Split)", desc: "Partial functionality delivered" },
                    { id: "ReleaseToSeller", title: "Release to Seller (100% to Seller)", desc: "Asset meets described specs" },
                  ].map((option) => (
                    <label
                      key={option.id}
                      className={`flex items-start gap-3 p-3 rounded-lg border cursor-pointer transition-colors ${
                        voteChoice === option.id
                          ? "bg-amber-950/40 border-amber-500/50 text-amber-200"
                          : "bg-neutral-950 border-neutral-800 text-neutral-300 hover:border-neutral-700"
                      }`}
                    >
                      <input
                        type="radio"
                        name="vote"
                        value={option.id}
                        checked={voteChoice === option.id}
                        onChange={() =>
                          setVoteChoice(option.id as "FullRefund" | "PartialRefund" | "ReleaseToSeller")
                        }
                        className="mt-1 text-amber-500 focus:ring-amber-500"
                      />
                      <div>
                        <div className="text-xs font-semibold">{option.title}</div>
                        <div className="text-xs text-neutral-400">{option.desc}</div>
                      </div>
                    </label>
                  ))}
                </div>
              </div>

              {voteChoice === "PartialRefund" && (
                <div className="bg-neutral-950 p-4 rounded-lg border border-neutral-800">
                  <label className="block text-xs font-medium text-neutral-300 mb-1">
                    Buyer Refund Split: {(refundBps / 100).toFixed(0)}% ({refundBps} bps)
                  </label>
                  <input
                    type="range"
                    min="1"
                    max="9999"
                    step="100"
                    value={refundBps}
                    onChange={(e) => setRefundBps(Number(e.target.value))}
                    className="w-full text-amber-500"
                  />
                  <div className="flex justify-between text-xs text-neutral-400 mt-1">
                    <span>Seller: {((10000 - refundBps) / 100).toFixed(0)}%</span>
                    <span>Buyer: {(refundBps / 100).toFixed(0)}%</span>
                  </div>
                </div>
              )}

              <div className="flex justify-end gap-3 pt-4 border-t border-neutral-800">
                <button
                  type="button"
                  onClick={() => setSelectedDispute(null)}
                  className="px-4 py-2 bg-neutral-800 text-neutral-300 rounded-lg text-xs font-medium"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={voting}
                  className="px-5 py-2 bg-amber-500 hover:bg-amber-400 text-neutral-950 font-bold rounded-lg text-xs transition-colors"
                >
                  {voting ? "Submitting..." : "Confirm & Cast Vote"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
