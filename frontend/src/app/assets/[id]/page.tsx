"use client";

import { useState, useEffect } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";

interface Asset {
  id: number;
  owner: string;
  name: string;
  description: string;
  assetType: string;
  licenseType: string;
  price: number;
  usageCount: number;
  isActive: boolean;
  flagged: boolean;
  tags: string[];
}

const REPORT_REASONS = [
  { value: "Spam", label: "Spam" },
  { value: "Plagiarism", label: "Plagiarism" },
  { value: "Malicious", label: "Malicious" },
  { value: "Misleading", label: "Misleading" },
  { value: "PolicyViolation", label: "Policy Violation" },
  { value: "Other", label: "Other" },
];

export default function AssetDetailPage() {
  const params = useParams();
  const assetId = params.id as string;

  const [asset, setAsset] = useState<Asset | null>(null);
  const [loading, setLoading] = useState(true);

  const [reportOpen, setReportOpen] = useState(false);
  const [reporterKey, setReporterKey] = useState("");
  const [reportReason, setReportReason] = useState("");
  const [reportDetails, setReportDetails] = useState("");
  const [reportError, setReportError] = useState<string | null>(null);
  const [reportSubmitting, setReportSubmitting] = useState(false);
  const [reportSuccess, setReportSuccess] = useState(false);

  useEffect(() => {
    fetchAsset();
  }, [assetId]);

  async function fetchAsset() {
    try {
      const res = await fetch(`http://localhost:4000/api/v1/assets/${assetId}`);
      if (res.ok) {
        setAsset(await res.json());
      }
    } catch (err) {
      console.error("Failed to fetch asset:", err);
    } finally {
      setLoading(false);
    }
  }

  function openReportModal() {
    setReporterKey("");
    setReportReason("");
    setReportDetails("");
    setReportError(null);
    setReportSuccess(false);
    setReportOpen(true);
  }

  function closeReportModal() {
    if (reportSubmitting) return;
    setReportOpen(false);
  }

  async function submitReport() {
    if (!reporterKey.trim() || !reportReason) {
      setReportError("Please enter your Stellar public key and select a reason.");
      return;
    }

    setReportSubmitting(true);
    setReportError(null);

    try {
      const res = await fetch(
        `http://localhost:4000/api/v1/assets/${assetId}/report`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            reporter: reporterKey.trim(),
            reason: reportReason,
            details: reportDetails,
          }),
        }
      );

      if (res.ok) {
        setReportSuccess(true);
        fetchAsset();
      } else {
        const body = await res.json().catch(() => ({}));
        const fieldError = body.details?.[0]?.msg;
        setReportError(fieldError || body.message || "Failed to submit report. Please try again.");
      }
    } catch {
      setReportError("Network error — please try again.");
    } finally {
      setReportSubmitting(false);
    }
  }

  if (loading || !asset) {
    return (
      <main className="min-h-screen bg-black text-white pt-12 px-6 flex items-center justify-center">
        <p className="text-zinc-400">Loading asset...</p>
      </main>
    );
  }

  return (
    <main className="min-h-screen bg-black text-white pt-12 px-6 pb-12">
      <div className="max-w-4xl mx-auto">
        {/* Header */}
        <div className="flex items-start justify-between mb-8 pb-6 border-b border-zinc-800">
          <div className="flex-1">
            <Link
              href="/"
              className="text-zinc-400 hover:text-white mb-4 inline-block text-sm"
            >
              ← Back
            </Link>

            <div className="flex items-center gap-3 mb-2">
              <h1 className="text-3xl font-bold">{asset.name}</h1>
              {asset.flagged && (
                <span className="px-2 py-1 bg-red-500/20 text-red-400 text-xs rounded-full font-semibold">
                  Flagged for review
                </span>
              )}
            </div>
            <p className="text-sm text-zinc-400 font-mono">
              {asset.owner.slice(0, 20)}...
            </p>
          </div>

          <button
            onClick={openReportModal}
            className="px-4 py-2 bg-zinc-900 border border-zinc-800 hover:border-red-500/50 hover:text-red-400 rounded-lg text-sm font-semibold transition-colors"
          >
            Report this asset
          </button>
        </div>

        {/* Stats Grid */}
        <div className="grid grid-cols-3 gap-4 mb-8">
          {[
            { label: "Price", value: `${(asset.price / 10_000_000).toLocaleString()} XLM` },
            { label: "License", value: asset.licenseType },
            { label: "Usage Count", value: asset.usageCount },
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
          <p className="text-zinc-300">{asset.description}</p>
        </div>

        {/* Tags */}
        {asset.tags.length > 0 && (
          <div className="p-6 bg-zinc-900 border border-zinc-800 rounded-lg">
            <h3 className="font-semibold mb-4">Tags</h3>
            <div className="flex flex-wrap gap-2">
              {asset.tags.map((tag) => (
                <span
                  key={tag}
                  className="px-3 py-1 bg-purple-500/20 text-purple-300 rounded-full text-sm"
                >
                  {tag}
                </span>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Report Modal */}
      {reportOpen && (
        <div
          className="fixed inset-0 bg-black/70 flex items-center justify-center px-4 z-50"
          onClick={closeReportModal}
        >
          <div
            className="w-full max-w-md bg-zinc-900 border border-zinc-800 rounded-lg p-6"
            onClick={(e) => e.stopPropagation()}
          >
            {reportSuccess ? (
              <div className="text-center py-4">
                <p className="text-lg font-semibold mb-2">Report submitted</p>
                <p className="text-sm text-zinc-400 mb-6">
                  Thanks — our moderation team will review this asset.
                </p>
                <button
                  onClick={closeReportModal}
                  className="w-full px-4 py-2 bg-purple-600 hover:bg-purple-700 rounded-lg font-semibold transition-colors"
                >
                  Close
                </button>
              </div>
            ) : (
              <>
                <h3 className="text-lg font-semibold mb-4">Report this asset</h3>

                <label className="text-sm text-zinc-400 mb-2 block">
                  Your Stellar public key
                </label>
                <input
                  type="text"
                  value={reporterKey}
                  onChange={(e) => setReporterKey(e.target.value)}
                  placeholder="G..."
                  className="w-full mb-4 px-3 py-2 bg-black border border-zinc-800 rounded-lg text-sm font-mono"
                />

                <label className="text-sm text-zinc-400 mb-2 block">Reason</label>
                <select
                  value={reportReason}
                  onChange={(e) => setReportReason(e.target.value)}
                  className="w-full mb-4 px-3 py-2 bg-black border border-zinc-800 rounded-lg text-sm"
                >
                  <option value="">Select a reason…</option>
                  {REPORT_REASONS.map((r) => (
                    <option key={r.value} value={r.value}>
                      {r.label}
                    </option>
                  ))}
                </select>

                <label className="text-sm text-zinc-400 mb-2 block">
                  Details (optional)
                </label>
                <textarea
                  value={reportDetails}
                  onChange={(e) => setReportDetails(e.target.value)}
                  rows={4}
                  maxLength={2000}
                  placeholder="Add any context that will help moderators review this asset."
                  className="w-full mb-4 px-3 py-2 bg-black border border-zinc-800 rounded-lg text-sm resize-none"
                />

                {reportError && (
                  <p className="text-sm text-red-400 mb-4">{reportError}</p>
                )}

                <div className="flex gap-3">
                  <button
                    onClick={closeReportModal}
                    disabled={reportSubmitting}
                    className="flex-1 px-4 py-2 bg-zinc-800 hover:bg-zinc-700 rounded-lg font-semibold transition-colors disabled:opacity-50"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={submitReport}
                    disabled={reportSubmitting || !reporterKey.trim() || !reportReason}
                    className="flex-1 px-4 py-2 bg-purple-600 hover:bg-purple-700 rounded-lg font-semibold transition-colors disabled:opacity-50"
                  >
                    {reportSubmitting ? "Submitting…" : "Submit report"}
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </main>
  );
}
