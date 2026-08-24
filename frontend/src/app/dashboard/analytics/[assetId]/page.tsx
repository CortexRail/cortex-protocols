"use client";

import { use, useEffect, useState } from "react";
import Link from "next/link";
import {
  getAsset,
  getAssetRemainingCalls,
  getAssetRevenueBreakdown,
  getAssetTopCallers,
  getAssetUsage,
  getLicensesForBuyer,
  MarketplaceApiError,
} from "@/lib/marketplace-api";
import type {
  Asset,
  License,
  RemainingCallsResponse,
  RevenueBreakdownResponse,
  TopCaller,
  TopUpResponse,
  UsageBucket,
} from "@/types/marketplace";
import { connectWallet, FREIGHTER_INSTALL_URL, isFreighterNotInstalled, type WalletConnection } from "@/lib/freighter";
import RemainingCallsBadge from "./RemainingCallsBadge";
import TopCallersTable from "./TopCallersTable";
import CallsChart from "./CallsChart";
import BundleRevenueBreakdown from "./BundleRevenueBreakdown";
import TopUpModal from "./TopUpModal";

interface PageProps {
  params: Promise<{ assetId: string }>;
}

const USAGE_WINDOW_MS = 30 * 86_400_000; // last 30 days
const BUCKET_SECONDS = 86_400; // daily

