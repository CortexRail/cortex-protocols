/**
 * Reputation, staking, and dispute helpers for the agent profile.
 *
 * The decay math mirrors `backend/src/services/reputationEngine.js`, which in
 * turn mirrors `decay_score` in contracts/agent_registry/src/lib.rs: the score
 * is multiplied by `decayBps / 10000` once per whole elapsed period, truncating
 * on each step. Keeping the same loop here means a timeline rendered in the
 * browser lines up exactly with what the chain would report, rather than
 * drifting by a basis point or two.
 */

import { API_BASE_URL } from "./constants";

export const BPS_DENOM = 10_000;

/** Matches MAX_DECAY_PERIODS in the contract and the backend engine. */
export const MAX_DECAY_PERIODS = 730;

export interface DecayConfig {
  slashBps: number;
  votingWindow: number;
  quorumWeight: number;
  decayBps: number;
  decayPeriod: number;
}

export const DEFAULT_DECAY_CONFIG: DecayConfig = {
  slashBps: 2_000,
  votingWindow: 259_200,
  quorumWeight: 1_000,
  decayBps: 9_900,
  decayPeriod: 86_400,
};

export type DisputeStatus = "open" | "resolved";
export type DisputeOutcome = "guilty" | "not_guilty" | "quorum_failed";
export type DisputeRole = "respondent" | "complainant";

export interface DisputeMarker {
  id: number;
  status: DisputeStatus;
  outcome: DisputeOutcome | null;
  openedAt: number;
  resolvedAt: number | null;
  slashedAmount: number;
  role: DisputeRole;
}

export interface StakeSummary {
  agentAddress: string;
  amount: number;
  slashed: number;
}

export interface CurvePoint {
  timestamp: number;
  score: number;
}

export interface ReputationTimelineData {
  agentId: number;
  owner: string;
  baseReputation: number;
  currentReputation: number;
  reputationUpdatedAt: number | null;
  config: DecayConfig;
  curve: CurvePoint[];
  disputes: DisputeMarker[];
  stake: StakeSummary;
}

export interface Dispute {
  id: number;
  complainant: string;
  respondent: string;
  evidenceHash: string;
  evidence: unknown;
  status: DisputeStatus;
  outcome: DisputeOutcome | null;
  weightFor: number;
  weightAgainst: number;
  slashedAmount: number;
  openedAt: number;
  closesAt: number | null;
  resolvedAt: number | null;
}

export interface Paginated<T> {
  data: T[];
  meta: { total: number; page: number; limit: number; pages: number };
}

// ── Decay math ───────────────────────────────────────────────────────────────

/** `base * (decayBps / 10000) ^ periods`, truncating each period. */
export function decayScore(
  base: number,
  elapsedSeconds: number,
  config: DecayConfig = DEFAULT_DECAY_CONFIG
): number {
  const start = Math.trunc(base) || 0;
  const elapsed = Math.trunc(elapsedSeconds) || 0;

  if (
    start <= 0 ||
    elapsed <= 0 ||
    config.decayPeriod <= 0 ||
    config.decayBps >= BPS_DENOM
  ) {
    return Math.max(start, 0);
  }

  const periods = Math.min(
    Math.floor(elapsed / config.decayPeriod),
    MAX_DECAY_PERIODS
  );

  let score = start;
  for (let applied = 0; applied < periods && score > 0; applied += 1) {
    score = Math.floor((score * config.decayBps) / BPS_DENOM);
  }
  return score;
}

/** What a base score settled at `settledAt` is worth at `nowMs`. */
export function currentReputation(
  base: number,
  settledAt: number | null,
  nowMs: number = Date.now(),
  config: DecayConfig = DEFAULT_DECAY_CONFIG
): number {
  if (!settledAt) return Math.max(Math.trunc(base) || 0, 0);
  return decayScore(base, Math.floor((nowMs - settledAt) / 1000), config);
}

// ── Formatting ───────────────────────────────────────────────────────────────

/** Basis points → a percentage string, e.g. 4517 → "45.17%". */
export function formatReputation(bps: number): string {
  const safe = Math.max(Math.trunc(bps) || 0, 0);
  return `${(safe / 100).toFixed(2)}%`;
}

/** Coarse band used to colour a score. */
export function reputationTone(bps: number): "high" | "medium" | "low" {
  if (bps >= 7_000) return "high";
  if (bps >= 4_000) return "medium";
  return "low";
}

/** Stroops → XLM, trimmed of trailing zeros. */
export function formatStake(stroops: number): string {
  const xlm = (Math.max(Math.trunc(stroops) || 0, 0) / 10_000_000).toFixed(7);
  return xlm.replace(/\.?0+$/, "") || "0";
}

