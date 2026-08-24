import { getAssetTypeIcon } from "@/lib/formatters";

interface AssetTypeBadgeProps {
  type: string;
  variant?: "sm" | "md";
}

export function AssetTypeBadge({ type, variant = "md" }: AssetTypeBadgeProps) {
  const icon = getAssetTypeIcon(type);
  const label =
    type.charAt(0).toUpperCase() + type.slice(1);

  if (variant === "sm") {
    return (
      <span className="inline-flex items-center gap-1 text-xs text-zinc-400">
        <span>{icon}</span>
        {label}
      </span>
    );
  }

  return (
    <div className="inline-flex items-center gap-2 px-2 py-1 bg-zinc-800 rounded text-sm">
      <span>{icon}</span>
      <span className="text-zinc-300">{label}</span>
    </div>
  );
}
