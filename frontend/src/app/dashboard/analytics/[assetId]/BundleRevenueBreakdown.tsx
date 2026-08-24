import type { RevenueByLicenseType } from "@/types/marketplace";
import { formatPrice } from "@/lib/formatters";

// Fixed categorical slots (dark-mode steps from the validated default
// palette) assigned by license type, never reassigned by sort order — a
// license type always wears the same color across renders and filters.
// There is no separate "bundle" concept in this system: license type is the
// only revenue segmentation that actually exists (see backend analyticsRepository).
const LICENSE_TYPE_COLOR: Record<string, string> = {
  Perpetual: "#3987e5", // categorical slot 1 (blue)
  UsageBased: "#d95926", // categorical slot 2 (orange)
  Subscription: "#199e70", // categorical slot 3 (aqua)
  OpenSource: "#c98500", // categorical slot 4 (yellow)
};
const FALLBACK_COLOR = "#898781"; // muted — any license type outside the fixed set

function colorFor(licenseType: string): string {
  return LICENSE_TYPE_COLOR[licenseType] ?? FALLBACK_COLOR;
}

interface BundleRevenueBreakdownProps {
  data: RevenueByLicenseType[];
  totalRevenue: number;
}

export default function BundleRevenueBreakdown({ data, totalRevenue }: BundleRevenueBreakdownProps) {
  if (data.length === 0 || totalRevenue === 0) {
    return (
      <div className="rounded-xl border border-zinc-800 bg-zinc-900 p-6 text-sm text-zinc-500">
        No revenue recorded for this asset yet.
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-900 p-6">
      <div className="flex items-baseline justify-between">
        <h3 className="text-sm font-semibold text-zinc-300">Revenue by license type</h3>
        <p className="text-lg font-semibold text-white">{formatPrice(totalRevenue)}</p>
      </div>

      {/* Part-to-whole bar: one segment per license type, 2px surface gaps
          between touching segments (the mechanism that separates them, not
          a border). */}
      <div className="mt-4 flex h-6 gap-[2px] overflow-hidden rounded-md" role="img" aria-label="Revenue by license type">
        {data.map((row) => (
          <div
            key={row.licenseType}
            style={{
              width: `${Math.max((row.revenue / totalRevenue) * 100, 1)}%`,
              backgroundColor: colorFor(row.licenseType),
            }}
            title={`${row.licenseType}: ${formatPrice(row.revenue)}`}
          />
        ))}
      </div>

      <ul className="mt-4 space-y-2">
        {data.map((row) => (
          <li key={row.licenseType} className="flex items-center justify-between text-sm">
            <span className="flex items-center gap-2 text-zinc-300">
              <span
                className="h-2.5 w-2.5 shrink-0 rounded-sm"
                style={{ backgroundColor: colorFor(row.licenseType) }}
                aria-hidden="true"
              />
              {row.licenseType}
              <span className="text-zinc-500">
                ({row.licenseCount} {row.licenseCount === 1 ? "license" : "licenses"})
              </span>
            </span>
            <span className="font-semibold text-white [font-variant-numeric:tabular-nums]">
              {formatPrice(row.revenue)}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
