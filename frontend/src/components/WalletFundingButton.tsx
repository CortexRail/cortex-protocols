"use client";

import { useState } from "react";

interface WalletFundingButtonProps {
  publicKey: string;
  network: string;
  balanceXLM: number;
  onFunded: () => void;
}

type FundingStatus = "idle" | "loading" | "success" | "error";

/**
 * Shown on the wallet/balance view so new developers can fund a Testnet
 * account without leaving the app. Only renders when the connected wallet
 * is on Testnet and currently holds 0 XLM.
 */
export default function WalletFundingButton({
  publicKey,
  network,
  balanceXLM,
  onFunded,
}: WalletFundingButtonProps) {
  const [status, setStatus] = useState<FundingStatus>("idle");
  const [error, setError] = useState<string | null>(null);

  if (network !== "testnet" || balanceXLM !== 0 || !publicKey) {
    return null;
  }

  async function handleFund() {
    setStatus("loading");
    setError(null);

    try {
      const res = await fetch("http://localhost:4000/api/v1/stellar/fund", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ publicKey }),
      });

      const data = await res.json().catch(() => ({}));

      if (!res.ok) {
        setStatus("error");
        setError(data.error || "Funding request failed.");
        return;
      }

      setStatus("success");
      onFunded();
    } catch {
      setStatus("error");
      setError("Unable to reach the funding service. Please try again.");
    }
  }

  return (
    <div className="space-y-2">
      <button
        onClick={handleFund}
        disabled={status === "loading"}
        className="px-4 py-2 bg-purple-600 hover:bg-purple-700 disabled:opacity-50 disabled:cursor-not-allowed rounded-lg text-sm font-semibold transition-colors"
      >
        {status === "loading" ? "Funding…" : "Fund with Testnet XLM"}
      </button>

      {status === "success" && (
        <p className="text-sm text-green-400">
          Account funded! Refreshing balance…
        </p>
      )}

      {status === "error" && error && (
        <p className="text-sm text-red-400">{error}</p>
      )}
    </div>
  );
}
