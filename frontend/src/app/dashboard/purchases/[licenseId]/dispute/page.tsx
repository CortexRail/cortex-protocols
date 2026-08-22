"use client";

import { use, useEffect, useState } from "react";
import Link from "next/link";
import EscrowStatusBadge, { EscrowStatusType } from "@/components/marketplace/EscrowStatusBadge";

interface PageProps {
  params: Promise<{
    licenseId: string;
  }>;
}

export default function DisputeFilingPage({ params }: PageProps) {
  const { licenseId } = use(params);

  const [buyerAddress, setBuyerAddress] = useState("");
  const [evidenceText, setEvidenceText] = useState("");
  const [computedHash, setComputedHash] = useState("");
  const [loading, setLoading] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [disputeId, setDisputeId] = useState<number | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  // Mock escrow countdown data
  const [escrowStatus] = useState<EscrowStatusType>("Held");
  const [currentLedger, setCurrentLedger] = useState(12450);
  const holdUntilLedger = 12550;

  // Ledger countdown ticker
  useEffect(() => {
    const timer = setInterval(() => {
      setCurrentLedger((prev) => prev + 1);
    }, 5000);
    return () => clearInterval(timer);
  }, []);

  // Real-time SHA-256 evidence hashing in browser
  useEffect(() => {
    let active = true;

    async function hash() {
      if (!evidenceText.trim()) {
        if (active) setComputedHash("");
        return;
      }
      const encoder = new TextEncoder();
      const data = encoder.encode(evidenceText);
      const hashBuffer = await crypto.subtle.digest("SHA-256", data);
      if (!active) return;
      const hashArray = Array.from(new Uint8Array(hashBuffer));
      const hashHex = hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
      setComputedHash(hashHex);
    }

    hash();
    return () => { active = false; };
  }, [evidenceText]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!buyerAddress.trim() || buyerAddress.length !== 56) {
      setErrorMessage("Enter a valid 56-character Stellar buyer address.");
      return;
    }
    if (!evidenceText.trim() || evidenceText.length < 10) {
      setErrorMessage("Please provide detailed evidence describing the issue (min 10 chars).");
      return;
    }

    setLoading(true);
    setErrorMessage(null);

    try {
      const response = await fetch("/api/v1/disputes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          licenseId: Number(licenseId),
          buyer: buyerAddress.trim(),
          evidenceText: evidenceText.trim(),
        }),
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.error || errorData.message || "Failed to file dispute.");
      }

      const data = await response.json();
      setDisputeId(data.dispute?.disputeId || 1);
      setSubmitted(true);
    } catch (err: unknown) {
      setErrorMessage(err instanceof Error ? err.message : "Failed to file dispute on-chain.");
    } finally {
      setLoading(false);
    }
  }

  const remainingLedgers = Math.max(0, holdUntilLedger - currentLedger);
  const estimatedMinutes = Math.ceil((remainingLedgers * 5) / 60);

  return (
    <div className="max-w-4xl mx-auto px-4 py-8">
      <div className="mb-6">
        <Link
          href="/dashboard"
          className="text-sm text-neutral-400 hover:text-neutral-200 transition-colors"
        >
          ← Back to Dashboard
        </Link>
      </div>

      <div className="bg-neutral-900 border border-neutral-800 rounded-xl p-6 mb-8 shadow-xl">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-neutral-800 pb-6 mb-6">
          <div>
            <h1 className="text-2xl font-bold text-neutral-100">
              File Purchase Dispute — License #{licenseId}
            </h1>
            <p className="text-sm text-neutral-400 mt-1">
              Escrow-backed dispute arbitration. Freezes funds held in smart contract until resolved.
            </p>
          </div>
          <EscrowStatusBadge
            status={submitted ? "Disputed" : escrowStatus}
            holdUntilLedger={holdUntilLedger}
            currentLedger={currentLedger}
          />
        </div>

        {/* Hold Period Countdown Banner */}
        <div className="bg-amber-950/40 border border-amber-500/30 rounded-lg p-4 mb-6 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
          <div>
            <div className="text-xs uppercase tracking-wider font-semibold text-amber-400 mb-1">
              Escrow Hold Period Countdown
            </div>
            <div className="text-sm text-neutral-300">
              Dispute window closes at ledger block{" "}
              <span className="font-mono text-amber-300">#{holdUntilLedger}</span> (Current:{" "}
              <span className="font-mono text-neutral-400">#{currentLedger}</span>)
            </div>
          </div>
          <div className="text-right sm:border-l sm:border-amber-500/20 sm:pl-4">
            <div className="text-xl font-bold text-amber-300 font-mono">
              ~{estimatedMinutes} min remaining
            </div>
            <div className="text-xs text-neutral-400">{remainingLedgers} blocks left</div>
          </div>
        </div>

        {submitted ? (
          <div className="bg-emerald-950/40 border border-emerald-500/30 rounded-lg p-6 text-center">
            <div className="w-12 h-12 bg-emerald-500/20 text-emerald-400 rounded-full flex items-center justify-center mx-auto mb-4 text-xl">
              ✓
            </div>
            <h2 className="text-xl font-bold text-emerald-300 mb-2">Dispute Successfully Filed</h2>
            <p className="text-sm text-neutral-300 mb-4">
              Dispute ID <span className="font-mono text-emerald-400 font-bold">#{disputeId}</span>{" "}
              has been recorded on-chain. Escrow funds for license #{licenseId} are frozen pending committee review.
            </p>
            <div className="bg-neutral-950 p-4 rounded text-left font-mono text-xs text-neutral-400 break-all mb-6">
              Evidence SHA-256: {computedHash}
            </div>
            <Link
              href="/dashboard/arbitration"
              className="inline-block px-5 py-2.5 bg-neutral-800 hover:bg-neutral-700 text-neutral-100 rounded-lg font-medium transition-colors text-sm"
            >
              View Arbitration Queue →
            </Link>
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="space-y-6">
            {errorMessage && (
              <div className="bg-rose-950/50 border border-rose-500/30 text-rose-300 p-4 rounded-lg text-sm">
                {errorMessage}
              </div>
            )}

            <div>
              <label className="block text-sm font-medium text-neutral-300 mb-2">
                Buyer Stellar Address (G...)
              </label>
              <input
                type="text"
                value={buyerAddress}
                onChange={(e) => setBuyerAddress(e.target.value)}
                placeholder="G..."
                className="w-full bg-neutral-950 border border-neutral-800 rounded-lg px-4 py-2.5 text-neutral-100 font-mono text-sm focus:outline-none focus:border-amber-500"
                required
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-neutral-300 mb-2">
                Dispute Evidence & Problem Description
              </label>
              <textarea
                value={evidenceText}
                onChange={(e) => setEvidenceText(e.target.value)}
                rows={5}
                placeholder="Describe how the purchased asset is broken, misrepresented, or non-functional. Provide proof URLs, error tracebacks, or output mismatch logs."
                className="w-full bg-neutral-950 border border-neutral-800 rounded-lg px-4 py-2.5 text-neutral-100 text-sm focus:outline-none focus:border-amber-500"
                required
              />
            </div>

            {computedHash && (
              <div className="bg-neutral-950 border border-neutral-800 rounded-lg p-4">
                <div className="text-xs text-neutral-400 uppercase tracking-wider mb-1 font-semibold">
                  Calculated On-Chain Evidence Hash (SHA-256)
                </div>
                <div className="font-mono text-xs text-amber-400 break-all">{computedHash}</div>
              </div>
            )}

            <div className="flex justify-end gap-3 pt-4 border-t border-neutral-800">
              <Link
                href="/dashboard"
                className="px-4 py-2.5 bg-neutral-800 hover:bg-neutral-700 text-neutral-300 rounded-lg text-sm font-medium transition-colors"
              >
                Cancel
              </Link>
              <button
                type="submit"
                disabled={loading || remainingLedgers === 0}
                className="px-5 py-2.5 bg-rose-600 hover:bg-rose-500 disabled:opacity-50 text-white rounded-lg text-sm font-medium transition-colors"
              >
                {loading ? "Submitting Dispute..." : "Submit On-Chain Dispute"}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