export function outcomeLabel(outcome: DisputeOutcome | null): string {
  switch (outcome) {
    case "guilty":
      return "Guilty";
    case "not_guilty":
      return "Not guilty";
    case "quorum_failed":
      return "No quorum";
    default:
      return "Pending";
  }
}

/** Human-readable time left before voting closes. */
export function timeRemaining(closesAt: number | null, nowMs: number = Date.now()): string {
  if (!closesAt) return "—";
  const seconds = Math.floor((closesAt - nowMs) / 1000);
  if (seconds <= 0) return "Voting closed";

  const days = Math.floor(seconds / 86_400);
  if (days > 0) return `${days}d ${Math.floor((seconds % 86_400) / 3_600)}h left`;

  const hours = Math.floor(seconds / 3_600);
  if (hours > 0) return `${hours}h ${Math.floor((seconds % 3_600) / 60)}m left`;

  return `${Math.max(Math.floor(seconds / 60), 1)}m left`;
}

/** Share of the weighted vote that sided against the respondent, 0–1. */
export function voteShare(dispute: Pick<Dispute, "weightFor" | "weightAgainst">): number {
  const total = dispute.weightFor + dispute.weightAgainst;
  if (total <= 0) return 0;
  return dispute.weightFor / total;
}

// ── Chart geometry ───────────────────────────────────────────────────────────

export interface ChartBox {
  width: number;
  height: number;
  padding?: number;
}

/**
 * Project curve points onto an SVG viewbox. The y-axis is fixed to 0–10000
 * basis points so two agents' charts can be compared side by side.
 */
export function projectCurve(points: CurvePoint[], box: ChartBox): Array<{ x: number; y: number }> {
  const padding = box.padding ?? 0;
  const innerWidth = Math.max(box.width - padding * 2, 1);
  const innerHeight = Math.max(box.height - padding * 2, 1);

  if (points.length === 0) return [];
  if (points.length === 1) {
    return [{ x: padding, y: padding + innerHeight * (1 - points[0].score / BPS_DENOM) }];
  }

  const first = points[0].timestamp;
  const span = points[points.length - 1].timestamp - first || 1;

  return points.map((point) => ({
    x: padding + (innerWidth * (point.timestamp - first)) / span,
    y: padding + innerHeight * (1 - Math.min(point.score, BPS_DENOM) / BPS_DENOM),
  }));
}

/** An SVG polyline `points` attribute for a projected curve. */
export function toPolylinePoints(points: Array<{ x: number; y: number }>): string {
  return points.map((p) => `${round(p.x)},${round(p.y)}`).join(" ");
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

// ── API ──────────────────────────────────────────────────────────────────────

async function getJson<T>(path: string): Promise<T | null> {
  try {
    const res = await fetch(`${API_BASE_URL}${path}`);
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

export function fetchReputationTimeline(
  agentId: string | number
): Promise<ReputationTimelineData | null> {
  return getJson<ReputationTimelineData>(`/api/v1/agents/${agentId}/reputation-timeline`);
}

export function fetchAgentDisputes(address: string): Promise<Paginated<Dispute> | null> {
  return getJson<Paginated<Dispute>>(`/api/v1/disputes/agent/${address}`);
}

export interface FileDisputeInput {
  id: number;
  complainant: string;
  respondent: string;
  evidence: unknown;
}

export interface FileDisputeResult {
  ok: boolean;
  dispute?: Dispute;
  error?: string;
}

/** Index a dispute opened on-chain, uploading its evidence bundle. */
export async function fileDispute(input: FileDisputeInput): Promise<FileDisputeResult> {
  try {
    const res = await fetch(`${API_BASE_URL}/api/v1/disputes`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });

    const payload = (await res.json().catch(() => null)) as
      | (Dispute & { error?: string })
      | null;

    if (!res.ok) {
      return { ok: false, error: payload?.error ?? `Request failed (${res.status})` };
    }
    return { ok: true, dispute: payload as Dispute };
  } catch {
    return { ok: false, error: "Could not reach the backend. Is the API server running?" };
  }
}

/** Upload (or replace) an evidence bundle; returns the digest to commit on-chain. */
export async function submitEvidence(
  disputeId: number,
  evidence: unknown
): Promise<{ ok: boolean; evidenceHash?: string; error?: string }> {
  try {
    const res = await fetch(`${API_BASE_URL}/api/v1/disputes/${disputeId}/evidence`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ evidence }),
    });

    const payload = (await res.json().catch(() => null)) as
      | { evidenceHash?: string; error?: string }
      | null;

    if (!res.ok) {
      return { ok: false, error: payload?.error ?? `Request failed (${res.status})` };
    }
    return { ok: true, evidenceHash: payload?.evidenceHash };
  } catch {
    return { ok: false, error: "Could not reach the backend. Is the API server running?" };
  }
}
