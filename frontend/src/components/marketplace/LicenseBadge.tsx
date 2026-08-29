import { getLicenseColor } from "@/lib/formatters";

interface LicenseBadgeProps {
  type: string;
}

export function LicenseBadge({ type }: LicenseBadgeProps) {
  return (
    <span className={`inline-block px-2 py-1 rounded text-xs font-semibold ${getLicenseColor(type)}`}>
      {type}
    </span>
  );
}
