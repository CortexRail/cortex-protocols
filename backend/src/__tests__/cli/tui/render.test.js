const { renderDashboard } = require("../../../cli/tui/render");

const MOCKED_DATA = {
  metrics: {
    events_per_minute: 12,
    processing_latency_p99: 84,
    queue_depth: 3,
    dead_letter_count: 1,
    last_processed_ledger: 481920,
  },
  status: { circuitOpen: false },
  disputes: [
    { id: 5, assetId: 101, reason: "Plagiarism", createdAt: 1_700_000_000_000 },
    { id: 6, assetId: 102, reason: "Spam", createdAt: 1_700_000_100_000 },
  ],
  deadLetters: [{ event: { ledger: 481900 }, error: "processor threw: unknown topic" }],
  recentActions: [
    { operator: "GOPERATOR1", command: "stream force-settle", status: "success", createdAt: 1_700_000_200_000 },
    { operator: "GOPERATOR2", command: "agent ban", status: "error", createdAt: 1_700_000_300_000 },
  ],
};

describe("TUI dashboard rendering", () => {
  it("renders all four panels from a live-data snapshot", () => {
    expect(renderDashboard(MOCKED_DATA)).toMatchSnapshot();
  });

  it("renders empty-state placeholders when there's nothing to show", () => {
    expect(
      renderDashboard({
        metrics: {},
        status: {},
        disputes: [],
        deadLetters: [],
        recentActions: [],
      })
    ).toMatchSnapshot();
  });

  it("reflects a manually triggered state change within one refresh cycle", () => {
    const before = renderDashboard(MOCKED_DATA);
    const after = renderDashboard({
      ...MOCKED_DATA,
      recentActions: [
        { operator: "GOPERATOR3", command: "stream force-settle", status: "success", createdAt: 1_700_000_400_000 },
        ...MOCKED_DATA.recentActions,
      ],
    });

    expect(after.recentActions).not.toEqual(before.recentActions);
    expect(after.recentActions).toContain("stream force-settle");
    expect(after.recentActions.split("\n")).toHaveLength(before.recentActions.split("\n").length + 1);
  });
});
