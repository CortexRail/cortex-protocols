/**
 * attestationRepository against a real PostgreSQL instance.
 *
 * The crypto is covered without a database in __tests__/attestation; what needs
 * a real server is everything the schema promises rather than the JavaScript:
 * the uniqueness constraints that make replay protection race-safe, the CHECK
 * constraints on the hex columns, and the partial indexes the batch queries
 * lean on.
 */

const attestationRepository = require("../../repositories/attestationRepository");
const { truncateAll, closePool } = require("../helpers/testDb");

const STREAM_ID = 900;
const SELLER = "GD226Q4QUIIDFBQ7TWPTP4UT4TKPX2MQRVEJSFMMCSM6ORDCPNZPPKCT";

const hex = (byte, bytes = 32) => byte.toString(16).padStart(2, "0").repeat(bytes);

function buildLeaf(callIndex, overrides = {}) {
  return {
    stream_id: STREAM_ID,
    call_index: callIndex,
    request_hash: hex(callIndex),
    response_hash: hex(callIndex + 100),
    timestamp: 1_700_000_000 + callIndex,
    nonce: hex(callIndex + 1),
    signature: hex(callIndex, 64),
    signer: SELLER,
    leaf_hash: hex(callIndex + 200),
    ...overrides,
  };
}

function buildBatch(overrides = {}) {
  return {
    streamId: STREAM_ID,
    seller: SELLER,
    merkleRoot: hex(0xab),
    callCount: 5,
    firstCallIndex: 0,
    lastCallIndex: 4,
    batchSignature: hex(0xcd, 64),
    ...overrides,
  };
}

