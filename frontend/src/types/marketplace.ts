export interface Asset {
  id: number;
  owner: string;
  name: string;
  description: string;
  assetType: string;
  licenseType: string;
  price: number;
  version: number;
  availableVersions: number[];
  usageCount: number;
  isActive: boolean;
  tags: string[];
  createdAt: number;
  indexedAt: number;
  updatedAt: number;
  deletedAt: number | null;
}

export interface AssetListResponse {
  data: Asset[];
  meta: {
    total: number;
    page: number;
    limit: number;
    pages: number;
  };
}

export interface License {
  id: number;
  assetId: number;
  assetVersion: number;
  buyer: string;
  licenseType: string;
  pricePaid: number;
  callsRemaining: number | null;
  expiresAt: number | null;
  isActive: boolean;
  purchasedAt: number;
  updatedAt: number;
}

export interface PurchaseResponse {
  license: License;
  usageCount: number;
}

export interface LicenseListResponse {
  data: License[];
  meta: {
    total: number;
    page: number;
    limit: number;
    pages: number;
  };
}

export interface UsageBucket {
  bucketStart: number;
  calls: number;
  revenue: number;
}

export interface UsageSeriesResponse {
  data: UsageBucket[];
  from: number;
  to: number;
  bucketSeconds: number;
}

export interface TopCaller {
  caller: string;
  calls: number;
  revenue: number;
  firstSeen: number;
  lastSeen: number;
}

export interface TopCallersResponse {
  data: TopCaller[];
  from: number;
  to: number;
}

export interface RevenueByLicenseType {
  licenseType: string;
  licenseCount: number;
  revenue: number;
}

export interface RevenueBreakdownResponse {
  data: RevenueByLicenseType[];
  totalRevenue: number;
}

export interface RemainingCallsResponse {
  activeLicenseCount: number;
  totalRemaining: number;
}

export interface TopUpResponse {
  license: License;
  amountCharged: number;
  callsAdded: number;
}
