import type { TopCaller } from "@/types/marketplace";
import { formatPrice, truncateAddress } from "@/lib/formatters";

function formatDate(ms: number): string {
  return new Date(ms).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

export default function TopCallersTable({ callers }: { callers: TopCaller[] }) {
  if (callers.length === 0) {
    return (
      <div className="rounded-xl border border-zinc-800 bg-zinc-900 p-6 text-sm text-zinc-500">
        No calls recorded in this window yet.
      </div>
    );
  }

  return (
    <div className="overflow-x-auto rounded-xl border border-zinc-800 bg-zinc-900">
      <table className="w-full text-left text-sm">
        <thead>
          <tr className="border-b border-zinc-800 text-xs uppercase tracking-wide text-zinc-500">
            <th scope="col" className="px-4 py-3 font-medium">
              Caller
            </th>
            <th scope="col" className="px-4 py-3 font-medium text-right">
              Calls
            </th>
            <th scope="col" className="px-4 py-3 font-medium text-right">
              Revenue
            </th>
            <th scope="col" className="px-4 py-3 font-medium text-right">
              First seen
            </th>
            <th scope="col" className="px-4 py-3 font-medium text-right">
              Last seen
            </th>
          </tr>
        </thead>
        <tbody>
          {callers.map((caller) => (
            <tr key={caller.caller} className="border-b border-zinc-800/60 last:border-0">
              <td className="px-4 py-3 font-mono text-zinc-300" title={caller.caller}>
                {truncateAddress(caller.caller)}
              </td>
              <td className="px-4 py-3 text-right font-semibold text-white [font-variant-numeric:tabular-nums]">
                {caller.calls.toLocaleString()}
              </td>
              <td className="px-4 py-3 text-right text-zinc-300 [font-variant-numeric:tabular-nums]">
                {formatPrice(caller.revenue)}
              </td>
              <td className="px-4 py-3 text-right text-zinc-500">{formatDate(caller.firstSeen)}</td>
              <td className="px-4 py-3 text-right text-zinc-500">{formatDate(caller.lastSeen)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
