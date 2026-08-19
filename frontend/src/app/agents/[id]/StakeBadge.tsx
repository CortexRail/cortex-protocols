"use client";

import { formatStake, type StakeSummary } from "@/lib/reputation";

interface Props {
  stake: StakeSummary | null;
}

/**
 * Collateral an agent has locked against its reputation, plus what it has
 * already lost to slashing.
 */
export default function StakeBadge({ stake }: Props) {
  const amount = stake?.amount ?? 0;
  const slashed = stake?.slashed ?? 0;

  if (amount === 0 && slashed === 0) {
    return (
      <span
        data-testid="stake-badge"
        className="inline-flex items-center gap-1.5 rounded-full border border-zinc-200 dark:border-zinc-800 px-3 py-1 text-xs text-zinc-500 dark:text-zinc-400"
      >
        No stake
      </span>
    );
  }

  return (
    <span
      data-testid="stake-badge"
      title={slashed > 0 ? `${formatStake(slashed)} XLM slashed to date` : undefined}
      className="inline-flex items-center gap-2 rounded-full border border-emerald-200 dark:border-emerald-900 bg-emerald-50 dark:bg-emerald-950/40 px-3 py-1 text-xs"
    >
      <span className="font-medium text-emerald-700 dark:text-emerald-300 tabular-nums">
        {formatStake(amount)} XLM staked
      </span>
      {slashed > 0 && (
        <span className="text-red-600 dark:text-red-400 tabular-nums">
          −{formatStake(slashed)} slashed
        </span>
      )}
    </span>
  );
}
