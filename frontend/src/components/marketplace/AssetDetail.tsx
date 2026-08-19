"use client";

import { useState } from "react";
import Link from "next/link";
import { Asset } from "@/lib/api/assets";
import { AssetTypeBadge } from "./AssetTypeBadge";
import { LicenseBadge } from "./LicenseBadge";
import { PriceDisplay } from "./PriceDisplay";
import { formatCompactNumber, getReputationColor, getReputationBg } from "@/lib/formatters";

interface AssetDetailProps {
  asset: Asset;
}

export function AssetDetail({ asset }: AssetDetailProps) {
  const [activeTab, setActiveTab] = useState<"overview" | "license" | "owner">("overview");

  return (
    <div className="space-y-8">
      {/* Header */}
      <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-8">
        <div className="flex flex-col md:flex-row gap-8">
          {/* Left side info */}
          <div className="flex-1">
            <div className="flex items-start gap-3 mb-4">
              <AssetTypeBadge type={asset.type} />
              <LicenseBadge type={asset.licenseType} />
            </div>

            <h1 className="text-4xl font-bold mb-3">{asset.name}</h1>
            <p className="text-lg text-zinc-400 mb-6">{asset.description}</p>

            <div className="flex flex-wrap gap-6">
              <div>
                <p className="text-xs text-zinc-500 mb-1">Used by</p>
                <p className="text-2xl font-bold">
                  {formatCompactNumber(asset.usageCount)}
                </p>
              </div>
              <div>
                <p className="text-xs text-zinc-500 mb-1">Created</p>
                <p className="font-semibold">
                  {new Date(asset.createdAt).toLocaleDateString("en-US", {
                    month: "short",
                    day: "numeric",
                    year: "numeric",
                  })}
                </p>
              </div>
            </div>
          </div>

          {/* Right side CTA */}
          <div className="md:w-72 md:sticky md:top-6 h-fit">
            <div className="bg-zinc-800/50 border border-zinc-700 rounded-lg p-6 space-y-4">
              <PriceDisplay priceInStroops={asset.priceInStroops} />
              <button className="w-full px-4 py-3 bg-purple-600 hover:bg-purple-700 rounded-lg font-semibold transition-colors">
                Buy Now
              </button>
              <button className="w-full px-4 py-2 border border-zinc-700 hover:border-zinc-500 rounded-lg font-semibold transition-colors">
                Open Stream
              </button>
              <p className="text-xs text-zinc-500 text-center">
                Powered by Stellar micropayments
              </p>
            </div>
          </div>
        </div>
      </div>

      {/* Tabs */}
      <div>
        <div className="flex gap-4 border-b border-zinc-800 mb-6">
          {(["overview", "license", "owner"] as const).map((tab) => (
            <button
              key={tab}
              onClick={() => setActiveTab(tab)}
              className={`px-4 py-2 font-semibold transition-colors border-b-2 ${
                activeTab === tab
                  ? "border-purple-500 text-white"
                  : "border-transparent text-zinc-400 hover:text-white"
              }`}
            >
              {tab.charAt(0).toUpperCase() + tab.slice(1)}
            </button>
          ))}
        </div>

        {/* Tab content */}
        <div className="space-y-6">
          {activeTab === "overview" && (
            <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-6">
              <h2 className="text-xl font-bold mb-4">Overview</h2>
              <p className="text-zinc-300 leading-relaxed whitespace-pre-wrap">
                {asset.description}
              </p>

              {asset.tags.length > 0 && (
                <div className="mt-6">
                  <h3 className="font-semibold mb-3">Tags</h3>
                  <div className="flex flex-wrap gap-2">
                    {asset.tags.map((tag) => (
                      <span
                        key={tag}
                        className="px-3 py-1 bg-zinc-800 text-zinc-300 rounded-full text-sm"
                      >
                        {tag}
                      </span>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}

          {activeTab === "license" && (
            <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-6 space-y-4">
              <div>
                <p className="text-xs text-zinc-500 mb-1">License Type</p>
                <LicenseBadge type={asset.licenseType} />
              </div>
              <div>
                <p className="text-xs text-zinc-500 mb-2">License Description</p>
                <p className="text-zinc-300">
                  This asset is available under the {asset.licenseType} license.
                  See terms for usage rights and conditions.
                </p>
              </div>
            </div>
          )}

          {activeTab === "owner" && (
            <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-6">
              <div className="flex items-start gap-4">
                <div className="w-16 h-16 bg-gradient-to-br from-purple-500 to-pink-500 rounded-full" />
                <div className="flex-1">
                  <Link
                    href={`/agents/${asset.owner.id}`}
                    className="text-lg font-bold hover:text-purple-400 transition-colors"
                  >
                    {asset.owner.name}
                  </Link>
                  <div className={`inline-block mt-2 px-3 py-1 rounded font-semibold text-sm ${getReputationBg(asset.owner.reputation)} ${getReputationColor(asset.owner.reputation)}`}>
                    {asset.owner.reputation}% Reputation
                  </div>
                  <p className="text-sm text-zinc-400 mt-3">
                    This asset is provided by a verified creator with a strong
                    reputation on the Cortex Protocol.
                  </p>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
