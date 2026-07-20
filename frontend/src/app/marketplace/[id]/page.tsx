import AssetDetail from "@/components/marketplace/AssetDetail";

export default async function MarketplaceAssetPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <AssetDetail assetId={id} />;
}
