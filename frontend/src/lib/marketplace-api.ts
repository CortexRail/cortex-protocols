import type {
  Asset,
  AssetListResponse,
  PurchaseResponse,
} from "@/types/marketplace";

const API_URL = (process.env.NEXT_PUBLIC_API_URL || "http://localhost:4000").replace(
  /\/$/,
  ""
);

export class MarketplaceApiError extends Error {
  constructor(
    message: string,
    public readonly status: number
  ) {
    super(message);
    this.name = "MarketplaceApiError";
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_URL}${path}`, init);
  let body: unknown;

  try {
    body = await response.json();
  } catch {
    body = null;
  }

  if (!response.ok) {
    const payload = body as { error?: string; message?: string } | null;
    throw new MarketplaceApiError(
      payload?.message || payload?.error || `Request failed (${response.status})`,
      response.status
    );
  }

  return body as T;
}

export function getAssets(signal?: AbortSignal): Promise<AssetListResponse> {
  return request<AssetListResponse>("/api/v1/assets", { signal });
}

export function getAsset(id: string, signal?: AbortSignal): Promise<Asset> {
  return request<Asset>(`/api/v1/assets/${encodeURIComponent(id)}`, { signal });
}

export function purchaseAssetVersion(
  id: string,
  buyer: string,
  assetVersion: number
): Promise<PurchaseResponse> {
  return request<PurchaseResponse>(
    `/api/v1/assets/${encodeURIComponent(id)}/purchase`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ buyer, assetVersion }),
    }
  );
}

export function isBuyerAddress(value: string): boolean {
  return /^G[A-Z2-7]{55}$/.test(value);
}
