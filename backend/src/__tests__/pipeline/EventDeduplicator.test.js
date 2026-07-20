const eventLogRepository = require("../../repositories/eventLogRepository");
const EventDeduplicator = require("../../pipeline/EventDeduplicator");
const { closePool, truncateAll, buildEvent } = require("../helpers/testDb");

describe("EventDeduplicator", () => {
  beforeEach(async () => {
    await truncateAll();
  });

  afterAll(async () => {
    await closePool();
  });

  it("detects duplicate events by unique key", async () => {
    const event = buildEvent({ ledger: 123, txHash: "tx-1", eventIndex: 1 });
    await eventLogRepository.append(event);

    const duplicate = await EventDeduplicator.isDuplicate(event);
    expect(duplicate).toBe(true);
  });

  it("does not treat distinct events as duplicates", async () => {
    await eventLogRepository.append(buildEvent({ ledger: 123, txHash: "tx-1", eventIndex: 1 }));

    const next = buildEvent({ ledger: 123, txHash: "tx-1", eventIndex: 2 });
    expect(await EventDeduplicator.isDuplicate(next)).toBe(false);
  });
});
