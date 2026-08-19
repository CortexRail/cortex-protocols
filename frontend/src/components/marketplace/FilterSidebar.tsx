"use client";

import { useState } from "react";
import { AssetType, LicenseType } from "@/lib/api/assets";
import { AssetTypeBadge } from "./AssetTypeBadge";
import { getAssetTypeIcon } from "@/lib/formatters";

const ASSET_TYPES: AssetType[] = ["prompt", "workflow", "reasoning", "agent", "dataset", "model", "integration", "template"];
const LICENSE_TYPES: LicenseType[] = ["CC0", "MIT", "Apache2", "Custom"];

interface FilterSidebarProps {
  selectedType?: AssetType | "all";
  selectedLicense?: LicenseType | "all";
  priceRange?: [number, number];
  minReputation?: number;
  onTypeChange: (type: AssetType | "all" | undefined) => void;
  onLicenseChange: (license: LicenseType | "all" | undefined) => void;
  onPriceChange: (min?: number, max?: number) => void;
  onReputationChange: (min?: number) => void;
}

export function FilterSidebar({
  selectedType,
  selectedLicense,
  priceRange = [0, 10000000],
  minReputation = 0,
  onTypeChange,
  onLicenseChange,
  onPriceChange,
  onReputationChange,
}: FilterSidebarProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [localMin, localMax] = priceRange;

  return (
    <>
      {/* Mobile toggle */}
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="md:hidden mb-4 w-full px-4 py-2 bg-zinc-900 border border-zinc-800 rounded-lg text-white hover:border-purple-500 transition-colors"
      >
        {isOpen ? "Hide Filters" : "Show Filters"}
      </button>

      {/* Sidebar */}
      <div
        className={`md:block space-y-6 ${
          isOpen ? "block" : "hidden"
        } pb-6 md:pb-0`}
      >
        {/* Asset Type Filter */}
        <div>
          <h3 className="text-sm font-semibold text-zinc-300 mb-3">Asset Type</h3>
          <div className="space-y-2">
            <button
              onClick={() => onTypeChange(undefined)}
              className={`w-full text-left px-3 py-2 rounded transition-colors ${
                !selectedType || selectedType === "all"
                  ? "bg-purple-600 text-white"
                  : "text-zinc-400 hover:bg-zinc-800"
              }`}
            >
              All Types
            </button>
            {ASSET_TYPES.map((type) => (
              <button
                key={type}
                onClick={() => onTypeChange(selectedType === type ? undefined : type)}
                className={`w-full text-left px-3 py-2 rounded flex items-center gap-2 transition-colors ${
                  selectedType === type
                    ? "bg-purple-600 text-white"
                    : "text-zinc-400 hover:bg-zinc-800"
                }`}
              >
                <span>{getAssetTypeIcon(type)}</span>
                {type.charAt(0).toUpperCase() + type.slice(1)}
              </button>
            ))}
          </div>
        </div>

        {/* License Type Filter */}
        <div>
          <h3 className="text-sm font-semibold text-zinc-300 mb-3">License</h3>
          <div className="space-y-2">
            <button
              onClick={() => onLicenseChange(undefined)}
              className={`w-full text-left px-3 py-2 rounded transition-colors ${
                !selectedLicense || selectedLicense === "all"
                  ? "bg-purple-600 text-white"
                  : "text-zinc-400 hover:bg-zinc-800"
              }`}
            >
              All Licenses
            </button>
            {LICENSE_TYPES.map((license) => (
              <button
                key={license}
                onClick={() =>
                  onLicenseChange(selectedLicense === license ? undefined : license)
                }
                className={`w-full text-left px-3 py-2 rounded transition-colors ${
                  selectedLicense === license
                    ? "bg-purple-600 text-white"
                    : "text-zinc-400 hover:bg-zinc-800"
                }`}
              >
                {license}
              </button>
            ))}
          </div>
        </div>

        {/* Price Range */}
        <div>
          <h3 className="text-sm font-semibold text-zinc-300 mb-3">Price (XLM)</h3>
          <div className="space-y-2">
            <div>
              <label className="text-xs text-zinc-500">Min</label>
              <input
                type="number"
                min="0"
                value={localMin / 10_000_000}
                onChange={(e) =>
                  onPriceChange(
                    Number(e.target.value) * 10_000_000,
                    localMax
                  )
                }
                className="w-full px-2 py-1 bg-zinc-800 border border-zinc-700 rounded text-white text-sm focus:outline-none focus:border-purple-500"
              />
            </div>
            <div>
              <label className="text-xs text-zinc-500">Max</label>
              <input
                type="number"
                min="0"
                value={localMax / 10_000_000}
                onChange={(e) =>
                  onPriceChange(
                    localMin,
                    Number(e.target.value) * 10_000_000
                  )
                }
                className="w-full px-2 py-1 bg-zinc-800 border border-zinc-700 rounded text-white text-sm focus:outline-none focus:border-purple-500"
              />
            </div>
          </div>
        </div>

        {/* Minimum Reputation */}
        <div>
          <h3 className="text-sm font-semibold text-zinc-300 mb-3">
            Min Owner Reputation
          </h3>
          <input
            type="range"
            min="0"
            max="100"
            value={minReputation}
            onChange={(e) => onReputationChange(Number(e.target.value) || undefined)}
            className="w-full"
          />
          <div className="flex justify-between text-xs text-zinc-500 mt-2">
            <span>0%</span>
            <span>{minReputation}%</span>
            <span>100%</span>
          </div>
        </div>
      </div>
    </>
  );
}
