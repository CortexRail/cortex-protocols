import { formatPrice } from "@/lib/formatters";

interface PriceDisplayProps {
  priceInStroops: number;
  showLabel?: boolean;
}

export function PriceDisplay({ priceInStroops, showLabel = true }: PriceDisplayProps) {
  const price = formatPrice(priceInStroops);

  return (
    <div className={showLabel ? "flex flex-col" : ""}>
      {showLabel && <span className="text-xs text-zinc-500 mb-1">Price</span>}
      <span className="font-semibold text-lg text-purple-400">{price}</span>
    </div>
  );
}
