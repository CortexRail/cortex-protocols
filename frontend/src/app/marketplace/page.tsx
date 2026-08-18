"use client";

import { useState } from "react";
import Link from "next/link";
import { useAssets } from "@/hooks/useAssets";
import { useAssetFilters } from "@/hooks/useAssetFilters";
import { AssetGrid } from "@/components/marketplace/AssetGrid";
import { SearchBar } from "@/components/marketplace/SearchBar";
import { FilterSidebar } from "@/components/marketplace/FilterSidebar";
import { SortDropdown } from "@/components/marketplace/SortDropdown";
import { PaginationBar } from "@/components/marketplace/PaginationBar";

export default function MarketplacePage() {
  const {
    filters,
    updateSearch,
    updateType,
    updateLicenseType,
    updatePriceRange,
    updateMinReputation,
    updateSortBy,
    updatePage,
    reset,
  } = useAssetFilters();

  const { data: assets, isLoading, error, meta } = useAssets(filters);

  const [pageSize, setPageSize] = useState(12);

  const handlePageSizeChange = (size: number) => {
    setPageSize(size);
    updatePage(1);
  };

  return (
    <main className="min-h-screen bg-black text-white pt-12 px-6 pb-12">
      <div className="max-w-7xl mx-auto">
        {/* Header */}
        <div className="mb-12">
          <div className="flex flex-col md:flex-row items-start md:items-center justify-between mb-8 gap-4">
            <div>
              <h1 className="text-4xl font-bold mb-2">Marketplace</h1>
              <p className="text-zinc-400">
                Discover and exchange intelligence assets on the Stellar network
              </p>
            </div>
            <Link
              href="/marketplace/new"
              className="px-6 py-2 bg-purple-600 hover:bg-purple-700 rounded-lg font-semibold transition-colors whitespace-nowrap"
            >
              Create Asset
            </Link>
          </div>

          {/* Search */}
          <div className="mb-6">
            <SearchBar
              onSearch={updateSearch}
              resultCount={meta?.total}
            />
          </div>

          {/* Sort controls */}
          <div className="flex items-center justify-between mb-6">
            <SortDropdown
              value={filters.sortBy}
              onChange={updateSortBy}
            />
            <button
              onClick={reset}
              className="px-3 py-2 text-sm text-zinc-400 hover:text-white transition-colors"
            >
              Clear filters
            </button>
          </div>
        </div>

        {/* Main content */}
        <div className="grid grid-cols-1 md:grid-cols-4 gap-8 mb-12">
          {/* Sidebar */}
          <div className="md:col-span-1">
            <FilterSidebar
              selectedType={filters.type}
              selectedLicense={filters.licenseType}
              priceRange={[
                filters.minPrice || 0,
                filters.maxPrice || 10_000_000,
              ]}
              minReputation={filters.minReputation || 0}
              onTypeChange={updateType}
              onLicenseChange={updateLicenseType}
              onPriceChange={updatePriceRange}
              onReputationChange={updateMinReputation}
            />
          </div>

          {/* Assets Grid */}
          <div className="md:col-span-3">
            {error && (
              <div className="p-4 bg-red-500/10 border border-red-500 rounded-lg text-red-400 mb-6">
                {error}
              </div>
            )}
            <AssetGrid
              assets={assets}
              isLoading={isLoading}
            />
          </div>
        </div>

        {/* Pagination */}
        {meta && !isLoading && (
          <PaginationBar
            currentPage={meta.page}
            totalPages={meta.pages}
            pageSize={pageSize}
            onPageChange={updatePage}
            onPageSizeChange={handlePageSizeChange}
          />
        )}
      </div>
    </main>
  );
}
