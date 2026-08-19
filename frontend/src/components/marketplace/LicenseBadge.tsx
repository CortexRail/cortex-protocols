import { getLicenseColor } from "@/lib/formatters";
import { LicenseType } from "@/lib/api/assets";

interface LicenseBadgeProps {
  type: LicenseType;
}

export function LicenseBadge({ type }: LicenseBadgeProps) {
  return (
    <span className={`inline-block px-2 py-1 rounded text-xs font-semibold ${getLicenseColor(type)}`}>
      {type}
    </span>
  );
}
