const eventLogRepository = require("../../repositories/eventLogRepository");
const { truncateAll, closePool, buildEvent } = require("../helpers/testDb");

beforeEach(async () => {
  await truncateAll();
});

afterAll(async () => {
  await closePool();
});

describe("eventLogRepository.append", () => {
  it("stores a raw event and returns the mapped row", async () => {
    const input = buildEvent({
      ledger: 555,
      topic: ["LISTED", "asset"],
      payload: { assetId: 7, price: 100 },
    });
    const event = await eventLogRepository.append(input);

    expect(event.id).toBeGreaterThan(0);
    expect(event.ledger).toBe(555);
    expect(event.contractId).toBe(input.contractId);
    expect(event.topic).toEqual(["LISTED", "asset"]);
    expect(event.payload).toEqual({ assetId: 7, price: 100 });
    expect(event.txHash).toBe(input.txHash);
    expect(typeof event.ingestedAt).toBe("number");
  });

  it("is append-only: identical events create distinct rows", async () => {
    const input = buildEvent({ txHash: "same-tx" });
    await eventLogRepository.append(input);
    await eventLogRepository.append(input);
    const rows = await eventLogRepository.findSince(0);
    expect(rows).toHaveLength(2);
  });
});

describe("eventLogRepository.findSince", () => {
  beforeEach(async () => {
    await eventLogRepository.append(buildEvent({ ledger: 100 }));
    await eventLogRepository.append(buildEvent({ ledger: 200 }));
    await eventLogRepository.append(buildEvent({ ledger: 300 }));
  });

  it("returns events strictly after the given ledger, ascending", async () => {
    const events = await eventLogRepository.findSince(100);
    expect(events.map((e) => e.ledger)).toEqual([200, 300]);
  });

  it("returns everything when starting from 0", async () => {
    expect(await eventLogRepository.findSince(0)).toHaveLength(3);
  });

  it("respects the limit option", async () => {
    const events = await eventLogRepository.findSince(0, { limit: 2 });
    expect(events).toHaveLength(2);
    expect(events.map((e) => e.ledger)).toEqual([100, 200]);
  });
});

describe("eventLogRepository.findByContractAndTopic", () => {
  const CONTRACT_A = "CCAAAA0000000000000000000000000000000000000000000000000";
  const CONTRACT_B = "CCBBBB0000000000000000000000000000000000000000000000000";

  beforeEach(async () => {
    await eventLogRepository.append(
      buildEvent({ contractId: CONTRACT_A, topic: ["LISTED"], ledger: 1 })
    );
    await eventLogRepository.append(
      buildEvent({ contractId: CONTRACT_A, topic: ["DELISTED"], ledger: 2 })
    );
    await eventLogRepository.append(
      buildEvent({ contractId: CONTRACT_B, topic: ["LISTED"], ledger: 3 })
    );
  });

  it("filters by contract AND topic membership", async () => {
    const events = await eventLogRepository.findByContractAndTopic(
      CONTRACT_A,
      "LISTED"
    );
    expect(events).toHaveLength(1);
    expect(events[0].ledger).toBe(1);
  });

  it("returns empty for a topic the contract never emitted", async () => {
    const events = await eventLogRepository.findByContractAndTopic(
      CONTRACT_B,
      "DELISTED"
    );
    expect(events).toHaveLength(0);
  });
});

describe("eventLogRepository.getLastLedger", () => {
  it("returns 0 for an empty log", async () => {
    expect(await eventLogRepository.getLastLedger()).toBe(0);
  });

  it("returns the max ledger seen", async () => {
    await eventLogRepository.append(buildEvent({ ledger: 42 }));
    await eventLogRepository.append(buildEvent({ ledger: 4242 }));
    await eventLogRepository.append(buildEvent({ ledger: 424 }));
    expect(await eventLogRepository.getLastLedger()).toBe(4242);
  });
});
