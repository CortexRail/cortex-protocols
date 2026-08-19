"use client";

import { useAsset } from "@/hooks/useAssets";
import { AssetDetail } from "@/components/marketplace/AssetDetail";
import Link from "next/link";

interface AssetDetailPageProps {
  params: {
    id: string;
  };
}

export default function AssetDetailPage({ params }: AssetDetailPageProps) {
  const { data: asset, isLoading, error } = useAsset(params.id);

  return (
    <main className="min-h-screen bg-black text-white pt-12 px-6 pb-12">
      <div className="max-w-6xl mx-auto">
        {/* Breadcrumb */}
        <div className="mb-8 flex items-center gap-2 text-sm">
          <Link
            href="/marketplace"
            className="text-purple-400 hover:text-purple-300 transition-colors"
          >
            Marketplace
          </Link>
          <span className="text-zinc-600">/</span>
          <span className="text-zinc-400">Asset Details</span>
        </div>

        {isLoading && (
          <div className="text-center py-12">
            <p className="text-zinc-400">Loading asset...</p>
          </div>
        )}

        {error && (
          <div className="p-4 bg-red-500/10 border border-red-500 rounded-lg text-red-400 mb-6">
            Failed to load asset: {error}
          </div>
        )}

        {asset && <AssetDetail asset={asset} />}
      </div>
    </main>
  );
}
