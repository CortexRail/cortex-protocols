/**
 * `cortex-admin dashboard` — live-updating operator TUI.
 *
 * Four panels (pipeline lag, open disputes, dead-lettered settlements,
 * recent admin actions) refresh on a timer so a manually triggered state
 * change — e.g. a forced settlement from another terminal — shows up
 * within one refresh cycle. Tab cycles focus between panels; arrow keys
 * scroll the focused panel; Enter on a disputes row drills into the
 * underlying asset; q/Ctrl-C quits.
 */

const blessed = require("blessed");
const { authenticate } = require("../AuthGate");
const EventPipeline = require("../../pipeline/EventPipeline");
const reportRepository = require("../../repositories/reportRepository");
const assetRepository = require("../../repositories/assetRepository");
const adminActionRepository = require("../../repositories/adminActionRepository");
const { renderDashboard } = require("./render");

const DEFAULT_REFRESH_MS = 3000;

async function fetchData() {
  const [disputesPage, recentActionsPage] = await Promise.all([
    reportRepository.findAll({ status: "Pending" }, { limit: 10 }),
    adminActionRepository.findRecent({ limit: 10 }),
  ]);

  return {
    metrics: EventPipeline.getMetrics(),
    status: EventPipeline.getStatus(),
    deadLetters: EventPipeline.getDeadLetters(),
    disputes: disputesPage.data,
    recentActions: recentActionsPage.data,
  };
}

function buildScreen() {
  const screen = blessed.screen({ smartCSR: true, title: "cortex-admin dashboard" });

  const panelOptions = {
    top: 0,
    width: "50%",
    height: "50%",
    border: { type: "line" },
    tags: true,
    scrollable: true,
    keys: true,
    vi: true,
    alwaysScroll: true,
    scrollbar: { ch: " ", inverse: true },
    style: { border: { fg: "white" }, focus: { border: { fg: "cyan" } } },
  };

  const pipelineBox = blessed.box({ ...panelOptions, left: 0, top: 0 });
  const disputesBox = blessed.box({ ...panelOptions, left: "50%", top: 0 });
  const deadLettersBox = blessed.box({ ...panelOptions, left: 0, top: "50%" });
  const recentActionsBox = blessed.box({ ...panelOptions, left: "50%", top: "50%" });

  screen.append(pipelineBox);
  screen.append(disputesBox);
  screen.append(deadLettersBox);
  screen.append(recentActionsBox);

  return { screen, pipelineBox, disputesBox, deadLettersBox, recentActionsBox };
}

/**
 * @param {{ refreshIntervalMs?: number, load?: () => Promise<object> }} [options]
 * @returns {{ stop: () => void }}
 */
function start({ refreshIntervalMs = DEFAULT_REFRESH_MS, load = fetchData } = {}) {
  authenticate({ minRole: "readonly" });

  const { screen, pipelineBox, disputesBox, deadLettersBox, recentActionsBox } = buildScreen();
  const panels = [pipelineBox, disputesBox, deadLettersBox, recentActionsBox];
  let focusIndex = 0;
  let lastDisputes = [];

  panels[focusIndex].focus();

  screen.key(["tab"], () => {
    focusIndex = (focusIndex + 1) % panels.length;
    panels[focusIndex].focus();
    screen.render();
  });

  screen.key(["q", "C-c", "escape"], () => {
    stop();
    process.exit(0);
  });

  disputesBox.key(["enter"], async () => {
    const selected = lastDisputes[0];
    if (!selected) return;
    const asset = await assetRepository.findById(selected.assetId, { includeInactive: true });
    disputesBox.setContent(
      asset
        ? `{bold}Asset ${asset.id}{/bold}\n${asset.name}\nowner: ${asset.owner}\nflagged: ${asset.flagged}\n\nPress tab to return.`
        : `asset ${selected.assetId} not found`
    );
    screen.render();
  });

  async function refresh() {
    try {
      const data = await load();
      lastDisputes = data.disputes || [];
      const rendered = renderDashboard(data);
      pipelineBox.setContent(rendered.pipeline);
      disputesBox.setContent(rendered.disputes);
      deadLettersBox.setContent(rendered.deadLetters);
      recentActionsBox.setContent(rendered.recentActions);
      screen.render();
    } catch (err) {
      pipelineBox.setContent(`{red-fg}refresh failed: ${err.message}{/red-fg}`);
      screen.render();
    }
  }

  screen.key(["r"], refresh);

  const intervalId = setInterval(refresh, refreshIntervalMs);
  refresh();

  function stop() {
    clearInterval(intervalId);
    screen.destroy();
  }

  return { stop };
}

module.exports = { start, fetchData };
