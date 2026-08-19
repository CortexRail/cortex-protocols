"use client";

import { AssetFilters } from "@/lib/api/assets";

type SortOption = Required<AssetFilters>["sortBy"];

const SORT_OPTIONS: { label: string; value: SortOption }[] = [
  { label: "Newest First", value: "newest" },
  { label: "Most Used", value: "mostUsed" },
  { label: "Price: Low → High", value: "priceLow" },
  { label: "Price: High → Low", value: "priceHigh" },
  { label: "Reputation", value: "reputation" },
];

interface SortDropdownProps {
  value?: SortOption;
  onChange: (sort: SortOption) => void;
}

export function SortDropdown({ value = "newest", onChange }: SortDropdownProps) {
  return (
    <div className="flex items-center gap-2">
      <label className="text-sm font-semibold text-zinc-300">Sort by:</label>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value as SortOption)}
        className="px-3 py-2 bg-zinc-900 border border-zinc-800 rounded-lg text-white text-sm focus:outline-none focus:border-purple-500"
      >
        {SORT_OPTIONS.map((opt) => (
          <option key={opt.value} value={opt.value}>
            {opt.label}
          </option>
        ))}
      </select>
    </div>
  );
}
