/**
 * Pure rendering for the `cortex-admin dashboard` TUI panels.
 *
 * Kept separate from the blessed screen wiring in dashboard.js so panel
 * content can be snapshot-tested against a plain data object instead of a
 * real terminal.
 */

function formatTimestamp(ms) {
  if (!ms) return "—";
  return new Date(ms).toISOString().replace("T", " ").slice(0, 19);
}

function truncate(str, max) {
  const s = String(str ?? "");
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/**
 * @param {object} metrics - shape of pipelineMetrics.getMetrics()
 * @param {{ circuitOpen: boolean }} status - shape of EventPoller#getStatus()
 */
function renderPipelinePanel(metrics = {}, status = {}) {
  const lines = [
    "{bold}Pipeline{/bold}",
    `last processed ledger: ${metrics.last_processed_ledger ?? 0}`,
    `events/min:            ${metrics.events_per_minute ?? 0}`,
    `p99 latency:            ${metrics.processing_latency_p99 ?? 0}ms`,
    `queue depth:            ${metrics.queue_depth ?? 0}`,
    `dead letters:           ${metrics.dead_letter_count ?? 0}`,
    `circuit breaker:        ${status.circuitOpen ? "{red-fg}OPEN{/red-fg}" : "closed"}`,
  ];
  return lines.join("\n");
}

function renderDisputesPanel(reports = []) {
  if (reports.length === 0) return "{bold}Open disputes{/bold}\n(none)";
  const rows = reports
    .slice(0, 10)
    .map((r) => `#${r.id}  asset ${r.assetId}  ${r.reason}  ${formatTimestamp(r.createdAt)}`);
  return ["{bold}Open disputes{/bold}", ...rows].join("\n");
}

function renderDeadLettersPanel(deadLetters = []) {
  if (deadLetters.length === 0) return "{bold}Dead-lettered settlements{/bold}\n(none)";
  const rows = deadLetters
    .slice(0, 10)
    .map((d) => `ledger ${d.event?.ledger ?? "?"}  ${truncate(d.error || d.reason || "unknown error", 40)}`);
  return ["{bold}Dead-lettered settlements{/bold}", ...rows].join("\n");
}

function renderRecentActionsPanel(actions = []) {
  if (actions.length === 0) return "{bold}Recent admin actions{/bold}\n(none)";
  const rows = actions
    .slice(0, 10)
    .map((a) => {
      const statusTag =
        a.status === "success" ? "{green-fg}ok{/green-fg}" : a.status === "error" ? "{red-fg}err{/red-fg}" : "…";
      return `${formatTimestamp(a.createdAt)}  ${truncate(a.operator, 10)}  ${a.command}  ${statusTag}`;
    });
  return ["{bold}Recent admin actions{/bold}", ...rows].join("\n");
}

/**
 * @param {{
 *   metrics: object, status: object, disputes: object[],
 *   deadLetters: object[], recentActions: object[]
 * }} data
 * @returns {{ pipeline: string, disputes: string, deadLetters: string, recentActions: string }}
 */
function renderDashboard(data = {}) {
  return {
    pipeline: renderPipelinePanel(data.metrics, data.status),
    disputes: renderDisputesPanel(data.disputes),
    deadLetters: renderDeadLettersPanel(data.deadLetters),
    recentActions: renderRecentActionsPanel(data.recentActions),
  };
}

module.exports = {
  renderDashboard,
  renderPipelinePanel,
  renderDisputesPanel,
  renderDeadLettersPanel,
  renderRecentActionsPanel,
};
