jest.mock("../../listeners/eventListener", () => ({ processEvent: jest.fn() }));

jest.mock("../../services/disputeService", () => ({
  recordStake: jest.fn(),
  fileDispute: jest.fn(),
  recordVote: jest.fn(),
  resolveDispute: jest.fn(),
  recordSlash: jest.fn(),
}));

jest.mock("../../pipeline/pipelineMetrics", () => ({
  recordProcessingLatency: jest.fn(),
}));

const { processEvent } = require("../../listeners/eventListener");
const disputeService = require("../../services/disputeService");
const pipelineMetrics = require("../../pipeline/pipelineMetrics");
const EventProcessor = require("../../pipeline/EventProcessor");

const AGENT = "GD226Q4QUIIDFBQ7TWPTP4UT4TKPX2MQRVEJSFMMCSM6ORDCPNZPPKCT";
const COMPLAINANT = "GAHC3JKJCBTPODO2GEOLUCXWTIQYBCPHBOTAT2KMPZ35PXCITJ57UYGC";
const CLOSED_AT = "2026-08-18T10:00:00Z";

function event(topic, value) {
  return { topic, value, ledger: 1_000, ledgerClosedAt: CLOSED_AT };
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe("EventProcessor routing", () => {
  it("forwards non-reputation events to the domain listener", async () => {
    const listed = event(["LISTED"], 1);
    await EventProcessor.process(listed);

    expect(processEvent).toHaveBeenCalledWith(listed);
    expect(disputeService.fileDispute).not.toHaveBeenCalled();
  });

  it("records processing latency for every event", async () => {
    await EventProcessor.process(event(["LISTED"], 1));
    expect(pipelineMetrics.recordProcessingLatency).toHaveBeenCalledTimes(1);
  });

  it("keeps reputation events away from the asset listener", async () => {
    await EventProcessor.process(event(["STAKED", AGENT], [500, 500]));
    expect(processEvent).not.toHaveBeenCalled();
  });
});

describe("EventProcessor reputation events", () => {
  it("mirrors STAKED as the address's new total", async () => {
    await EventProcessor.process(event(["STAKED", AGENT], [500, 1_500]));

    expect(disputeService.recordStake).toHaveBeenCalledWith(
      expect.objectContaining({ agentAddress: AGENT, amount: 1_500 })
    );
  });

  it("mirrors UNSTAKED as the address's remaining total", async () => {
    await EventProcessor.process(event(["UNSTAKED", AGENT], [500, 1_000]));

    expect(disputeService.recordStake).toHaveBeenCalledWith(
      expect.objectContaining({ agentAddress: AGENT, amount: 1_000 })
    );
  });

  it("indexes DISPUTE_OPENED with both parties and the voting deadline", async () => {
    await EventProcessor.process(
      event(["DISPUTE_OPENED", COMPLAINANT, AGENT], [7, 1_700_000_000])
    );

    expect(disputeService.fileDispute).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 7,
        complainant: COMPLAINANT,
        respondent: AGENT,
        closesAt: 1_700_000_000_000,
      })
    );
  });

  it("records DISPUTE_VOTED with its weight and direction", async () => {
    await EventProcessor.process(event(["DISPUTE_VOTED", AGENT], [7, 1_000, true]));

    expect(disputeService.recordVote).toHaveBeenCalledWith(
      expect.objectContaining({ disputeId: 7, voter: AGENT, weight: 1_000, inFavor: true })
    );
  });

  it("applies DISPUTE_RESOLVED with the verdict and slashed amount", async () => {
    await EventProcessor.process(
      event(["DISPUTE_RESOLVED", AGENT], [7, "Guilty", 2_000])
    );

    expect(disputeService.resolveDispute).toHaveBeenCalledWith(
      expect.objectContaining({ id: 7, outcome: "Guilty", slashedAmount: 2_000 })
    );
  });

  it("reads the verdict when the SDK decodes the enum as an object", async () => {
    await EventProcessor.process(
      event(["DISPUTE_RESOLVED", AGENT], [7, { NotGuilty: undefined }, 0])
    );

    expect(disputeService.resolveDispute).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: "NotGuilty" })
    );
  });

  it("applies STAKE_SLASHED to the respondent's collateral", async () => {
    await EventProcessor.process(event(["STAKE_SLASHED", AGENT], [7, 2_000]));

    expect(disputeService.recordSlash).toHaveBeenCalledWith(AGENT, 2_000);
  });

  it("ignores a STAKE_SLASHED event carrying no amount", async () => {
    await EventProcessor.process(event(["STAKE_SLASHED", AGENT], [7, 0]));

    expect(disputeService.recordSlash).not.toHaveBeenCalled();
  });

  it("ignores a malformed DISPUTE_OPENED event rather than throwing", async () => {
    await expect(
      EventProcessor.process(event(["DISPUTE_OPENED", COMPLAINANT], [0]))
    ).resolves.toBeUndefined();

    expect(disputeService.fileDispute).not.toHaveBeenCalled();
  });

  it("converts bigint payloads coming off the RPC", async () => {
    await EventProcessor.process(event(["STAKED", AGENT], [500n, 9_000n]));

    expect(disputeService.recordStake).toHaveBeenCalledWith(
      expect.objectContaining({ amount: 9_000 })
    );
  });
});
