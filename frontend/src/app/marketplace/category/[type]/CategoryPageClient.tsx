"use client";

import Link from "next/link";
import { useAssets } from "@/hooks/useAssets";
import { AssetGrid } from "@/components/marketplace/AssetGrid";
import { AssetType } from "@/lib/api/assets";
import { getAssetTypeIcon } from "@/lib/formatters";

export function CategoryPageClient({ type }: { type: AssetType }) {
  const { data: assets, isLoading, error } = useAssets({
    assetType: type,
    limit: 48,
  });

  const categoryTitle = type.charAt(0).toUpperCase() + type.slice(1);
  const icon = getAssetTypeIcon(type);

  return (
    <main className="min-h-screen bg-black text-white pt-12 px-6 pb-12">
      <div className="max-w-7xl mx-auto">
        {/* Header */}
        <div className="mb-12">
          <div className="flex items-center gap-4 mb-4">
            <span className="text-4xl">{icon}</span>
            <div>
              <h1 className="text-4xl font-bold">{categoryTitle}</h1>
              <p className="text-zinc-400">
                Browse all {categoryTitle.toLowerCase()} assets
              </p>
            </div>
          </div>

          <Link
            href="/marketplace"
            className="inline-flex items-center gap-2 text-purple-400 hover:text-purple-300 transition-colors mt-6"
          >
            ← Back to Marketplace
          </Link>
        </div>

        {/* Error state */}
        {error && (
          <div className="p-4 bg-red-500/10 border border-red-500 rounded-lg text-red-400 mb-6">
            Failed to load assets: {error}
          </div>
        )}

        {/* Grid */}
        <AssetGrid assets={assets} isLoading={isLoading} columns={3} />
      </div>
    </main>
  );
}
