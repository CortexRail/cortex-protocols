"use client";

import { Asset } from "@/lib/api/assets";
import { AssetCard } from "./AssetCard";

interface AssetGridProps {
  assets: Asset[];
  isLoading: boolean;
  columns?: number;
}

function SkeletonCard() {
  return (
    <div className="h-96 p-5 bg-zinc-900 border border-zinc-800 rounded-lg animate-pulse">
      <div className="flex items-start justify-between mb-3">
        <div className="h-4 w-12 bg-zinc-700 rounded" />
        <div className="h-4 w-12 bg-zinc-700 rounded" />
      </div>
      <div className="h-6 w-3/4 bg-zinc-700 rounded mb-3" />
      <div className="space-y-2 mb-4">
        <div className="h-4 w-full bg-zinc-700 rounded" />
        <div className="h-4 w-5/6 bg-zinc-700 rounded" />
      </div>
      <div className="h-12 w-full bg-zinc-700 rounded mb-4" />
      <div className="h-4 w-1/2 bg-zinc-700 rounded" />
    </div>
  );
}

export function AssetGrid({ assets, isLoading, columns = 3 }: AssetGridProps) {
  const colsClass = {
    2: "grid-cols-1 md:grid-cols-2",
    3: "grid-cols-1 md:grid-cols-2 lg:grid-cols-3",
    4: "grid-cols-1 md:grid-cols-2 lg:grid-cols-4",
  }[columns] || "grid-cols-1 md:grid-cols-2 lg:grid-cols-3";

  if (isLoading) {
    return (
      <div className={`grid ${colsClass} gap-6`}>
        {Array.from({ length: 12 }).map((_, i) => (
          <SkeletonCard key={i} />
        ))}
      </div>
    );
  }

  if (assets.length === 0) {
    return (
      <div className="text-center py-12">
        <p className="text-zinc-400 text-lg">No assets found</p>
      </div>
    );
  }

  return (
    <div className={`grid ${colsClass} gap-6`}>
      {assets.map((asset) => (
        <AssetCard key={asset.id} asset={asset} />
      ))}
    </div>
  );
}
