/**
 * Fraud service — runs the detector pipeline over a rolling window, persists
 * what it finds, and routes the serious findings into moderation.
 *
 * One scan cycle:
 *
 *   1. build the relationship graph once and share it with every detector
 *      that needs it (sybil and wash both walk the same graph)
 *   2. run each detector, isolating failures so one broken detector cannot
 *      blank the whole queue
 *   3. combine the raw signals into per-agent/asset composites
 *   4. persist raw signals and composites (idempotent: a re-scan over an
 *      overlapping window refreshes rows rather than duplicating them)
 *   5. file an automated moderation report for every high/critical composite
 *      that names an asset
 *
 * Everything is injected through `deps` so the backtest harness can run the
 * exact production pipeline against synthetic repositories.
 */

const { randomUUID } = require("crypto");

const fraudConfig = require("../config/fraud");
const { buildGraph, subgraphFor } = require("../fraud/graph");
const VelocityDetector = require("../fraud/VelocityDetector");
const SybilGraphDetector = require("../fraud/SybilGraphDetector");
const WashUsageDetector = require("../fraud/WashUsageDetector");
const ReplayAbuseDetector = require("../fraud/ReplayAbuseDetector");
const AnomalyScorer = require("../fraud/AnomalyScorer");

const usageEventRepository = require("../repositories/usageEventRepository");
const streamRepository = require("../repositories/streamRepository");
const licenseRepository = require("../repositories/licenseRepository");
const agentFundingRepository = require("../repositories/agentFundingRepository");
const assetRepository = require("../repositories/assetRepository");
const agentRepository = require("../repositories/agentRepository");
const fraudSignalRepository = require("../repositories/fraudSignalRepository");
const reportService = require("./reportService");
const { AuditLogWriter, EVENT_TYPES } = require("../audit/AuditLogWriter");

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

/** Tiers that earn a moderation report rather than just a queue entry. */
const REPORTABLE_TIERS = new Set(["high", "critical"]);

const DETECTORS = [
  VelocityDetector,
  SybilGraphDetector,
  WashUsageDetector,
  ReplayAbuseDetector,
];

function defaultDeps() {
  return {
    usageEventRepository,
    streamRepository,
    licenseRepository,
    agentFundingRepository,
    assetRepository,
    agentRepository,
    fraudSignalRepository,
    reportService,
  };
}

/**
 * The rolling window a scan covers, as epoch ms.
 */
function resolveWindow({ lookbackHours, now = Date.now() } = {}, config) {
  const hours = Number(lookbackHours) || config.window.lookbackHours;
  return { from: now - hours * 3_600_000, to: now };
}

/**
 * Persist one raw detector signal.
 *
 * Detector signals carry a summary rather than a full explanation; the
 * fraud_signals CHECK rejects an empty one, so a detector that forgot to write
 * a summary still gets a usable sentence instead of a failed insert.
 */
function rawSignalRow(signal, { scanId, window, config }) {
  const explanation =
    (signal.evidence && signal.evidence.summary) ||
    `${signal.detector} fired on ${signal.agentAddress} with score ${signal.rawScore}.`;

  return {
    scanId,
    detector: signal.detector,
    agentAddress: signal.agentAddress,
    assetId: signal.assetId ?? null,
    score: signal.rawScore,
    riskTier: AnomalyScorer.riskTierFor(signal.rawScore, config.scorer.tiers),
    evidence: signal.evidence || {},
    explanation,
    windowStart: window.from,
    windowEnd: window.to,
  };
}

/**
 * Run every detector, isolating failures.
 *
 * @returns {{signals: Array, errors: Array, counts: object}}
 */
async function runDetectors(window, deps, config) {
  const signals = [];
  const errors = [];
  const counts = {};

  for (const detector of DETECTORS) {
    try {
      const found = await detector.detect(window, deps, config);
      counts[detector.DETECTOR] = found.length;
      signals.push(...found);
    } catch (err) {
      // A detector that throws is an operational problem, not a reason to
      // discard the findings of the other three.
      counts[detector.DETECTOR] = 0;
      errors.push({ detector: detector.DETECTOR, message: err.message });
    }
  }

  return { signals, errors, counts };
}

/**
 * Run one scan cycle.
 *
 * @param {object} [options]
 * @param {number} [options.lookbackHours]
 * @param {number} [options.now] - evaluation time, epoch ms
 * @param {boolean} [options.dryRun] - score but write nothing
 * @param {object} [options.deps]
 * @param {object} [options.config]
 * @returns {Promise<object>} scan summary
 */
