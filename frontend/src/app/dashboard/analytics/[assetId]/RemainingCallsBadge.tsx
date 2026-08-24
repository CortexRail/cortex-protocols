interface RemainingCallsBadgeProps {
  remaining: number;
  sublabel: string;
}

/**
 * Compact stat badge — a large proportional-figure value with a label below,
 * reused for both the owner's aggregate runway and a buyer's own license.
 */
export default function RemainingCallsBadge({ remaining, sublabel }: RemainingCallsBadgeProps) {
  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-900 p-6">
      <p className="text-xs uppercase tracking-wide text-zinc-500">Remaining calls</p>
      <p className="mt-2 text-4xl font-semibold text-white">{remaining.toLocaleString()}</p>
      <p className="mt-1 text-sm text-zinc-400">{sublabel}</p>
    </div>
  );
}
