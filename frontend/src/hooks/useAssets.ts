"use client";

import { useEffect, useState } from "react";
import { Asset, AssetFilters, AssetListResponse, fetchAssets } from "@/lib/api/assets";
import { useContracts } from "@/components/ContractProvider";

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

  const load = async () => {
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
  };

  useEffect(() => {
    load();
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

  return { data, isLoading, error, mutate: load, meta };
}

export function useAsset(id: string) {
  const [data, setData] = useState<Asset | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const { marketplace } = useContracts();

  useEffect(() => {
    const load = async () => {
      setIsLoading(true);
      setError(null);
      try {
        if (marketplace) {
          const result = await marketplace.get_asset({ asset_id: BigInt(id) });
          if (!result) throw new Error("Asset not found");
          
          setData({
            id: Number(result.id),
            name: result.name.toString(),
            description: result.description.toString(),
            price: Number(result.price),
            owner: result.owner,
            assetType: "prompt", // Hardcoded fallback or map if contract returns it
            licenseType: "MIT",
            usageCount: 0,
            tags: [],
            version: result.version,
            flagged: false,
            listedAt: new Date().toISOString(),
          } as Asset);
        } else {
          // Fallback if contract provider is not ready
          const { fetchAsset } = await import("@/lib/api/assets");
          const result = await fetchAsset(Number(id));
          setData(result);
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to fetch asset");
      } finally {
        setIsLoading(false);
      }
    };
    if (id) load();
  }, [id, marketplace]);

  return { data, isLoading, error };
}