export default function AssetAnalyticsPage({ params }: PageProps) {
  const { assetId } = use(params);

  const [asset, setAsset] = useState<Asset | null>(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [wallet, setWallet] = useState<WalletConnection | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [walletError, setWalletError] = useState<{ message: string; notInstalled: boolean } | null>(null);

  // Owner view
  const [usage, setUsage] = useState<UsageBucket[]>([]);
  const [topCallers, setTopCallers] = useState<TopCaller[]>([]);
  const [revenue, setRevenue] = useState<RevenueBreakdownResponse | null>(null);
  const [ownerRemaining, setOwnerRemaining] = useState<RemainingCallsResponse | null>(null);
  const [ownerDataError, setOwnerDataError] = useState<string | null>(null);

  // Buyer view
  const [buyerLicense, setBuyerLicense] = useState<License | null>(null);
  const [checkingBuyerLicense, setCheckingBuyerLicense] = useState(false);
  const [showTopUp, setShowTopUp] = useState(false);
  const [topUpResult, setTopUpResult] = useState<TopUpResponse | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    getAsset(assetId, controller.signal)
      .then((loadedAsset) => setAsset(loadedAsset))
      .catch((reason: unknown) => {
        if (reason instanceof DOMException && reason.name === "AbortError") return;
        if (reason instanceof MarketplaceApiError && reason.status === 404) {
          setNotFound(true);
          return;
        }
        setLoadError(reason instanceof Error ? reason.message : "Unable to load this asset");
      })
      .finally(() => setLoading(false));
    return () => controller.abort();
  }, [assetId]);

  const isOwner = !!(asset && wallet && asset.owner === wallet.address);

  // Owner analytics
  useEffect(() => {
    if (!isOwner || !asset || !wallet) return;
    const controller = new AbortController();
    const to = Date.now();
    const from = to - USAGE_WINDOW_MS;

    (async () => {
      setOwnerDataError(null);
      try {
        const [usageRes, callersRes, revenueRes, remainingRes] = await Promise.all([
          getAssetUsage(assetId, wallet.address, { from, to, bucketSeconds: BUCKET_SECONDS }, controller.signal),
          getAssetTopCallers(assetId, wallet.address, { from, to, limit: 10 }, controller.signal),
          getAssetRevenueBreakdown(assetId, wallet.address, controller.signal),
          getAssetRemainingCalls(assetId, wallet.address, controller.signal),
        ]);
        if (controller.signal.aborted) return;
        setUsage(usageRes.data);
        setTopCallers(callersRes.data);
        setRevenue(revenueRes);
        setOwnerRemaining(remainingRes);
      } catch (reason) {
        if (reason instanceof DOMException && reason.name === "AbortError") return;
        setOwnerDataError(reason instanceof Error ? reason.message : "Unable to load analytics");
      }
    })();

    return () => controller.abort();
  }, [isOwner, asset, wallet, assetId]);

  // Buyer's own license, once connected and not the owner
  useEffect(() => {
    if (!asset || !wallet || isOwner) return;
    const controller = new AbortController();

    (async () => {
      setCheckingBuyerLicense(true);
      try {
        const result = await getLicensesForBuyer(wallet.address, controller.signal);
        if (controller.signal.aborted) return;
        const found = result.data.find(
          (license) => license.assetId === asset.id && license.isActive && license.licenseType === "UsageBased"
        );
        setBuyerLicense(found ?? null);
      } catch {
        if (!controller.signal.aborted) setBuyerLicense(null);
      } finally {
        if (!controller.signal.aborted) setCheckingBuyerLicense(false);
      }
    })();

    return () => controller.abort();
  }, [asset, wallet, isOwner]);

  async function handleConnectWallet() {
    setConnecting(true);
    setWalletError(null);
    try {
      setWallet(await connectWallet());
    } catch (err) {
      setWalletError({
        notInstalled: isFreighterNotInstalled(err),
        message: err instanceof Error ? err.message : "Could not connect to Freighter. Please try again.",
      });
    } finally {
      setConnecting(false);
    }
  }

  function handleTopUpSuccess(result: TopUpResponse) {
    setTopUpResult(result);
    setBuyerLicense(result.license);
    setShowTopUp(false);
  }

  if (loading) {
    return <StatePanel message="Loading analytics…" />;
  }

  if (notFound) {
    return <StatePanel title="Asset not found" message="This asset does not exist or is no longer active." />;
  }

  if (loadError || !asset) {
    return <StatePanel title="Unable to load analytics" message={loadError || "The asset response was empty."} error />;
  }

  return (
    <main className="min-h-screen bg-black px-6 py-12 text-white">
      <div className="mx-auto max-w-5xl">
        <Link href={`/marketplace/${asset.id}`} className="mb-8 inline-block text-sm text-zinc-400 hover:text-white">
          ← Back to {asset.name}
        </Link>

        <h1 className="text-3xl font-bold tracking-tight">{asset.name} — Analytics</h1>
        <p className="mt-2 text-zinc-400">{asset.assetType}</p>

        {!wallet && (
          <div className="mt-8 rounded-xl border border-zinc-800 bg-zinc-900 p-8 text-center">
            <p className="text-zinc-400">Connect your wallet to view analytics for this asset.</p>
            <button
              type="button"
              onClick={handleConnectWallet}
              disabled={connecting}
              className="mt-4 rounded-lg bg-purple-600 px-5 py-2.5 font-semibold text-white transition-colors hover:bg-purple-700 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {connecting ? "Connecting…" : "Connect Wallet"}
            </button>
            {walletError && (
              <div role="alert" className="mx-auto mt-4 max-w-sm rounded-lg border border-red-900/60 bg-red-950/30 p-3 text-sm text-red-300">
                <p>{walletError.message}</p>
                {walletError.notInstalled && (
                  <a
                    href={FREIGHTER_INSTALL_URL}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="mt-2 inline-block font-semibold text-purple-300 hover:text-purple-200"
                  >
                    Install Freighter
                  </a>
                )}
              </div>
            )}
          </div>
        )}

        {wallet && isOwner && (
          <div className="mt-8 space-y-6">
            {ownerDataError && (
              <p role="alert" className="rounded-lg border border-red-900/60 bg-red-950/30 p-3 text-sm text-red-300">
                {ownerDataError}
              </p>
            )}

            <div className="grid gap-6 sm:grid-cols-3">
              <RemainingCallsBadge
                remaining={ownerRemaining?.totalRemaining ?? 0}
                sublabel={`Across ${ownerRemaining?.activeLicenseCount ?? 0} active usage-based ${
                  ownerRemaining?.activeLicenseCount === 1 ? "license" : "licenses"
                }`}
              />
              <div className="sm:col-span-2">
                <BundleRevenueBreakdown data={revenue?.data ?? []} totalRevenue={revenue?.totalRevenue ?? 0} />
              </div>
            </div>

            <CallsChart data={usage} bucketSeconds={BUCKET_SECONDS} />

            <div>
              <h2 className="mb-4 text-lg font-bold">Top callers (last 30 days)</h2>
              <TopCallersTable callers={topCallers} />
            </div>
          </div>
        )}

        {wallet && !isOwner && (
          <div className="mt-8">
            {checkingBuyerLicense ? (
              <p className="text-zinc-400">Checking your license…</p>
            ) : buyerLicense ? (
              <div className="max-w-sm space-y-4">
                <RemainingCallsBadge
                  remaining={buyerLicense.callsRemaining ?? 0}
                  sublabel="Your remaining calls on this license"
                />
                {topUpResult && (
                  <p role="status" className="rounded-lg border border-green-900/60 bg-green-950/30 p-3 text-sm text-green-300">
                    Added {topUpResult.callsAdded.toLocaleString()} calls for {topUpResult.amountCharged.toLocaleString()} stroops.
                  </p>
                )}
                <button
                  type="button"
                  onClick={() => setShowTopUp(true)}
                  className="w-full rounded-lg bg-purple-600 px-4 py-2.5 font-semibold text-white transition-colors hover:bg-purple-700"
                >
                  Buy more calls
                </button>
              </div>
            ) : (
              <p className="text-zinc-400">
                Analytics for this asset are visible to its owner. You don&apos;t currently hold a usage-based
                license here.
              </p>
            )}
          </div>
        )}

        {showTopUp && buyerLicense && wallet && (
          <TopUpModal
            licenseId={buyerLicense.id}
            buyer={wallet.address}
            assetPrice={asset.price}
            onClose={() => setShowTopUp(false)}
            onSuccess={handleTopUpSuccess}
          />
        )}
      </div>
    </main>
  );
}

function StatePanel({ title, message, error = false }: { title?: string; message: string; error?: boolean }) {
  return (
    <main className="flex min-h-screen items-center justify-center bg-black px-6 text-white">
      <div role={error ? "alert" : undefined} className="max-w-lg rounded-xl border border-zinc-800 bg-zinc-900 px-8 py-12 text-center">
        {title && <h1 className="text-2xl font-bold">{title}</h1>}
        <p className={`${title ? "mt-3" : ""} text-zinc-400`}>{message}</p>
        {title && (
          <Link href="/marketplace" className="mt-6 inline-block text-sm font-semibold text-purple-400 hover:text-purple-300">
            Return to marketplace
          </Link>
        )}
      </div>
    </main>
  );
}