async function runScan({
  lookbackHours,
  now = Date.now(),
  dryRun = false,
  deps = defaultDeps(),
  config = fraudConfig.getConfig(),
} = {}) {
  const startedAt = Date.now();
  const scanId = randomUUID();
  const window = resolveWindow({ lookbackHours, now }, config);

  // One graph for the whole cycle: sybil and wash would otherwise each pull
  // the same three edge queries.
  const [streams, licenses, usage] = await Promise.all([
    deps.streamRepository.edgesInWindow(window),
    deps.licenseRepository.edgesInWindow(window),
    deps.usageEventRepository.edgesInWindow(window),
  ]);
  const graph = buildGraph({ streams, licenses, usage });

  const detectorDeps = { ...deps, graph };
  const { signals, errors, counts } = await runDetectors(window, detectorDeps, config);

  const composites = AnomalyScorer.score(signals, window, config);

  const tiers = { low: 0, medium: 0, high: 0, critical: 0 };
  for (const composite of composites) tiers[composite.riskTier] += 1;

  const summary = {
    scanId,
    window,
    dryRun,
    graph: { nodes: graph.nodes.size, edges: graph.edges.size, components: graph.components.length },
    detectorCounts: counts,
    rawSignals: signals.length,
    composites: composites.length,
    tiers,
    reportsRouted: 0,
    // Same array by reference, on purpose: the report-routing catch below pushes
    // into `errors` after this object exists, and those failures must reach the
    // summary (the CLI exits 2 on a non-empty list). Do not copy it here.
    errors,
    durationMs: 0,
  };

  if (dryRun) {
    summary.durationMs = Date.now() - startedAt;
    // A dry run is for an operator eyeballing what a scan *would* do.
    summary.preview = composites.slice(0, 20);
    return summary;
  }

  // ── Persist ────────────────────────────────────────────────────────────────
  for (const signal of signals) {
    await deps.fraudSignalRepository.upsertActive(
      rawSignalRow(signal, { scanId, window, config })
    );
  }

  for (const composite of composites) {
    // sourceSignals is scoring context, not a database column.
    const { sourceSignals, ...row } = composite;
    void sourceSignals;

    const stored = await deps.fraudSignalRepository.upsertActive({ ...row, scanId });

    if (!REPORTABLE_TIERS.has(composite.riskTier)) continue;

    // `reports.asset_id` is NOT NULL, so an address-only finding (a sybil
    // cluster with no asset attached) has nothing to file against. It stays
    // in the fraud queue for an operator to pick up.
    if (composite.assetId === null || composite.assetId === undefined) continue;

    try {
      const { report } = await deps.reportService.fileAutomatedReport({
        assetId: composite.assetId,
        explanation: composite.explanation,
        evidence: composite.evidence,
      });

      await deps.fraudSignalRepository.attachReport(stored.id, report.id);
      summary.reportsRouted += 1;
    } catch (err) {
      // A report that fails to file (deleted asset, paused table) must not
      // abort the rest of the scan. The signal stays open and the next cycle
      // retries it.
      errors.push({
        detector: "report-routing",
        message: `asset ${composite.assetId}: ${err.message}`,
      });
    }
  }

  summary.durationMs = Date.now() - startedAt;
  return summary;
}

/**
 * Current state of the fraud queue, for the CLI and the admin dashboard.
 */
async function getScanStats({ deps = defaultDeps() } = {}) {
  const [tiers, recent] = await Promise.all([
    deps.fraudSignalRepository.countsByTier(),
    deps.fraudSignalRepository.findAll(
      { status: "open", sort: "recent" },
      { page: 1, limit: 10 }
    ),
  ]);

  return {
    openByTier: tiers,
    openTotal: Object.values(tiers).reduce((sum, count) => sum + count, 0),
    recent: recent.data,
  };
}

// ── Admin surface ────────────────────────────────────────────────────────────

/**
 * The fraud queue, with the related asset attached to each signal.
 *
 * Mirrors reportService.listReportsForAdmin: the dashboard renders an asset
 * name next to a finding, and making it fetch each asset separately would turn
 * one page load into a request per row.
 */
async function listSignals({
  status,
  detector,
  riskTier,
  agentAddress,
  assetId,
  minScore,
  scanId,
  sort,
  page = 1,
  limit = 20,
  deps = defaultDeps(),
} = {}) {
  const result = await deps.fraudSignalRepository.findAll(
    { status, detector, riskTier, agentAddress, assetId, minScore, scanId, sort },
    { page, limit }
  );

  const assetIds = [...new Set(result.data.map((s) => s.assetId).filter((id) => id !== null))];
  const assets = await Promise.all(
    assetIds.map((id) => deps.assetRepository.findById(id, { includeInactive: true }))
  );
  const assetById = new Map(assets.filter(Boolean).map((asset) => [asset.id, asset]));

  return {
    ...result,
    data: result.data.map((signal) => ({
      ...signal,
      asset: signal.assetId === null ? null : assetById.get(signal.assetId) || null,
    })),
  };
}

