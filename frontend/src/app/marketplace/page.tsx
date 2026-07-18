"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { getAssets } from "@/lib/marketplace-api";
import type { Asset } from "@/types/marketplace";

function formatPrice(price: number) {
  return `${price.toLocaleString()} stroops`;
}

export default function MarketplacePage() {
  const [assets, setAssets] = useState<Asset[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();

    getAssets(controller.signal)
      .then((response) => setAssets(Array.isArray(response.data) ? response.data : []))
      .catch((reason: unknown) => {
        if (reason instanceof DOMException && reason.name === "AbortError") return;
        setError(reason instanceof Error ? reason.message : "Unable to load assets");
      })
      .finally(() => setLoading(false));

    return () => controller.abort();
  }, []);

  return (
    <main className="min-h-screen bg-black px-6 py-12 text-white">
      <div className="mx-auto max-w-7xl">
        <header className="mb-10 flex flex-col gap-4 border-b border-zinc-800 pb-8 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <Link href="/" className="mb-4 inline-block text-sm text-zinc-400 hover:text-white">
              ← Intelligence Rail
            </Link>
            <p className="mb-2 font-mono text-xs uppercase tracking-[0.25em] text-purple-400">
              Intelligence assets
            </p>
            <h1 className="text-4xl font-bold tracking-tight">Marketplace</h1>
            <p className="mt-2 max-w-2xl text-zinc-400">
              Discover versioned prompts, workflows, tools, and reasoning systems.
            </p>
          </div>
        </header>

        {loading ? (
          <div className="rounded-xl border border-zinc-800 bg-zinc-900/60 px-6 py-16 text-center text-zinc-400">
            Loading marketplace assets…
          </div>
        ) : error ? (
          <div role="alert" className="rounded-xl border border-red-900/70 bg-red-950/30 px-6 py-10 text-center">
            <p className="font-semibold text-red-300">Marketplace unavailable</p>
            <p className="mt-2 text-sm text-red-200/70">{error}</p>
          </div>
        ) : assets.length === 0 ? (
          <div className="rounded-xl border border-zinc-800 bg-zinc-900/60 px-6 py-16 text-center">
            <p className="font-semibold">No assets are listed yet</p>
            <p className="mt-2 text-sm text-zinc-500">New intelligence assets will appear here.</p>
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-6 md:grid-cols-2 lg:grid-cols-3">
            {assets.map((asset) => (
              <Link key={asset.id} href={`/marketplace/${asset.id}`} className="group">
                <article className="flex h-full flex-col rounded-xl border border-zinc-800 bg-zinc-900 p-6 transition-colors group-hover:border-purple-500">
                  <div className="mb-5 flex items-center justify-between gap-3">
                    <span className="rounded-full bg-purple-500/15 px-3 py-1 text-xs font-semibold text-purple-300">
                      Version {asset.version}
                    </span>
                    <span className={`text-xs font-medium ${asset.isActive ? "text-green-400" : "text-zinc-500"}`}>
                      {asset.isActive ? "Active" : "Inactive"}
                    </span>
                  </div>
                  <h2 className="text-xl font-bold transition-colors group-hover:text-purple-400">
                    {asset.name}
                  </h2>
                  <p className="mt-3 line-clamp-3 flex-1 text-sm leading-6 text-zinc-400">
                    {asset.description}
                  </p>
                  <dl className="mt-6 grid grid-cols-2 gap-4 border-t border-zinc-800 pt-5 text-sm">
                    <div>
                      <dt className="text-xs text-zinc-500">Price</dt>
                      <dd className="mt-1 font-semibold">{formatPrice(asset.price)}</dd>
                    </div>
                    <div>
                      <dt className="text-xs text-zinc-500">License</dt>
                      <dd className="mt-1 font-semibold">{asset.licenseType}</dd>
                    </div>
                  </dl>
                </article>
              </Link>
            ))}
          </div>
        )}
      </div>
    </main>
  );
}
