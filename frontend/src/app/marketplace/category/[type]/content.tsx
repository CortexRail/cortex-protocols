"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import type { Asset } from "@/types/marketplace";

function formatPrice(price: number) {
  return `${price.toLocaleString()} stroops`;
}

export default function CategoryContent({
  type,
  categoryName,
}: {
  type: string;
  categoryName: string;
}) {
  const [assets, setAssets] = useState<Asset[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();

    (async () => {
      try {
        const apiUrl = process.env.NEXT_PUBLIC_API_URL || "http://localhost:4000";
        const response = await fetch(
          `${apiUrl}/api/v1/assets?assetType=${encodeURIComponent(type)}&limit=100`,
          { signal: controller.signal }
        );

        if (!response.ok) {
          throw new Error(`API error: ${response.status}`);
        }

        const data = await response.json();
        setAssets(Array.isArray(data.data) ? data.data : []);
      } catch (reason: unknown) {
        if (reason instanceof DOMException && reason.name === "AbortError") return;
        setError(reason instanceof Error ? reason.message : "Failed to load assets");
      } finally {
        setLoading(false);
      }
    })();

    return () => controller.abort();
  }, [type]);

  if (loading) {
    return (
      <div className="rounded-xl border border-zinc-800 bg-zinc-900/60 px-6 py-16 text-center text-zinc-400">
        Loading {categoryName.toLowerCase()}…
      </div>
    );
  }

  if (error) {
    return (
      <div role="alert" className="rounded-xl border border-red-900/70 bg-red-950/30 px-6 py-10 text-center">
        <p className="font-semibold text-red-300">Failed to load assets</p>
        <p className="mt-2 text-sm text-red-200/70">{error}</p>
      </div>
    );
  }

  if (assets.length === 0) {
    return (
      <div className="rounded-xl border border-zinc-800 bg-zinc-900/60 px-6 py-16 text-center">
        <p className="font-semibold">No {categoryName.toLowerCase()} available yet</p>
        <p className="mt-2 text-sm text-zinc-500">New assets in this category will appear here.</p>
        <Link href="/marketplace" className="mt-6 inline-block text-sm font-semibold text-purple-400 hover:text-purple-300">
          Browse other categories
        </Link>
      </div>
    );
  }

  return (
    <>
      <p className="mb-6 text-sm text-zinc-500">
        {assets.length} asset{assets.length !== 1 ? "s" : ""} available
      </p>
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
    </>
  );
}
