import { AssetType } from "@/lib/api/assets";
import { CategoryPageClient } from "./CategoryPageClient";

const ASSET_TYPES: AssetType[] = [
  "prompt",
  "workflow",
  "reasoning",
  "agent",
  "dataset",
  "model",
  "integration",
  "template",
];

export function generateStaticParams() {
  return ASSET_TYPES.map((type) => ({
    type,
  }));
}

export default async function CategoryPage({
  params,
}: {
  params: Promise<{ type: string }>;
}) {
  const { type } = await params;
  return <CategoryPageClient type={type as AssetType} />;
}
