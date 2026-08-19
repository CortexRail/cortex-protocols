"use client";

import { useState } from "react";

import {
  connectWallet,
  isFreighterNotInstalled,
  FREIGHTER_INSTALL_URL,
  truncateAddress,
  type WalletConnection,
} from "@/lib/freighter";
import { networkLabel } from "@/lib/constants";

interface WalletError {
  message: string;
  notInstalled: boolean;
}

/**
 * Header wallet control. Connects to a Freighter account, shows the truncated
 * address once connected, and offers a guided install link when the Freighter
 * extension is missing.
 */
export default function ConnectWalletButton() {
  const [wallet, setWallet] = useState<WalletConnection | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<WalletError | null>(null);

  async function handleConnect() {
    setConnecting(true);
    setError(null);
    try {
      setWallet(await connectWallet());
    } catch (err) {
      const notInstalled = isFreighterNotInstalled(err);
      setError({
        notInstalled,
        message: notInstalled
          ? "Freighter wallet was not detected. Install the Freighter browser extension to connect."
          : err instanceof Error
            ? err.message
            : "Could not connect to Freighter. Please try again.",
      });
    } finally {
      setConnecting(false);
    }
  }

  function handleDisconnect() {
    setWallet(null);
    setError(null);
  }

  return (
    <div className="relative">
      {wallet ? (
        <div className="flex items-center gap-3">
          <span className="inline-flex items-center gap-2 rounded-full border border-[var(--border)] px-3 py-1.5 text-sm">
            <span className="font-mono text-[var(--foreground)]">
              {truncateAddress(wallet.address)}
            </span>
            <span className="text-xs text-[var(--muted)]">
              {networkLabel(wallet.network)}
            </span>
          </span>
          <button
            onClick={handleDisconnect}
            className="text-sm text-[var(--muted)] transition-colors hover:text-red-400"
          >
            Disconnect
          </button>
        </div>
      ) : (
        <button
          onClick={handleConnect}
          disabled={connecting}
          className="rounded-lg bg-purple-600 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-purple-700 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {connecting ? "Connecting…" : "Connect Wallet"}
        </button>
      )}

      {error && (
        <div
          role="alert"
          className="absolute right-0 top-full z-50 mt-2 w-72 rounded-lg border border-[var(--border)] bg-[var(--background)] p-4 text-sm text-[var(--foreground)] shadow-xl"
        >
          <p>{error.message}</p>
          {error.notInstalled && (
            <a
              href={FREIGHTER_INSTALL_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="mt-2 inline-block font-semibold text-purple-400 hover:text-purple-300"
            >
              Install Freighter
            </a>
          )}
        </div>
      )}
    </div>
  );
}