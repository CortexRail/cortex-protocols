"use client";

import { useMemo } from "react";
import {
  BPS_DENOM,
  formatReputation,
  outcomeLabel,
  projectCurve,
  reputationTone,
  toPolylinePoints,
  type DisputeMarker,
  type ReputationTimelineData,
} from "@/lib/reputation";

const WIDTH = 640;
const HEIGHT = 200;
const PADDING = 12;

const TONE_STROKE: Record<ReturnType<typeof reputationTone>, string> = {
  high: "stroke-emerald-500",
  medium: "stroke-amber-500",
  low: "stroke-red-500",
};

interface Props {
  timeline: ReputationTimelineData | null;
  loading?: boolean;
}

/**
 * Reputation over time: the decay curve since the score was last settled on
 * chain, with a marker wherever a dispute was opened or resolved.
 */
export default function ReputationTimeline({ timeline, loading = false }: Props) {
  const geometry = useMemo(() => {
    if (!timeline || timeline.curve.length === 0) return null;

    const points = projectCurve(timeline.curve, {
      width: WIDTH,
      height: HEIGHT,
      padding: PADDING,
    });

    const first = timeline.curve[0].timestamp;
    const span = timeline.curve[timeline.curve.length - 1].timestamp - first || 1;
    const innerWidth = WIDTH - PADDING * 2;

    const markers = timeline.disputes
      .map((dispute) => {
        const at = dispute.resolvedAt ?? dispute.openedAt;
        const ratio = Math.min(Math.max((at - first) / span, 0), 1);
        return { dispute, x: PADDING + innerWidth * ratio };
      })
      .filter((marker) => Number.isFinite(marker.x));

    return { line: toPolylinePoints(points), markers };
  }, [timeline]);

  if (loading) {
    return (
      <section
        data-testid="reputation-timeline"
        className="rounded-xl border border-zinc-200 dark:border-zinc-800 p-5"
      >
        <p className="text-sm text-zinc-500 dark:text-zinc-400">Loading reputation history…</p>
      </section>
    );
  }

  if (!timeline || !geometry) {
    return (
      <section
        data-testid="reputation-timeline"
        className="rounded-xl border border-zinc-200 dark:border-zinc-800 p-5"
      >
        <h3 className="text-sm font-semibold">Reputation over time</h3>
        <p className="mt-2 text-sm text-zinc-500 dark:text-zinc-400">
          No reputation history has been indexed for this agent yet.
        </p>
      </section>
    );
  }

  const tone = reputationTone(timeline.currentReputation);
  const decayPerPeriod = ((BPS_DENOM - timeline.config.decayBps) / 100).toFixed(2);
  const periodDays = (timeline.config.decayPeriod / 86_400).toFixed(0);

  return (
    <section
      data-testid="reputation-timeline"
      className="rounded-xl border border-zinc-200 dark:border-zinc-800 p-5"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-sm font-semibold">Reputation over time</h3>
        <p className="text-xs text-zinc-500 dark:text-zinc-400">
          Decays {decayPerPeriod}% every {periodDays} day{periodDays === "1" ? "" : "s"} until the
          next on-chain update
        </p>
      </div>

      <div className="mt-3 flex items-baseline gap-3">
        <span className="text-2xl font-semibold tabular-nums">
          {formatReputation(timeline.currentReputation)}
        </span>
        {timeline.currentReputation !== timeline.baseReputation && (
          <span className="text-xs text-zinc-500 dark:text-zinc-400">
            settled at {formatReputation(timeline.baseReputation)}
          </span>
        )}
      </div>

      <svg
        role="img"
        aria-label="Reputation decay curve with dispute markers"
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        className="mt-4 w-full"
      >
        {[0.25, 0.5, 0.75].map((fraction) => (
          <line
            key={fraction}
            x1={PADDING}
            x2={WIDTH - PADDING}
            y1={PADDING + (HEIGHT - PADDING * 2) * fraction}
            y2={PADDING + (HEIGHT - PADDING * 2) * fraction}
            className="stroke-zinc-200 dark:stroke-zinc-800"
            strokeWidth={1}
          />
        ))}

        <polyline
          data-testid="reputation-curve"
          points={geometry.line}
          fill="none"
          strokeWidth={2}
          className={TONE_STROKE[tone]}
        />

        {geometry.markers.map(({ dispute, x }) => (
          <g key={dispute.id} data-testid={`dispute-marker-${dispute.id}`}>
            <line
              x1={x}
              x2={x}
              y1={PADDING}
              y2={HEIGHT - PADDING}
              strokeWidth={1}
              strokeDasharray="3 3"
              className={
                dispute.outcome === "guilty"
                  ? "stroke-red-500"
                  : "stroke-zinc-400 dark:stroke-zinc-600"
              }
            />
            <circle
              cx={x}
              cy={PADDING}
              r={4}
              className={
                dispute.outcome === "guilty"
                  ? "fill-red-500"
                  : "fill-zinc-400 dark:fill-zinc-600"
              }
            >
              <title>{markerTitle(dispute)}</title>
            </circle>
          </g>
        ))}
      </svg>

      {geometry.markers.length > 0 && (
        <ul className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-zinc-500 dark:text-zinc-400">
          {geometry.markers.map(({ dispute }) => (
            <li key={dispute.id}>
              <span className="font-medium text-zinc-700 dark:text-zinc-300">
                #{dispute.id}
              </span>{" "}
              {markerTitle(dispute)}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function markerTitle(dispute: DisputeMarker): string {
  const when = new Date(dispute.resolvedAt ?? dispute.openedAt).toLocaleDateString();
  const state = dispute.status === "open" ? "opened" : outcomeLabel(dispute.outcome);
  return `${state} · ${dispute.role} · ${when}`;
}
