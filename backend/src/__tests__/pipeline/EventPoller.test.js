jest.mock("../../config/stellar", () => ({
  rpcServer: { getEvents: jest.fn() },
  CONTRACT_IDS: { marketplace: "MKTPLACE", agentRegistry: "AGENTREG" },
}));

const { rpcServer } = require("../../config/stellar");
const EventPoller = require("../../pipeline/EventPoller");

describe("EventPoller circuit breaker", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("opens after 10 consecutive failures", async () => {
    const poller = new EventPoller({
      baseDelayMs: 1,
      maxDelayMs: 2,
      cooldownMs: 10,
      maxFailures: 10,
    });
    const error = new Error("RPC failed");
    rpcServer.getEvents.mockRejectedValue(error);

    for (let i = 0; i < 10; i += 1) {
      try {
        await poller.fetchEvents(0);
      } catch (_) {
        // Expected — accumulating failures to trip the circuit breaker.
      }
    }

    expect(poller.failureCount).toBeGreaterThanOrEqual(10);
    expect(poller.circuitOpen).toBe(true);
  });
});
