const { withTransaction } = require("../../db/connection");
const cursorRepository = require("../../repositories/cursorRepository");
const LedgerCursor = require("../../pipeline/LedgerCursor");
const { closePool, truncateAll } = require("../helpers/testDb");

describe("LedgerCursor", () => {
  beforeEach(async () => {
    await truncateAll();
  });

  afterAll(async () => {
    await closePool();
  });

  it("persists and resumes the last processed ledger", async () => {
    expect(await LedgerCursor.initialize()).toBe(0);
    await LedgerCursor.persist(42);
    expect(LedgerCursor.getLastProcessedLedger()).toBe(42);

    await withTransaction(async (client) => {
      await cursorRepository.persistLastProcessedLedger(99, client);
    });

    expect(await LedgerCursor.initialize()).toBe(99);
  });
});
