/**
 * Renders a simulation run as a single self-contained HTML file.
 *
 * The report is uploaded as a CI artifact and opened straight off disk, so it
 * must render with no network access at all: every style is inline, every chart
 * is hand-built SVG, and there is not a single external URL in the output. The
 * accompanying test asserts exactly that.
 */

/** Operations rendered in the latency table, in protocol order. */
const OPERATION_ORDER = ["handshake", "quote", "streamOpen", "meteredCall", "settlement"];

/** Human labels for the operation keys. */
const OPERATION_LABELS = {
  handshake: "Handshake",
  quote: "Quote",
  streamOpen: "Stream open",
  meteredCall: "Metered call",
  settlement: "Settlement",
};

/**
 * Escapes text for safe interpolation into HTML.
 *
 * Agent ids, strategy names and error strings all end up in the document, and
 * an error message is the one thing in a simulation that can contain anything.
 *
 * @param {unknown} value
 * @returns {string}
 */
function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Draws a horizontal bar chart as inline SVG.
 *
 * @param {Array<{ label: string, value: number }>} rows
 * @param {{ width?: number, barHeight?: number, unit?: string }} [options]
 * @returns {string}
 */
function barChart(rows, { width = 640, barHeight = 26, unit = "" } = {}) {
  if (rows.length === 0) {
    return '<p class="empty">No data recorded.</p>';
  }

  const gap = 8;
  const labelWidth = 150;
  const chartWidth = width - labelWidth - 70;
  const max = Math.max(...rows.map((r) => r.value), 1);
  const height = rows.length * (barHeight + gap);

  const bars = rows
    .map((row, i) => {
      const y = i * (barHeight + gap);
      const length = Math.max(1, Math.round((row.value / max) * chartWidth));
      return [
        `<text x="0" y="${y + barHeight * 0.7}" class="bar-label">${escapeHtml(row.label)}</text>`,
        `<rect x="${labelWidth}" y="${y}" width="${length}" height="${barHeight}" rx="3" class="bar"></rect>`,
        `<text x="${labelWidth + length + 8}" y="${y + barHeight * 0.7}" class="bar-value">${escapeHtml(
          formatNumber(row.value)
        )}${escapeHtml(unit)}</text>`,
      ].join("");
    })
    .join("");

  return `<svg viewBox="0 0 ${width} ${height}" width="100%" height="${height}" role="img">${bars}</svg>`;
}

/** Formats a number with thousands separators and at most two decimals. */
function formatNumber(value) {
  if (!Number.isFinite(value)) return "0";
  const rounded = Math.round(value * 100) / 100;
  return rounded.toLocaleString("en-US");
}

/** Renders the latency percentile table. */
function latencyTable(operations) {
  const keys = [
    ...OPERATION_ORDER.filter((k) => k in operations),
    ...Object.keys(operations).filter((k) => !OPERATION_ORDER.includes(k)),
  ];

  const rows = keys
    .map((key) => {
      const op = operations[key];
      return `<tr>
        <td>${escapeHtml(OPERATION_LABELS[key] ?? key)}</td>
        <td class="num">${formatNumber(op.count)}</td>
        <td class="num ${op.errors > 0 ? "bad" : ""}">${formatNumber(op.errors)}</td>
        <td class="num">${formatNumber(op.min)}</td>
        <td class="num">${formatNumber(op.p50)}</td>
        <td class="num">${formatNumber(op.p95)}</td>
        <td class="num">${formatNumber(op.p99)}</td>
        <td class="num">${formatNumber(op.max)}</td>
      </tr>`;
    })
    .join("");

  return `<table>
    <thead><tr>
      <th>Operation</th><th class="num">Samples</th><th class="num">Errors</th>
      <th class="num">min</th><th class="num">p50</th><th class="num">p95</th>
      <th class="num">p99</th><th class="num">max</th>
    </tr></thead>
    <tbody>${rows || '<tr><td colspan="8" class="empty">No operations recorded.</td></tr>'}</tbody>
  </table>`;
}

