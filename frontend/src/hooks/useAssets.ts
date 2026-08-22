"use client";

import { useEffect, useState, useCallback } from "react";
import { Asset, AssetFilters, AssetListResponse, fetchAssets } from "@/lib/api/assets";

export interface UseAssetsResult {
  data: Asset[];
  isLoading: boolean;
  error: string | null;
  mutate: () => void;
  meta: AssetListResponse["meta"] | null;
}

export function useAssets(filters: AssetFilters = {}): UseAssetsResult {
  const [data, setData] = useState<Asset[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [meta, setMeta] = useState<AssetListResponse["meta"] | null>(null);

  const load = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const result = await fetchAssets(filters);
      setData(result.data);
      setMeta(result.meta);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to fetch assets");
    } finally {
      setIsLoading(false);
    }
  }, [
    filters.search,
    filters.assetType,
    filters.licenseType,
    filters.minPrice,
    filters.maxPrice,
    filters.minReputation,
    filters.sortBy,
    filters.page,
    filters.limit,
  ]);

  useEffect(() => {
    load();
  }, [load]);

  return { data, isLoading, error, mutate: load, meta };
}

export function useAsset(id: string) {
  const [data, setData] = useState<Asset | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const load = async () => {
      setIsLoading(true);
      setError(null);
      try {
        const { fetchAsset } = await import("@/lib/api/assets");
        const result = await fetchAsset(id);
        setData(result);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to fetch asset");
      } finally {
        setIsLoading(false);
      }
    };
    load();
  }, [id]);

  return { data, isLoading, error };
}
