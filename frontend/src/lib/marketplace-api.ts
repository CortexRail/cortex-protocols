import type {
  Asset,
  AssetListResponse,
  LicenseListResponse,
  PurchaseResponse,
  RemainingCallsResponse,
  RevenueBreakdownResponse,
  TopCallersResponse,
  TopUpResponse,
  UsageSeriesResponse,
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

export function getAssets(
  signal?: AbortSignal,
  filters?: { assetType?: string; page?: number; limit?: number }
): Promise<AssetListResponse> {
  const params = new URLSearchParams();
  if (filters?.assetType) params.append("assetType", filters.assetType);
  if (filters?.page) params.append("page", String(filters.page));
  if (filters?.limit) params.append("limit", String(filters.limit));

  const query = params.toString();
  return request<AssetListResponse>(`/api/v1/assets${query ? `?${query}` : ""}`, { signal });
}

export function getAsset(id: string, signal?: AbortSignal): Promise<Asset> {
  return request<Asset>(`/api/v1/assets/${encodeURIComponent(id)}`, { signal });
}

/**
 * Every license a buyer holds, most recent first — used to check whether
 * the connected wallet already owns a license for the asset being viewed.
 */
export function getLicensesForBuyer(
  buyer: string,
  signal?: AbortSignal
): Promise<LicenseListResponse> {
  const params = new URLSearchParams({ buyer, limit: "100" });
  return request<LicenseListResponse>(`/api/v1/licenses?${params}`, { signal });
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

// ── Owner-facing asset analytics ────────────────────────────────────────────
// Every call below requires `owner` and is only readable by that asset's
// owner — the backend checks asset.owner === owner and 403s otherwise.

export function getAssetUsage(
  assetId: string,
  owner: string,
  options?: { from?: number; to?: number; bucketSeconds?: number },
  signal?: AbortSignal
): Promise<UsageSeriesResponse> {
  const params = new URLSearchParams({ owner });
  if (options?.from !== undefined) params.append("from", String(options.from));
  if (options?.to !== undefined) params.append("to", String(options.to));
  if (options?.bucketSeconds !== undefined) params.append("bucketSeconds", String(options.bucketSeconds));
  return request<UsageSeriesResponse>(`/api/v1/assets/${encodeURIComponent(assetId)}/usage?${params}`, {
    signal,
  });
}

export function getAssetTopCallers(
  assetId: string,
  owner: string,
  options?: { from?: number; to?: number; limit?: number },
  signal?: AbortSignal
): Promise<TopCallersResponse> {
  const params = new URLSearchParams({ owner });
  if (options?.from !== undefined) params.append("from", String(options.from));
  if (options?.to !== undefined) params.append("to", String(options.to));
  if (options?.limit !== undefined) params.append("limit", String(options.limit));
  return request<TopCallersResponse>(
    `/api/v1/assets/${encodeURIComponent(assetId)}/top-callers?${params}`,
    { signal }
  );
}

export function getAssetRevenueBreakdown(
  assetId: string,
  owner: string,
  signal?: AbortSignal
): Promise<RevenueBreakdownResponse> {
  const params = new URLSearchParams({ owner });
  return request<RevenueBreakdownResponse>(
    `/api/v1/assets/${encodeURIComponent(assetId)}/revenue-breakdown?${params}`,
    { signal }
  );
}

export function getAssetRemainingCalls(
  assetId: string,
  owner: string,
  signal?: AbortSignal
): Promise<RemainingCallsResponse> {
  const params = new URLSearchParams({ owner });
  return request<RemainingCallsResponse>(
    `/api/v1/assets/${encodeURIComponent(assetId)}/remaining-calls?${params}`,
    { signal }
  );
}

/**
 * Buy additional calls for an existing usage-based license — the buyer's
 * own self-service top-up, distinct from the owner-facing calls above.
 */
export function topUpLicense(licenseId: number, buyer: string, calls: number): Promise<TopUpResponse> {
  return request<TopUpResponse>(`/api/v1/licenses/${licenseId}/topup`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ buyer, calls }),
  });
}
