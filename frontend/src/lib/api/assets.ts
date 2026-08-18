// Asset API integration with type safety
import type { Asset, AssetListResponse } from "@/types/marketplace";

export type AssetType =
  | "prompt"
  | "workflow"
  | "reasoning"
  | "agent"
  | "dataset"
  | "model"
  | "integration"
  | "template";

export type LicenseType = "CC0" | "MIT" | "Apache2" | "Custom";

export interface AssetFilters {
  search?: string;
  assetType?: AssetType | "all";
  licenseType?: LicenseType | "all";
  minPrice?: number;
  maxPrice?: number;
  minReputation?: number;
  sortBy?: "newest" | "mostUsed" | "priceLow" | "priceHigh" | "reputation";
  page?: number;
  limit?: number;
}

export type { Asset, AssetListResponse };

const API_BASE = process.env.NEXT_PUBLIC_API_URL || "http://localhost:4000/api/v1";

export async function fetchAssets(
  filters: AssetFilters = {}
): Promise<AssetListResponse> {
  const params = new URLSearchParams();

  if (filters.search) params.append("search", filters.search);
  if (filters.assetType && filters.assetType !== "all") params.append("assetType", filters.assetType);
  if (filters.licenseType && filters.licenseType !== "all")
    params.append("license", filters.licenseType);
  if (filters.minPrice) params.append("minPrice", String(filters.minPrice));
  if (filters.maxPrice) params.append("maxPrice", String(filters.maxPrice));
  if (filters.minReputation) params.append("minRep", String(filters.minReputation));
  if (filters.sortBy) params.append("sort", filters.sortBy);
  params.append("page", String(filters.page || 1));
  params.append("limit", String(filters.limit || 12));

  const res = await fetch(`${API_BASE}/assets?${params}`);
  if (!res.ok) throw new Error(`Failed to fetch assets: ${res.statusText}`);
  return res.json();
}

export async function fetchAsset(id: number): Promise<Asset> {
  const res = await fetch(`${API_BASE}/assets/${id}`);
  if (!res.ok) throw new Error(`Failed to fetch asset: ${res.statusText}`);
  return res.json();
}

export async function fetchAssetsByCategory(
  type: AssetType,
  limit: number = 12
): Promise<Asset[]> {
  const res = await fetchAssets({ assetType: type, limit });
  return res.data;
}
