jest.mock("../../config/stellar", () => ({
  rpcServer: { getEvents: jest.fn() },
  CONTRACT_IDS: {},
}));

jest.mock("../../services/assetService", () => ({
  indexAsset: jest.fn(),
  removeAsset: jest.fn(),
  updateAssetVersion: jest.fn(),
}));

jest.mock("../../services/agentService", () => ({
  registerAgent: jest.fn(),
}));

jest.mock("../../repositories/eventLogRepository", () => ({
  append: jest.fn(),
  getLastLedger: jest.fn(),
}));

const { updateAssetVersion } = require("../../services/assetService");
const { processEvent } = require("../../listeners/eventListener");
const { nativeToScVal } = require("@stellar/stellar-sdk");

describe("eventListener UPDATED events", () => {
  let infoSpy;
  let warnSpy;

  beforeEach(() => {
    jest.clearAllMocks();
    infoSpy = jest.spyOn(console, "info").mockImplementation(() => {});
    warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    infoSpy.mockRestore();
    warnSpy.mockRestore();
  });

  it("advances the indexed asset version", async () => {
    updateAssetVersion.mockResolvedValue({ id: 42, version: 4 });

    await processEvent({ topic: ["UPDATED", "GOWNER"], value: [42, 3, 4] });

    expect(updateAssetVersion).toHaveBeenCalledWith(42, 4);
    expect(infoSpy).toHaveBeenCalledWith(
      "[eventListener] asset updated: id=42, oldVersion=3, newVersion=4"
    );
  });

  it("decodes the Soroban ScVal topic and tuple payload", async () => {
    updateAssetVersion.mockResolvedValue({ id: 42, version: 4 });

    await processEvent({
      topic: [nativeToScVal("UPDATED", { type: "symbol" })],
      value: nativeToScVal([42n, 3, 4]),
    });

    expect(updateAssetVersion).toHaveBeenCalledWith(42, 4);
  });

  it("handles an update for an asset that is not indexed", async () => {
    updateAssetVersion.mockResolvedValue(null);

    await expect(
      processEvent({ topic: ["UPDATED"], value: [99, 1, 2] })
    ).resolves.toBeUndefined();

    expect(warnSpy).toHaveBeenCalledWith(
      "[eventListener] asset update skipped; not indexed: id=99, oldVersion=1, newVersion=2"
    );
  });

  it.each([
    [null],
    [[]],
    [[42, 1]],
    [[42, 2, 2]],
    [{ assetId: "42", oldVersion: 1, newVersion: 2 }],
  ])("does not crash on malformed event value %p", async (value) => {
    await expect(
      processEvent({ topic: ["UPDATED"], value })
    ).resolves.toBeUndefined();
    expect(updateAssetVersion).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(
      "[eventListener] malformed UPDATED event; skipping"
    );
  });
});
