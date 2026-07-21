"use client";

import { useState, useEffect } from "react";
import WalletFundingButton from "@/components/WalletFundingButton";

interface Balance {
  asset_type: string;
  balance: string;
}

export default function WalletPage() {
  const [publicKeyInput, setPublicKeyInput] = useState("");
  const [publicKey, setPublicKey] = useState("");
  const [network, setNetwork] = useState("");
  const [balanceXLM, setBalanceXLM] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [notFound, setNotFound] = useState(false);

  useEffect(() => {
    fetch("http://localhost:4000/api/v1/stellar/network")
      .then((res) => res.json())
      .then((data) => setNetwork(data.network))
      .catch(() => setNetwork(""));
  }, []);

  useEffect(() => {
    if (publicKey) fetchBalance(publicKey);
  }, [publicKey]);

  async function fetchBalance(key: string) {
    if (!key) return;
    setLoading(true);
    setNotFound(false);

    try {
      const res = await fetch(`http://localhost:4000/api/v1/stellar/account/${key}`);

      if (res.status === 404) {
        // Unfunded accounts don't exist on the network yet — treat as 0 XLM.
        setNotFound(true);
        setBalanceXLM(0);
        return;
      }

      if (!res.ok) {
        setBalanceXLM(null);
        return;
      }

      const data = await res.json();
      const native = (data.balances || []).find(
        (b: Balance) => b.asset_type === "native"
      );
      setBalanceXLM(native ? parseFloat(native.balance) : 0);
    } catch {
      setBalanceXLM(null);
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="min-h-screen bg-black text-white pt-12 px-6 pb-12">
      <div className="max-w-xl mx-auto space-y-8">
        <div>
          <h1 className="text-3xl font-bold mb-2">Wallet</h1>
          <p className="text-zinc-400 text-sm">
            View your account balance and fund it on Testnet for development.
          </p>
        </div>

        <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-6 space-y-4">
          <div>
            <label className="block text-sm font-semibold mb-2">
              Stellar Public Key
            </label>
            <div className="flex gap-2">
              <input
                type="text"
                value={publicKeyInput}
                onChange={(e) => setPublicKeyInput(e.target.value)}
                placeholder="G..."
                className="flex-1 px-4 py-2 bg-zinc-800 border border-zinc-700 rounded-lg text-white placeholder-zinc-500 focus:outline-none focus:border-purple-500 text-sm"
              />
              <button
                onClick={() => setPublicKey(publicKeyInput.trim())}
                className="px-4 py-2 bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 rounded-lg text-sm font-semibold transition-colors"
              >
                Connect
              </button>
            </div>
          </div>

          {publicKey && (
            <div className="pt-4 border-t border-zinc-800 space-y-4">
              <div className="flex justify-between items-center">
                <span className="text-zinc-400 text-sm">Balance</span>
                <span className="font-semibold">
                  {loading
                    ? "Loading…"
                    : balanceXLM !== null
                    ? `${balanceXLM} XLM`
                    : "Unable to load balance"}
                </span>
              </div>

              {notFound && (
                <p className="text-xs text-zinc-500">
                  This account doesn&apos;t exist on the network yet — fund it
                  to activate it.
                </p>
              )}

              {balanceXLM !== null && (
                <WalletFundingButton
                  publicKey={publicKey}
                  network={network}
                  balanceXLM={balanceXLM}
                  onFunded={() => fetchBalance(publicKey)}
                />
              )}
            </div>
          )}
        </div>
      </div>
    </main>
  );
}
