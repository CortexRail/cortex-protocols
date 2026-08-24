"use client";

import { useCallback, useEffect, useState } from "react";
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
  // Bumped by `mutate()` to force a refetch without duplicating the fetch
  // logic outside the effect (see useAsset below for why it stays inline).
  const [reloadToken, setReloadToken] = useState(0);

  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      setIsLoading(true);
      setError(null);
      try {
        const result = await fetchAssets(filters);
        if (cancelled) return;
        setData(result.data);
        setMeta(result.meta);
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : "Failed to fetch assets");
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    };
    load();

    return () => {
      cancelled = true;
    };
    // Depends on individual filter fields (not the `filters` object) so a
    // fresh object literal with unchanged values doesn't retrigger a fetch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
    reloadToken,
  ]);

  const mutate = useCallback(() => setReloadToken((token) => token + 1), []);

  return { data, isLoading, error, mutate, meta };
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
        const result = await fetchAsset(Number(id));
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