describe("attestationRepository", () => {
  beforeEach(async () => {
    await truncateAll();
  });

  afterAll(async () => {
    await closePool();
  });

  describe("leaves", () => {
    it("archives a leaf and reads it back in the crypto layer's shape", async () => {
      await attestationRepository.recordLeaf(buildLeaf(0));

      const found = await attestationRepository.findLeafByCallIndex(STREAM_ID, 0);
      // Signed fields keep their wire names so they can go straight back into
      // the hasher without a rename step.
      expect(found).toMatchObject({
        stream_id: STREAM_ID,
        call_index: 0,
        signer: SELLER,
        timestamp: 1_700_000_000,
      });
    });

    it("is idempotent on (stream_id, call_index)", async () => {
      expect(await attestationRepository.recordLeaf(buildLeaf(0))).not.toBeNull();
      // A retried metering request must not create a second leaf, and must not
      // blow up either — the caller distinguishes the cases by the null.
      expect(await attestationRepository.recordLeaf(buildLeaf(0))).toBeNull();

      const unbatched = await attestationRepository.findUnbatchedLeaves(STREAM_ID);
      expect(unbatched).toHaveLength(1);
    });

    it("rejects a malformed hash at the schema level", async () => {
      await expect(
        attestationRepository.recordLeaf(buildLeaf(0, { nonce: "not-hex" }))
      ).rejects.toThrow();
    });

    it("returns the un-batched tail in call order", async () => {
      for (const i of [2, 0, 1]) await attestationRepository.recordLeaf(buildLeaf(i));

      const tail = await attestationRepository.findUnbatchedLeaves(STREAM_ID);
      expect(tail.map((l) => l.call_index)).toEqual([0, 1, 2]);
    });
  });

  describe("nonces", () => {
    it("burns a nonce once and refuses it thereafter", async () => {
      expect(await attestationRepository.burnNonce(STREAM_ID, hex(1), 0)).toBe(true);
      // The unique constraint is what makes this safe under concurrency: two
      // simultaneous metering transactions cannot both win.
      expect(await attestationRepository.burnNonce(STREAM_ID, hex(1), 1)).toBe(false);
      expect(await attestationRepository.isNonceUsed(STREAM_ID, hex(1))).toBe(true);
    });

    it("keeps nonce sets separate per stream", async () => {
      await attestationRepository.burnNonce(STREAM_ID, hex(1), 0);
      expect(await attestationRepository.burnNonce(STREAM_ID + 1, hex(1), 0)).toBe(true);
    });

    it("reports the highest spent index, so a restart resumes cleanly", async () => {
      expect(await attestationRepository.highestCallIndex(STREAM_ID)).toBeNull();

      await attestationRepository.burnNonce(STREAM_ID, hex(1), 4);
      await attestationRepository.burnNonce(STREAM_ID, hex(2), 9);
      expect(await attestationRepository.highestCallIndex(STREAM_ID)).toBe(9);
    });
  });

  describe("batches", () => {
    it("creates a batch pending, then binds it to its on-chain id", async () => {
      const created = await attestationRepository.createBatch(buildBatch());
      expect(created).toMatchObject({ status: "pending", batchId: null });

      const recorded = await attestationRepository.markRecorded(created.id, {
        batchId: 7,
        txHash: "abc123",
      });
      expect(recorded).toMatchObject({ status: "recorded", batchId: 7, txHash: "abc123" });
      expect(recorded.recordedAt).toEqual(expect.any(Number));
    });

    it("rejects a batch whose index range contradicts its call count", async () => {
      // The contract derives a refund from (call_index - first_call_index)
      // against call_count; a row where those disagree would misprice a void.
      await expect(
        attestationRepository.createBatch(buildBatch({ lastCallIndex: 99 }))
      ).rejects.toThrow();
    });

    it("claims exactly the leaves in the committed range", async () => {
      for (let i = 0; i < 8; i++) await attestationRepository.recordLeaf(buildLeaf(i));
      const batch = await attestationRepository.createBatch(
        buildBatch({ callCount: 5, firstCallIndex: 0, lastCallIndex: 4 })
      );

      const claimed = await attestationRepository.attachLeavesToBatch(batch.id, STREAM_ID, 0, 4);
      expect(claimed).toBe(5);

      expect(await attestationRepository.findLeavesByBatchRef(batch.id)).toHaveLength(5);
      // Leaves past the range stay available for the next batch.
      expect(await attestationRepository.findUnbatchedLeaves(STREAM_ID)).toHaveLength(3);
    });

    it("finds a batch by the id the contract assigned it", async () => {
      const created = await attestationRepository.createBatch(buildBatch());
      await attestationRepository.markRecorded(created.id, { batchId: 3, txHash: null });

      const found = await attestationRepository.findBatchByOnChainId(STREAM_ID, 3);
      expect(found.id).toBe(created.id);
    });

    it("marks a partially voided batch challenged and a fully voided one voided", async () => {
      const partial = await attestationRepository.createBatch(buildBatch());
      const challenged = await attestationRepository.markVoided(partial.id, {
        voidedCalls: 2,
        refundedAmount: 2000,
        txHash: "tx-1",
      });
      expect(challenged).toMatchObject({ status: "challenged", voidedCalls: 2 });

      const full = await attestationRepository.markVoided(partial.id, {
        voidedCalls: 5,
        refundedAmount: 5000,
        txHash: "tx-2",
      });
      expect(full.status).toBe("voided");
    });

    it("refuses to void more calls than the batch contains", async () => {
      const batch = await attestationRepository.createBatch(buildBatch());
      await expect(
        attestationRepository.markVoided(batch.id, { voidedCalls: 6, refundedAmount: 0 })
      ).rejects.toThrow();
    });

    it("pages a stream's batches newest first", async () => {
      for (let i = 0; i < 3; i++) {
        await attestationRepository.createBatch(
          buildBatch({ firstCallIndex: i * 5, lastCallIndex: i * 5 + 4 })
        );
      }

      const page = await attestationRepository.findBatchesByStream(STREAM_ID, { page: 1, limit: 2 });
      expect(page.data).toHaveLength(2);
      expect(page.meta.total).toBe(3);
      expect(page.data[0].firstCallIndex).toBe(10);
    });

    it("lists only pending batches for the submitter", async () => {
      const first = await attestationRepository.createBatch(buildBatch());
      await attestationRepository.createBatch(
        buildBatch({ firstCallIndex: 5, lastCallIndex: 9 })
      );
      await attestationRepository.markRecorded(first.id, { batchId: 1, txHash: null });

      const pending = await attestationRepository.findPendingBatches();
      expect(pending).toHaveLength(1);
      expect(pending[0].firstCallIndex).toBe(5);
    });
  });

  describe("createStores", () => {
    it("gives the verifier durable replay protection", async () => {
      const { nonceStore, indexStore } = attestationRepository.createStores();

      expect(await nonceStore.has(STREAM_ID, hex(1))).toBe(false);
      await nonceStore.add(STREAM_ID, hex(1), undefined, 3);
      expect(await nonceStore.has(STREAM_ID, hex(1))).toBe(true);
      // The high-water mark rides on the nonce row, so no extra write.
      expect(await indexStore.highest(STREAM_ID)).toBe(3);
    });
  });
});
