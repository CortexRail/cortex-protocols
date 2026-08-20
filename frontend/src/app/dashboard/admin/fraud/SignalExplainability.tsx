"use client";

/**
 * Why a signal fired.
 *
 * The acceptance criterion for this feature is that every automated flag
 * carries a human-readable explanation and never a bare score, so the
 * explanation text leads and the numbers support it — not the other way round.
 *
 * Two evidence shapes arrive here. A composite carries the per-detector
 * breakdown that AnomalyScorer produced; a raw detector signal carries that
 * one detector's own summary, metrics, and sample rows. Both are rendered.
 */

export interface DetectorPart {
  detector: string;
  rawScore: number;
  weight: number;
  contribution: number;
  summary: string;
  metrics?: Record<string, unknown>;
}

export interface SignalEvidence {
  /* composite */
  base?: number;
  corroboration?: number;
  detectorCount?: number;
  weights?: Record<string, number>;
  signals?: DetectorPart[];
  /* raw detector */
  summary?: string;
  metrics?: Record<string, unknown>;
  samples?: Array<Record<string, unknown>>;
}

export interface FraudSignal {
  id: number;
  detector: string;
  agentAddress: string;
  assetId: number | null;
  score: number;
  riskTier: "low" | "medium" | "high" | "critical";
  explanation: string;
  evidence: SignalEvidence;
  status: "open" | "dismissed" | "reported";
  reportId: number | null;
  dismissedBy: string | null;
  dismissReason: string | null;
  windowStart: number;
  windowEnd: number;
  createdAt: number;
  asset?: { id: number; name: string; owner: string } | null;
}

const TIER_STYLES: Record<FraudSignal["riskTier"], string> = {
  critical: "bg-red-500/10 border-red-500/40 text-red-600 dark:text-red-400",
  high: "bg-orange-500/10 border-orange-500/40 text-orange-600 dark:text-orange-400",
  medium: "bg-yellow-500/10 border-yellow-500/40 text-yellow-700 dark:text-yellow-400",
  low: "bg-zinc-500/10 border-zinc-500/40 text-zinc-600 dark:text-zinc-400",
};

export function RiskTierBadge({ tier }: { tier: FraudSignal["riskTier"] }) {
  return (
    <span
      data-testid="risk-tier"
      className={`px-2 py-0.5 rounded border text-xs font-semibold uppercase tracking-wide ${TIER_STYLES[tier]}`}
    >
      {tier}
    </span>
  );
}

function formatMetric(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "number") {
    // The `\.?` matters: without it a value that rounds to 1.0000 renders as
    // "1." — the trailing zeros go, the dot stays behind.
    return Number.isInteger(value) ? String(value) : value.toFixed(4).replace(/\.?0+$/, "");
  }
  if (Array.isArray(value)) return value.join(", ");
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function MetricGrid({ metrics }: { metrics: Record<string, unknown> }) {
  const entries = Object.entries(metrics).filter(
    ([, value]) => typeof value !== "object" || value === null || Array.isArray(value)
  );
  if (entries.length === 0) return null;

  return (
    <dl className="grid grid-cols-2 gap-x-6 gap-y-1 mt-2 text-xs">
      {entries.map(([key, value]) => (
        <div key={key} className="flex justify-between gap-3 border-b border-[var(--border)] py-1">
          <dt className="text-[var(--muted)]">{key}</dt>
          <dd className="font-mono text-[var(--foreground)]">{formatMetric(value)}</dd>
        </div>
      ))}
    </dl>
  );
}

export default function SignalExplainability({ signal }: { signal: FraudSignal }) {
  const evidence = signal.evidence ?? {};
  const parts = evidence.signals ?? [];

  return (
    <section data-testid="signal-explainability" className="space-y-5">
      <header className="flex items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-3 mb-2">
            <RiskTierBadge tier={signal.riskTier} />
            <span className="font-mono text-sm text-[var(--muted)]">
              {signal.detector} · score {signal.score.toFixed(2)}
            </span>
          </div>
          <p className="font-mono text-xs text-[var(--muted)] break-all">{signal.agentAddress}</p>
        </div>
        {signal.status !== "open" && (
          <span className="text-xs text-[var(--muted)] uppercase tracking-wide">{signal.status}</span>
        )}
      </header>

      {/* The explanation itself, verbatim from the backend. */}
      <div className="p-4 bg-zinc-100 dark:bg-zinc-900 border border-[var(--border)] rounded-lg">
        <h3 className="text-xs uppercase tracking-widest text-[var(--muted)] mb-2">Why this fired</h3>
        <p
          data-testid="signal-explanation"
          className="text-sm text-[var(--foreground)] whitespace-pre-line leading-relaxed"
        >
          {signal.explanation}
        </p>
      </div>

      {/* Composite: which detectors agreed, and how much each contributed. */}
      {parts.length > 0 && (
        <div className="p-4 bg-zinc-100 dark:bg-zinc-900 border border-[var(--border)] rounded-lg">
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-xs uppercase tracking-widest text-[var(--muted)]">Detectors that fired</h3>
            {typeof evidence.corroboration === "number" && (
              <p className="text-xs text-[var(--muted)]">
                {evidence.detectorCount} detector{evidence.detectorCount === 1 ? "" : "s"} ·
                weighted mean {evidence.base?.toFixed(2)} ×{evidence.corroboration.toFixed(2)}
              </p>
            )}
          </div>

          <ul className="space-y-3">
            {parts.map((part) => (
              <li
                key={part.detector}
                data-testid="detector-part"
                className="p-3 bg-white/60 dark:bg-black/40 border border-[var(--border)] rounded"
              >
                <div className="flex items-center justify-between gap-4 mb-1">
                  <span className="font-mono text-sm text-purple-700 dark:text-purple-300">{part.detector}</span>
                  <span className="text-xs text-[var(--muted)] font-mono">
                    {part.rawScore.toFixed(2)} × weight {part.weight}
                  </span>
                </div>
                <p className="text-sm text-[var(--foreground)]">{part.summary}</p>
                {part.metrics && <MetricGrid metrics={part.metrics} />}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Raw detector signal: its own metrics and the rows behind them. */}
      {parts.length === 0 && evidence.metrics && (
        <div className="p-4 bg-zinc-100 dark:bg-zinc-900 border border-[var(--border)] rounded-lg">
          <h3 className="text-xs uppercase tracking-widest text-[var(--muted)] mb-1">Measurements</h3>
          <MetricGrid metrics={evidence.metrics} />
        </div>
      )}

      {evidence.samples && evidence.samples.length > 0 && (
        <div className="p-4 bg-zinc-100 dark:bg-zinc-900 border border-[var(--border)] rounded-lg">
          <h3 className="text-xs uppercase tracking-widest text-[var(--muted)] mb-2">Evidence</h3>
          <ul data-testid="evidence-samples" className="space-y-1">
            {evidence.samples.map((sample, i) => (
              <li key={i} className="font-mono text-xs text-[var(--muted)] break-all">
                {Object.entries(sample)
                  .map(([key, value]) => `${key}=${formatMetric(value)}`)
                  .join("  ")}
              </li>
            ))}
          </ul>
        </div>
      )}

      {signal.dismissReason && (
        <p className="text-xs text-[var(--muted)]">
          Dismissed by {signal.dismissedBy}: {signal.dismissReason}
        </p>
      )}
    </section>
  );
}