/** Renders the reconciliation checklist. */
function reconciliationSection(reconciliation) {
  if (!reconciliation) return "";

  const rows = reconciliation.checks
    .map(
      (check) => `<tr>
        <td>${check.ok ? '<span class="pill ok">PASS</span>' : '<span class="pill bad">FAIL</span>'}</td>
        <td>${escapeHtml(check.name)}</td>
        <td class="muted">${escapeHtml(check.detail)}</td>
      </tr>`
    )
    .join("");

  return `<section>
    <h2>State reconciliation</h2>
    <p class="muted">Every check compares what the agents believe happened against what the run recorded. A single failure means value was left stranded.</p>
    <table><tbody>${rows}</tbody></table>
  </section>`;
}

/** Renders the per-agent breakdown. */
function agentTable(agents) {
  const rows = agents
    .map(
      (agent) => `<tr>
        <td><code>${escapeHtml(agent.id)}</code></td>
        <td>${escapeHtml(agent.strategy)}</td>
        <td>${escapeHtml(agent.state)}</td>
        <td class="num">${formatNumber(agent.ledger.streamsOpened)}</td>
        <td class="num">${formatNumber(agent.ledger.callsSucceeded)}</td>
        <td class="num">${formatNumber(agent.ledger.callsDropped)}</td>
        <td class="num ${agent.ledger.errors.length > 0 ? "bad" : ""}">${formatNumber(
          agent.ledger.errors.length
        )}</td>
      </tr>`
    )
    .join("");

  return `<table>
    <thead><tr>
      <th>Agent</th><th>Strategy</th><th>State</th>
      <th class="num">Streams</th><th class="num">Calls OK</th>
      <th class="num">Dropped</th><th class="num">Errors</th>
    </tr></thead>
    <tbody>${rows || '<tr><td colspan="7" class="empty">No agents ran.</td></tr>'}</tbody>
  </table>`;
}

/**
 * Builds the complete HTML report for a run.
 *
 * @param {object} run - The object `SwarmOrchestrator.run()` returns.
 * @param {{ generatedAt?: string, chaos?: object, title?: string }} [options]
 * @returns {string} A standalone HTML document.
 */
function generateReport(run, options = {}) {
  const generatedAt = options.generatedAt ?? new Date().toISOString();
  const title = options.title ?? "Cortex Protocol — Simulation Report";
  const metrics = run.metrics ?? {};
  const operations = metrics.operations ?? {};
  const totals = run.totals ?? {};
  const reconciliation = run.reconciliation;
  const chaos = options.chaos;

  const verdict = reconciliation?.ok === false || (metrics.errorRate ?? 0) > 0.05 ? "bad" : "ok";

  const latencyRows = Object.keys(operations)
    .filter((key) => operations[key].count > 0)
    .map((key) => ({ label: OPERATION_LABELS[key] ?? key, value: operations[key].p95 }));

  const errorRows = (metrics.errorBreakdown ?? []).slice(0, 12).map((e) => ({
    label: e.label.length > 40 ? `${e.label.slice(0, 37)}…` : e.label,
    value: e.count,
  }));

  const chaosSection = chaos
    ? `<section>
        <h2>Chaos</h2>
        <p class="muted">${escapeHtml(String(chaos.injected))} fault(s) injected${
          chaos.faults?.length ? ` — ${escapeHtml(chaos.faults.join(", "))}` : ""
        }.</p>
        ${
          chaos.history?.length
            ? `<table><thead><tr><th>Fault</th><th>Result</th><th>Detail</th></tr></thead><tbody>${chaos.history
                .map(
                  (h) => `<tr><td>${escapeHtml(h.type)}</td><td>${
                    h.ok ? '<span class="pill ok">OK</span>' : '<span class="pill bad">FAILED</span>'
                  }</td><td class="muted">${escapeHtml(h.error ?? "")}</td></tr>`
                )
                .join("")}</tbody></table>`
            : '<p class="empty">No faults were injected.</p>'
        }
      </section>`
    : "";

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
  :root {
    --bg: #ffffff; --fg: #16181d; --muted: #5f6672; --line: #e3e6ea;
    --accent: #2f6feb; --ok: #1a7f45; --bad: #c0362c; --surface: #f6f8fa;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #14171c; --fg: #e7eaee; --muted: #98a1ad; --line: #2a2f37;
      --accent: #5b9bff; --ok: #4ac17c; --bad: #ff7b6e; --surface: #1c2027;
    }
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 2rem 1.25rem 4rem; background: var(--bg); color: var(--fg);
    font: 15px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  }
  .wrap { max-width: 1000px; margin: 0 auto; }
  h1 { font-size: 1.6rem; margin: 0 0 .25rem; letter-spacing: -.01em; }
  h2 { font-size: 1.1rem; margin: 2.5rem 0 .5rem; letter-spacing: -.005em; }
  .muted { color: var(--muted); }
  .empty { color: var(--muted); font-style: italic; }
  .cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: .75rem; margin-top: 1.5rem; }
  .card { background: var(--surface); border: 1px solid var(--line); border-radius: 10px; padding: .85rem 1rem; }
  .card .k { font-size: .72rem; text-transform: uppercase; letter-spacing: .06em; color: var(--muted); }
  .card .v { font-size: 1.45rem; font-weight: 600; margin-top: .15rem; font-variant-numeric: tabular-nums; }
  .verdict { display: inline-block; padding: .2rem .6rem; border-radius: 999px; font-size: .78rem; font-weight: 600; }
  .verdict.ok { background: color-mix(in srgb, var(--ok) 15%, transparent); color: var(--ok); }
  .verdict.bad { background: color-mix(in srgb, var(--bad) 15%, transparent); color: var(--bad); }
  .table-scroll { overflow-x: auto; }
  table { border-collapse: collapse; width: 100%; margin-top: .5rem; font-size: .9rem; }
  th, td { text-align: left; padding: .45rem .6rem; border-bottom: 1px solid var(--line); }
  th { font-weight: 600; color: var(--muted); font-size: .78rem; text-transform: uppercase; letter-spacing: .04em; }
  td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }
  td.bad { color: var(--bad); font-weight: 600; }
  code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: .85em; }
  .pill { display: inline-block; padding: .1rem .45rem; border-radius: 4px; font-size: .72rem; font-weight: 700; }
  .pill.ok { background: color-mix(in srgb, var(--ok) 18%, transparent); color: var(--ok); }
  .pill.bad { background: color-mix(in srgb, var(--bad) 18%, transparent); color: var(--bad); }
  .bar { fill: var(--accent); }
  .bar-label, .bar-value { fill: var(--fg); font-size: 12px; font-family: inherit; }
  .bar-value { fill: var(--muted); }
