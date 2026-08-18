"use client";

import Link from "next/link";
import {
  formatStake,
  outcomeLabel,
  timeRemaining,
  voteShare,
  type Dispute,
} from "@/lib/reputation";

interface Props {
  agentId: string;
  owner: string;
  disputes: Dispute[];
  loading?: boolean;
}

/**
 * Disputes involving this agent — open ones first, with the weighted tally and
 * how long is left to vote, then the resolved history.
 */
export default function DisputeList({ agentId, owner, disputes, loading = false }: Props) {
  const open = disputes.filter((dispute) => dispute.status === "open");
  const resolved = disputes.filter((dispute) => dispute.status !== "open");

  return (
    <section
      data-testid="dispute-list"
      className="rounded-xl border border-zinc-200 dark:border-zinc-800 p-5"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-semibold">Disputes</h3>
        <Link
          href={`/agents/${agentId}/disputes/new`}
          className="rounded-lg bg-black dark:bg-white px-3 py-1.5 text-xs font-medium text-white dark:text-black"
        >
          File a dispute
        </Link>
      </div>

      {loading && (
        <p className="mt-3 text-sm text-zinc-500 dark:text-zinc-400">Loading disputes…</p>
      )}

      {!loading && disputes.length === 0 && (
        <p className="mt-3 text-sm text-zinc-500 dark:text-zinc-400">
          No disputes have been filed against this agent.
        </p>
      )}

      {open.length > 0 && (
        <div className="mt-4">
          <h4 className="text-xs font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
            Open
          </h4>
          <ul className="mt-2 space-y-2">
            {open.map((dispute) => (
              <li
                key={dispute.id}
                data-testid={`dispute-${dispute.id}`}
                className="rounded-lg border border-amber-200 dark:border-amber-900 bg-amber-50 dark:bg-amber-950/30 p-3"
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="text-sm font-medium">Dispute #{dispute.id}</span>
                  <span className="text-xs text-amber-700 dark:text-amber-300">
                    {timeRemaining(dispute.closesAt)}
                  </span>
                </div>
                <p className="mt-1 text-xs text-zinc-600 dark:text-zinc-400">
                  {dispute.respondent === owner ? "Filed against this agent by" : "Filed by this agent against"}{" "}
                  <span className="font-mono">
                    {truncate(dispute.respondent === owner ? dispute.complainant : dispute.respondent)}
                  </span>
                </p>
                <div className="mt-2">
                  <div className="h-1.5 w-full overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-800">
                    <div
                      className="h-full bg-red-500"
                      style={{ width: `${Math.round(voteShare(dispute) * 100)}%` }}
                    />
                  </div>
                  <p className="mt-1 text-[11px] text-zinc-500 dark:text-zinc-400 tabular-nums">
                    {dispute.weightFor} for · {dispute.weightAgainst} against
                  </p>
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}

      {resolved.length > 0 && (
        <div className="mt-4">
          <h4 className="text-xs font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
            Resolved
          </h4>
          <ul className="mt-2 space-y-2">
            {resolved.map((dispute) => (
              <li
                key={dispute.id}
                data-testid={`dispute-${dispute.id}`}
                className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-zinc-200 dark:border-zinc-800 p-3"
              >
                <span className="text-sm">Dispute #{dispute.id}</span>
                <span
                  className={`rounded-full px-2 py-0.5 text-xs ${
                    dispute.outcome === "guilty"
                      ? "bg-red-100 dark:bg-red-950/50 text-red-700 dark:text-red-300"
                      : "bg-zinc-100 dark:bg-zinc-900 text-zinc-600 dark:text-zinc-400"
                  }`}
                >
                  {outcomeLabel(dispute.outcome)}
                </span>
                {dispute.slashedAmount > 0 && (
                  <span className="text-xs text-red-600 dark:text-red-400 tabular-nums">
                    −{formatStake(dispute.slashedAmount)} XLM slashed
                  </span>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

function truncate(address: string): string {
  return address.length > 12 ? `${address.slice(0, 6)}…${address.slice(-4)}` : address;
}
