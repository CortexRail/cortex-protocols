const disputeService = require("../../services/disputeService");
const disputeRepository = require("../../repositories/disputeRepository");
const escrowRepository = require("../../repositories/escrowRepository");

jest.mock("../../repositories/disputeRepository");
jest.mock("../../repositories/escrowRepository");

describe("disputeService unit tests", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe("hashEvidence", () => {
    it("computes deterministic SHA-256 hash", () => {
      const hash1 = disputeService.hashEvidence("broken asset");
      const hash2 = disputeService.hashEvidence("broken asset");
      expect(hash1).toHaveLength(64);
      expect(hash1).toBe(hash2);
    });
  });

  describe("filePurchaseDispute", () => {
    it("files dispute and updates escrow status to Disputed", async () => {
      escrowRepository.findByLicenseId.mockResolvedValue({
        licenseId: 1,
        buyer: "GBUYER12345678901234567890123456789012345678901234567890",
        status: "Held",
      });
      disputeRepository.createDispute.mockImplementation(async (d) => d);

      const result = await disputeService.filePurchaseDispute({
        licenseId: 1,
        buyer: "GBUYER12345678901234567890123456789012345678901234567890",
        evidenceText: "Detailed explanation of failure",
      });

      expect(escrowRepository.updateStatus).toHaveBeenCalledWith(1, "Disputed");
      expect(result.dispute.status).toBe("Open");
      expect(result.evidenceHash).toHaveLength(64);
    });

    it("rejects dispute if caller is not the license buyer", async () => {
      escrowRepository.findByLicenseId.mockResolvedValue({
        licenseId: 1,
        buyer: "GREALBUYER123456789012345678901234567890123456789012345678",
        status: "Held",
      });

      await expect(
        disputeService.filePurchaseDispute({
          licenseId: 1,
          buyer: "GFFAKEBUYER1234567890123456789012345678901234567890123456",
          evidenceText: "Detailed explanation of failure",
        })
      ).rejects.toThrow(/Only the license buyer can raise a dispute/);
    });
  });

  describe("castArbitratorVote", () => {
    it("records FullRefund vote", async () => {
      disputeRepository.findByDisputeId.mockResolvedValue({
        disputeId: 10,
        status: "Open",
      });
      disputeRepository.recordVote.mockResolvedValue({
        id: 1,
        disputeId: 10,
        arbitrator: "GARBITRATOR12345678901234567890123456789012345678901234",
        vote: "FullRefund",
      });
      disputeRepository.findVotesByDisputeId.mockResolvedValue([
        { vote: "FullRefund" },
      ]);

      const result = await disputeService.castArbitratorVote({
        disputeId: 10,
        arbitrator: "GARBITRATOR12345678901234567890123456789012345678901234",
        vote: "FullRefund",
      });

      expect(result.totalVotes).toBe(1);
    });

    it("validates bps for PartialRefund", async () => {
      disputeRepository.findByDisputeId.mockResolvedValue({
        disputeId: 10,
        status: "Open",
      });

      await expect(
        disputeService.castArbitratorVote({
          disputeId: 10,
          arbitrator: "GARBITRATOR12345678901234567890123456789012345678901234",
          vote: "PartialRefund",
          bps: 15000,
        })
      ).rejects.toThrow(/PartialRefund requires bps between 0 and 10000/);
    });
  });
});