</style>
</head>
<body>
<div class="wrap">
  <h1>${escapeHtml(title)}</h1>
  <p class="muted">
    Generated ${escapeHtml(generatedAt)} ·
    <span class="verdict ${verdict}">${verdict === "ok" ? "HEALTHY" : "NEEDS ATTENTION"}</span>
  </p>

  <div class="cards">
    <div class="card"><div class="k">Agents</div><div class="v">${formatNumber(totals.agents ?? 0)}</div></div>
    <div class="card"><div class="k">Duration</div><div class="v">${formatNumber(
      Math.round((metrics.durationMs ?? 0) / 1000)
    )}s</div></div>
    <div class="card"><div class="k">Operations</div><div class="v">${formatNumber(
      metrics.totalSamples ?? 0
    )}</div></div>
    <div class="card"><div class="k">Throughput</div><div class="v">${formatNumber(
      metrics.throughputPerSec ?? 0
    )}/s</div></div>
    <div class="card"><div class="k">Error rate</div><div class="v">${formatNumber(
      Math.round((metrics.errorRate ?? 0) * 10000) / 100
    )}%</div></div>
    <div class="card"><div class="k">Streams settled</div><div class="v">${formatNumber(
      totals.streamsSettled ?? 0
    )}/${formatNumber(totals.streamsOpened ?? 0)}</div></div>
  </div>

  <h2>Latency (p95 by operation)</h2>
  ${barChart(latencyRows, { unit: " ms" })}

  <h2>Latency percentiles</h2>
  <div class="table-scroll">${latencyTable(operations)}</div>

  <h2>Errors</h2>
  ${
    errorRows.length > 0
      ? barChart(errorRows)
      : '<p class="empty">No errors recorded.</p>'
  }

  ${reconciliationSection(reconciliation)}
  ${chaosSection}

  <h2>Agents</h2>
  <div class="table-scroll">${agentTable(run.agents ?? [])}</div>
</div>
</body>
</html>
`;
}

module.exports = { generateReport, escapeHtml, barChart, formatNumber, OPERATION_LABELS };
