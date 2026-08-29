"use client";

import Link from "next/link";
import { FormEvent, useEffect, useRef, useState } from "react";
import {
  getAsset,
  getAssets,
  getLicensesForBuyer,
  isBuyerAddress,
  MarketplaceApiError,
  purchaseAssetVersion,
} from "@/lib/marketplace-api";
import type { Asset, License, PurchaseResponse } from "@/types/marketplace";
import {
  connectWallet,
  FREIGHTER_INSTALL_URL,
  isFreighterNotInstalled,
  truncateAddress as truncateWalletAddress,
  type WalletConnection,
} from "@/lib/freighter";
import { formatPrice, truncateAddress } from "@/lib/formatters";

const RELATED_ASSET_LIMIT = 4;

function normalizeVersions(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value)]
    .filter((version): version is number => Number.isInteger(version) && version >= 1)
    .sort((left, right) => left - right);
}

export default function AssetDetail({ assetId }: { assetId: string }) {
  const [asset, setAsset] = useState<Asset | null>(null);
  const [versions, setVersions] = useState<number[]>([]);
  const [selectedVersion, setSelectedVersion] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [relatedAssets, setRelatedAssets] = useState<Asset[]>([]);

  const [wallet, setWallet] = useState<WalletConnection | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [walletError, setWalletError] = useState<{ message: string; notInstalled: boolean } | null>(null);

  const [existingLicense, setExistingLicense] = useState<License | null>(null);

  const [purchaseError, setPurchaseError] = useState<string | null>(null);
  const [purchase, setPurchase] = useState<PurchaseResponse | null>(null);
  const [pending, setPending] = useState(false);
  const pendingRef = useRef(false);

  useEffect(() => {
    const controller = new AbortController();

    getAsset(assetId, controller.signal)
      .then((loadedAsset) => {
        const available = normalizeVersions(loadedAsset.availableVersions);
        setAsset(loadedAsset);
        setVersions(available);
        setSelectedVersion(available.includes(loadedAsset.version) ? loadedAsset.version : null);
      })
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

  // Same-type assets, once the primary asset has loaded. Best-effort — a
  // failure here shouldn't block the rest of the page.
  useEffect(() => {
    if (!asset) return;
    const controller = new AbortController();

    getAssets(controller.signal, { assetType: asset.assetType, limit: RELATED_ASSET_LIMIT + 1 })
      .then((result) => {
        setRelatedAssets(
          result.data.filter((candidate) => candidate.id !== asset.id).slice(0, RELATED_ASSET_LIMIT)
        );
      })
      .catch(() => {
        // Non-critical; leave the section empty.
      });

    return () => controller.abort();
  }, [asset]);

  // Does the connected wallet already hold a license for this asset? Wallet
  // connection is one-directional in this UI (no disconnect control), so
  // `existingLicense` is still at its initial `null` for every reachable
  // state where this bails out early — nothing to reset.
  useEffect(() => {
    if (!wallet || !asset) return;
    const controller = new AbortController();

    getLicensesForBuyer(wallet.address, controller.signal)
      .then((result) => {
        const owned = result.data.find((license) => license.assetId === asset.id && license.isActive);
        setExistingLicense(owned ?? null);
      })
      .catch(() => {
        setExistingLicense(null);
      });

    return () => controller.abort();
  }, [wallet, asset]);

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

  async function submitPurchase(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pendingRef.current || !asset || !asset.isActive || !wallet || existingLicense) return;

    setPurchase(null);
    setPurchaseError(null);

    const buyer = wallet.address;
    if (!isBuyerAddress(buyer)) {
      setPurchaseError("The connected wallet address is not a valid Stellar public key.");
      return;
    }
    if (selectedVersion === null || !versions.includes(selectedVersion)) {
      setPurchaseError("Select one of the currently available asset versions.");
      return;
    }

    pendingRef.current = true;
    setPending(true);
    try {
      const result = await purchaseAssetVersion(assetId, buyer, selectedVersion);
      setPurchase(result);
      setExistingLicense(result.license);
    } catch (reason) {
      setPurchaseError(reason instanceof Error ? reason.message : "The purchase could not be completed.");
    } finally {
      pendingRef.current = false;
      setPending(false);
    }
  }

  if (loading) {
    return <StatePanel message="Loading asset details…" />;
  }

  if (notFound) {
    return (
      <StatePanel
        title="Asset not found"
        message="This marketplace asset does not exist or is no longer active."
      />
    );
  }

  if (loadError || !asset) {
    return <StatePanel title="Unable to load asset" message={loadError || "The asset response was empty."} error />;
  }

  const purchasable =
    asset.isActive && selectedVersion !== null && versions.length > 0 && !!wallet && !existingLicense;

  const purchaseButtonLabel = pending
    ? "Purchasing…"
    : existingLicense
      ? "License already owned"
      : !wallet
        ? "Connect wallet to purchase"
        : selectedVersion
          ? `Purchase version ${selectedVersion}`
          : "Version unavailable";

  return (
    <main className="min-h-screen bg-black px-6 py-12 text-white">
      <div className="mx-auto max-w-5xl">
        <Link href="/marketplace" className="mb-8 inline-block text-sm text-zinc-400 hover:text-white">
          ← Back to Marketplace
        </Link>

        <div className="grid gap-8 lg:grid-cols-[1.35fr_0.65fr]">
          <section>
            <div className="mb-6 flex flex-wrap items-center gap-3">
              <span className="rounded-full bg-purple-500/15 px-3 py-1 text-sm font-semibold text-purple-300">
                Current version {asset.version}
              </span>
              <span
                className={`rounded-full px-3 py-1 text-xs font-semibold ${asset.isActive ? "bg-green-500/15 text-green-400" : "bg-zinc-800 text-zinc-400"}`}
              >
                {asset.isActive ? "Active" : "Inactive"}
              </span>
              <span className="rounded-full bg-zinc-900 px-3 py-1 text-xs text-zinc-400">
                {asset.assetType}
              </span>
            </div>

            <h1 className="text-4xl font-bold tracking-tight">{asset.name}</h1>
            <p className="mt-5 text-lg leading-8 text-zinc-300">{asset.description}</p>

            <dl className="mt-8 grid grid-cols-2 gap-4 rounded-xl border border-zinc-800 bg-zinc-900 p-6 sm:grid-cols-4">
              <div>
                <dt className="text-xs uppercase tracking-wide text-zinc-500">Price</dt>
                <dd className="mt-2 font-semibold">{formatPrice(asset.price)}</dd>
              </div>
              <div>
                <dt className="text-xs uppercase tracking-wide text-zinc-500">License</dt>
                <dd className="mt-2 font-semibold">{asset.licenseType}</dd>
              </div>
              <div>
                <dt className="text-xs uppercase tracking-wide text-zinc-500">Uses</dt>
                <dd className="mt-2 font-semibold">{asset.usageCount.toLocaleString()}</dd>
              </div>
              <div>
                <dt className="text-xs uppercase tracking-wide text-zinc-500">Owner</dt>
                <dd className="mt-2 font-mono font-semibold" title={asset.owner}>
                  {truncateAddress(asset.owner)}
                </dd>
              </div>
            </dl>

            {relatedAssets.length > 0 && (
              <div className="mt-10">
                <h2 className="text-xl font-bold">More {asset.assetType} assets</h2>
                <div className="mt-4 grid gap-4 sm:grid-cols-2">
                  {relatedAssets.map((related) => (
                    <Link
                      key={related.id}
                      href={`/marketplace/${related.id}`}
                      className="rounded-lg border border-zinc-800 bg-zinc-900 p-4 transition-colors hover:border-purple-500"
                    >
                      <p className="font-semibold">{related.name}</p>
                      <p className="mt-1 text-sm text-zinc-400">{formatPrice(related.price)}</p>
                    </Link>
                  ))}
                </div>
              </div>
            )}
          </section>

          <aside className="h-fit rounded-xl border border-zinc-800 bg-zinc-900 p-6">
            <h2 className="text-xl font-bold">Purchase a license</h2>

            {existingLicense ? (
              <p role="status" className="mt-4 rounded-lg border border-green-900/60 bg-green-950/30 p-3 text-sm text-green-300">
                You already own an active license for this asset (version {existingLicense.assetVersion}
                {existingLicense.callsRemaining !== null
                  ? `, ${existingLicense.callsRemaining.toLocaleString()} calls remaining`
                  : ""}
                ).
              </p>
            ) : (
              <p className="mt-2 text-sm leading-6 text-zinc-400">
                Choose one of the retained versions. Current pricing and license terms apply.
              </p>
            )}

            {!wallet && (
              <div className="mt-6">
                <button
                  type="button"
                  onClick={handleConnectWallet}
                  disabled={connecting}
                  className="w-full rounded-lg border border-zinc-700 px-4 py-3 font-semibold transition-colors hover:border-purple-500 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {connecting ? "Connecting…" : "Connect Wallet"}
                </button>
                {walletError && (
                  <div role="alert" className="mt-3 rounded-lg border border-red-900/60 bg-red-950/30 p-3 text-sm text-red-300">
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

            {wallet && (
              <p className="mt-4 text-sm text-zinc-400">
                Buying as{" "}
                <span className="font-mono text-zinc-200" title={wallet.address}>
                  {truncateWalletAddress(wallet.address)}
                </span>
              </p>
            )}

            <form className="mt-6 space-y-6" onSubmit={submitPurchase}>
              <fieldset disabled={!asset.isActive || pending || !wallet || !!existingLicense}>
                <legend className="mb-3 text-sm font-semibold text-zinc-300">Available versions</legend>
                {versions.length === 0 ? (
                  <p role="alert" className="rounded-lg border border-amber-900/60 bg-amber-950/30 p-3 text-sm text-amber-300">
                    No purchasable versions were returned for this asset.
                  </p>
                ) : (
                  <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-2">
                    {versions.map((version) => (
                      <label
                        key={version}
                        className={`cursor-pointer rounded-lg border px-3 py-3 text-center text-sm font-semibold transition-colors ${selectedVersion === version ? "border-purple-500 bg-purple-500/15 text-purple-200" : "border-zinc-700 bg-zinc-950 text-zinc-400 hover:border-zinc-500"}`}
                      >
                        <input
                          type="radio"
                          name="asset-version"
                          value={version}
                          checked={selectedVersion === version}
                          onChange={() => {
                            setSelectedVersion(version);
                            setPurchase(null);
                            setPurchaseError(null);
                          }}
                          className="sr-only"
                        />
                        Version {version}
                        {version === asset.version ? " · Current" : ""}
                      </label>
                    ))}
                  </div>
                )}
              </fieldset>

              {!asset.isActive && (
                <p role="alert" className="text-sm text-amber-300">
                  This asset is inactive and cannot be purchased.
                </p>
              )}
              {purchaseError && (
                <p role="alert" className="rounded-lg border border-red-900/60 bg-red-950/30 p-3 text-sm text-red-300">
                  {purchaseError}
                </p>
              )}
              {purchase && (
                <p role="status" className="rounded-lg border border-green-900/60 bg-green-950/30 p-3 text-sm text-green-300">
                  License purchased successfully for version {purchase.license.assetVersion}.
                </p>
              )}

              <button
                type="submit"
                disabled={!purchasable || pending}
                className="w-full rounded-lg bg-purple-600 px-4 py-3 font-semibold transition-colors hover:bg-purple-700 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {purchaseButtonLabel}
              </button>
            </form>
          </aside>
        </div>
      </div>
    </main>
  );
}

function StatePanel({
  title,
  message,
  error = false,
}: {
  title?: string;
  message: string;
  error?: boolean;
}) {
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
