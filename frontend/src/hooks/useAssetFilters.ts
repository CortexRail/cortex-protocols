"use client";

import { useCallback, useState } from "react";
import { AssetFilters, AssetType, LicenseType } from "@/lib/api/assets";

export function useAssetFilters(
  initialFilters: AssetFilters = {}
) {
  const [filters, setFilters] = useState<AssetFilters>(initialFilters);

  const updateSearch = useCallback((search: string) => {
    setFilters((prev) => ({ ...prev, search: search || undefined, page: 1 }));
  }, []);

  const updateType = useCallback((type: AssetType | "all" | undefined) => {
    setFilters((prev) => ({
      ...prev,
      assetType: type === "all" ? undefined : type,
      page: 1,
    }));
  }, []);

  const updateLicenseType = useCallback(
    (licenseType: LicenseType | "all" | undefined) => {
      setFilters((prev) => ({
        ...prev,
        licenseType: licenseType === "all" ? undefined : licenseType,
        page: 1,
      }));
    },
    []
  );

  const updatePriceRange = useCallback(
    (minPrice?: number, maxPrice?: number) => {
      setFilters((prev) => ({
        ...prev,
        minPrice,
        maxPrice,
        page: 1,
      }));
    },
    []
  );

  const updateMinReputation = useCallback((minReputation?: number) => {
    setFilters((prev) => ({
      ...prev,
      minReputation,
      page: 1,
    }));
  }, []);

  const updateSortBy = useCallback(
    (sortBy: AssetFilters["sortBy"]) => {
      setFilters((prev) => ({
        ...prev,
        sortBy,
        page: 1,
      }));
    },
    []
  );

  const updatePage = useCallback((page: number) => {
    setFilters((prev) => ({
      ...prev,
      page,
    }));
  }, []);

  const reset = useCallback(() => {
    setFilters({ page: 1, limit: 12 });
  }, []);

  return {
    filters: { ...filters, limit: filters.limit || 12 },
    updateSearch,
    updateType,
    updateLicenseType,
    updatePriceRange,
    updateMinReputation,
    updateSortBy,
    updatePage,
    reset,
  };
}
