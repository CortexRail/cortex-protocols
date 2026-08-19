import Link from "next/link";
import { Asset } from "@/lib/api/assets";
import { AssetTypeBadge } from "./AssetTypeBadge";
import { LicenseBadge } from "./LicenseBadge";
import { PriceDisplay } from "./PriceDisplay";
import { truncateText, formatCompactNumber, getReputationColor, getReputationBg } from "@/lib/formatters";

interface AssetCardProps {
  asset: Asset;
}

export function AssetCard({ asset }: AssetCardProps) {
  return (
    <Link href={`/marketplace/${asset.id}`}>
      <div className="group h-full p-5 bg-zinc-900 border border-zinc-800 rounded-lg hover:border-purple-500 transition-colors cursor-pointer">
        {/* Header with type and license */}
        <div className="flex items-start justify-between mb-3 gap-2">
          <AssetTypeBadge type={asset.type} variant="sm" />
          <LicenseBadge type={asset.licenseType} />
        </div>

        {/* Name */}
        <h3 className="text-lg font-bold mb-2 group-hover:text-purple-400 transition-colors line-clamp-2">
          {asset.name}
        </h3>

        {/* Description */}
        <p className="text-sm text-zinc-400 mb-4 line-clamp-2">
          {truncateText(asset.description, 90)}
        </p>

        {/* Owner and stats */}
        <div className="mb-4 pb-4 border-t border-zinc-800">
          <div className="flex items-center justify-between mt-3">
            <div>
              <p className="text-xs text-zinc-500 mb-1">Owner</p>
              <p className="text-sm font-semibold text-zinc-300">{asset.owner.name}</p>
            </div>
            <div className={`text-xs font-semibold px-2 py-1 rounded ${getReputationBg(asset.owner.reputation)} ${getReputationColor(asset.owner.reputation)}`}>
              {Math.round(asset.owner.reputation)}%
            </div>
          </div>
        </div>

        {/* Usage and price footer */}
        <div className="flex items-end justify-between">
          <div>
            <p className="text-xs text-zinc-500 mb-1">Used</p>
            <p className="text-sm font-semibold">
              {formatCompactNumber(asset.usageCount)} times
            </p>
          </div>
          <PriceDisplay priceInStroops={asset.priceInStroops} showLabel={false} />
        </div>
      </div>
    </Link>
  );
}