/**
 * Resolve whatever the caller put in the path to an address.
 *
 * The issue specifies `/fraud/agents/:id/graph`, but the sybil graph is built
 * over Stellar addresses and an agent's id is not one — several agents can
 * share an owner, and an address in a cluster may have no agent row at all.
 * A numeric id is therefore resolved through the agent registry to its owner
 * address, and anything else is treated as an address directly.
 */
async function resolveAgentAddress(idOrAddress, deps = defaultDeps()) {
  if (/^\d+$/.test(String(idOrAddress))) {
    const agent = await deps.agentRepository.findById(Number(idOrAddress));
    if (!agent) throw httpError(404, `Agent ${idOrAddress} not found`);
    return agent.owner;
  }
  return String(idOrAddress);
}

/**
 * The sybil cluster an address belongs to, shaped for visualisation.
 *
 * Rebuilt from the current window rather than read back from the signal, so an
 * operator opening the graph sees the relationships as they are now, not as
 * they were when the scan ran. `score` is recomputed with the same function
 * the detector uses, so the dashboard and the queue never disagree.
 */
async function getAgentGraph(
  idOrAddress,
  { lookbackHours, now = Date.now(), deps = defaultDeps(), config = fraudConfig.getConfig() } = {}
) {
  const address = await resolveAgentAddress(idOrAddress, deps);
  const window = resolveWindow({ lookbackHours, now }, config);

  const [streams, licenses, usage, timings] = await Promise.all([
    deps.streamRepository.edgesInWindow(window),
    deps.licenseRepository.edgesInWindow(window),
    deps.usageEventRepository.edgesInWindow(window),
    deps.usageEventRepository.activityTimingByAddress(window),
  ]);

  const graph = buildGraph({ streams, licenses, usage });
  const signals = await deps.fraudSignalRepository.findOpenByAgent(address);

  const componentIndex = graph.componentOf.get(address);
  if (componentIndex === undefined) {
    // Known to the queue but with no edges in the current window — a cluster
    // that has gone quiet since the scan that flagged it.
    return { address, window, found: false, cluster: null, subgraph: null, score: null, signals };
  }

  const component = graph.components[componentIndex];
  const fundingRows = await deps.agentFundingRepository.findByAddresses(component.members);

  const scored = SybilGraphDetector.scoreComponent(
    component,
    {
      fundingByAddress: new Map(fundingRows.map((row) => [row.agentAddress, row.fundingSource])),
      timingByAddress: new Map(timings.map((row) => [row.address, row.firstSeen])),
    },
    config.sybil
  );

  return {
    address,
    window,
    found: true,
    cluster: {
      size: component.size,
      density: Number(component.density.toFixed(4)),
      members: component.members,
      withinScanBounds:
        component.size >= config.sybil.minClusterSize &&
        component.size <= config.sybil.maxClusterSize,
    },
    subgraph: subgraphFor(graph, component, config.sybil.maxSubgraphNodes),
    score: {
      value: scored.rawScore,
      fired: scored.fired,
      threshold: config.sybil.threshold,
      measuredWeight: scored.usedWeight,
      subScores: Object.fromEntries(scored.parts.map((part) => [part.name, part.score])),
    },
    signals,
  };
}

/**
 * Mark a signal as a false positive.
 *
 * The dismissal reason is the tuning data: a detector that keeps being
 * dismissed for the same reason is a detector whose thresholds are wrong, and
 * the backtest corpus grows from these.
 */
async function dismissSignal(id, { dismissedBy, reason = null, deps = defaultDeps() } = {}) {
  const dismissed = await deps.fraudSignalRepository.dismiss(id, { dismissedBy, reason });

  if (!dismissed) {
    const existing = await deps.fraudSignalRepository.findById(id);
    if (!existing) throw httpError(404, `Fraud signal ${id} not found`);
    throw httpError(409, `Fraud signal ${id} is already ${existing.status}`);
  }

  // Same tamper-evident trail the rest of the admin HTTP surface writes to.
  await AuditLogWriter.getInstance().append({
    eventType: EVENT_TYPES.FRAUD_SIGNAL_DISMISSED,
    actor: dismissedBy,
    subjectId: dismissed.agentAddress,
    payload: {
      signalId: dismissed.id,
      detector: dismissed.detector,
      assetId: dismissed.assetId,
      score: dismissed.score,
      riskTier: dismissed.riskTier,
      reason,
    },
  });

  return dismissed;
}

module.exports = {
  runScan,
  getScanStats,
  listSignals,
  getAgentGraph,
  dismissSignal,
  resolveAgentAddress,
  resolveWindow,
  runDetectors,
  rawSignalRow,
  defaultDeps,
  REPORTABLE_TIERS,
  DETECTORS,
};
