/**
 * DB-backed proof of the third acceptance criterion: the TUI dashboard
 * reflects a manually triggered state change within one refresh cycle.
 *
 * `fetchData()` is exactly what dashboard.js's setInterval tick calls on
 * every refresh, so calling it once after a real forced settlement is a
 * faithful test of "one refresh cycle" without needing a real terminal
 * (blessed requires a TTY, which isn't available in CI).
 */

const { Keypair } = require("@stellar/stellar-sdk");
const { closePool } = require("../../../db/connection");
const streamRepository = require("../../../repositories/streamRepository");
const streamCmd = require("../../../cli/commands/stream");
const { fetchData } = require("../../../cli/tui/dashboard");
const { renderDashboard } = require("../../../cli/tui/render");
const { truncateAll, buildStream } = require("../../helpers/testDb");

const moderatorKp = Keypair.random();
const ALLOWLIST = [{ publicKey: moderatorKp.publicKey(), role: "moderator" }];

beforeEach(async () => {
  await truncateAll();
  process.env.OPERATOR_ALLOWLIST = JSON.stringify(ALLOWLIST);
  process.env.OPERATOR_SECRET_KEY = moderatorKp.secret();
});

afterEach(() => {
  delete process.env.OPERATOR_ALLOWLIST;
  delete process.env.OPERATOR_SECRET_KEY;
});

afterAll(async () => {
  await closePool();
});

describe("dashboard reflects a manually triggered state change within one refresh cycle", () => {
  it("shows a forced settlement in the recent admin actions panel after a single fetchData() call", async () => {
    const stream = buildStream({ status: "Active" });
    await streamRepository.create(stream);

    const before = await fetchData();
    expect(before.recentActions.some((a) => a.command === "stream force-settle")).toBe(false);

    await streamCmd.forceSettle(stream.id);

    // One refresh cycle == one fetchData() call.
    const after = await fetchData();
    const action = after.recentActions.find((a) => a.command === "stream force-settle");
    expect(action).toBeDefined();
    expect(action.status).toBe("success");

    const rendered = renderDashboard(after);
    expect(rendered.recentActions).toContain("stream force-settle");
  });
});
