"use client";

import { FormEvent, useState } from "react";
import { topUpLicense, MarketplaceApiError } from "@/lib/marketplace-api";
import type { TopUpResponse } from "@/types/marketplace";
import { formatPrice } from "@/lib/formatters";

// Mirrors backend licenseService.DEFAULT_USAGE_BASED_CALLS — a top-up buys
// calls at the same effective per-call rate as the license's original
// allotment (assetPrice / DEFAULT_USAGE_BASED_CALLS). This is only used for
// the live cost *estimate* below; the actual charge is always whatever the
// server returns in the response.
const DEFAULT_USAGE_BASED_CALLS = 100;

interface TopUpModalProps {
  licenseId: number;
  buyer: string;
  assetPrice: number;
  onClose: () => void;
  onSuccess: (result: TopUpResponse) => void;
}

export default function TopUpModal({ licenseId, buyer, assetPrice, onClose, onSuccess }: TopUpModalProps) {
  const [calls, setCalls] = useState(50);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const pricePerCall = Math.ceil(assetPrice / DEFAULT_USAGE_BASED_CALLS);
  const estimatedCost = pricePerCall * Math.max(0, calls);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting || !Number.isInteger(calls) || calls < 1) return;

    setSubmitting(true);
    setError(null);
    try {
      const result = await topUpLicense(licenseId, buyer, calls);
      onSuccess(result);
    } catch (err) {
      setError(err instanceof MarketplaceApiError ? err.message : "The top-up could not be completed.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 px-4"
      onClick={submitting ? undefined : onClose}
    >
      <div
        className="w-full max-w-sm rounded-xl border border-zinc-800 bg-zinc-900 p-6"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-lg font-bold text-white">Buy more calls</h2>
        <p className="mt-1 text-sm text-zinc-400">
          Add calls to license #{licenseId} at {formatPrice(pricePerCall)} per call.
        </p>

        <form onSubmit={handleSubmit} className="mt-6 space-y-4">
          <div>
            <label htmlFor="topup-calls" className="mb-2 block text-sm font-semibold text-zinc-300">
              Calls to add
            </label>
            <input
              id="topup-calls"
              type="number"
              min={1}
              step={1}
              value={calls}
              onChange={(event) => setCalls(Number(event.target.value))}
              disabled={submitting}
              className="w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-white focus:border-purple-500 focus:outline-none disabled:opacity-50"
            />
          </div>

          <div className="rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 text-sm">
            <span className="text-zinc-500">Estimated cost </span>
            <span className="font-semibold text-white">{formatPrice(estimatedCost)}</span>
          </div>

          {error && (
            <p role="alert" className="rounded-lg border border-red-900/60 bg-red-950/30 p-3 text-sm text-red-300">
              {error}
            </p>
          )}

          <div className="flex gap-3 pt-2">
            <button
              type="button"
              onClick={onClose}
              disabled={submitting}
              className="flex-1 rounded-lg bg-zinc-800 px-4 py-2 font-semibold text-white transition-colors hover:bg-zinc-700 disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={submitting || !Number.isInteger(calls) || calls < 1}
              className="flex-1 rounded-lg bg-purple-600 px-4 py-2 font-semibold text-white transition-colors hover:bg-purple-700 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {submitting ? "Buying…" : "Confirm"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
