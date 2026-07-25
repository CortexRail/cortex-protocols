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
