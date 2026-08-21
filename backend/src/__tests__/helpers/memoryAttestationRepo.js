/**
 * In-memory stand-in for attestationRepository.
 *
 * The end-to-end attestation suite is about cryptography, not SQL: it needs to
 * archive leaves, group them into batches, and read them back, and none of that
 * is more truthful for having gone through Postgres. Backing it with a Map
 * keeps the suite runnable without a container, so a broken hash or a broken
 * proof fails fast rather than only in CI.
 *
 * The SQL itself is covered separately, against a real database, in
 * __tests__/repositories/attestationRepository.test.js.
 *
 * Implements exactly the surface AttestationArchive uses, including the
 * behaviours it depends on: `recordLeaf` is idempotent on
 * (stream_id, call_index) and returns null on conflict, and `burnNonce`
 * returns false when the nonce was already spent.
 */

function createMemoryAttestationRepo() {
  const leaves = []; // ordered by insertion
  const batches = [];
  const nonces = new Map(); // `${streamId}:${nonce}` -> callIndex
  let nextLeafId = 1;
  let nextBatchId = 1;

  const byStream = (streamId) => leaves.filter((l) => l.stream_id === Number(streamId));

  return {
    async recordLeaf(leaf) {
      const clash = leaves.find(
        (l) => l.stream_id === Number(leaf.stream_id) && l.call_index === Number(leaf.call_index)
      );
      if (clash) return null;

      const stored = {
        ...leaf,
        stream_id: Number(leaf.stream_id),
        call_index: Number(leaf.call_index),
        id: nextLeafId++,
        batchRef: null,
        verifyReason: leaf.verifyReason || "OK",
      };
      leaves.push(stored);
      return stored;
    },

    async findUnbatchedLeaves(streamId, limit = 100) {
      return byStream(streamId)
        .filter((l) => l.batchRef === null)
        .sort((a, b) => a.call_index - b.call_index)
        .slice(0, limit);
    },

    async findLeavesByBatchRef(batchRef) {
      return leaves
        .filter((l) => l.batchRef === batchRef)
        .sort((a, b) => a.call_index - b.call_index);
    },

    async findLeafByCallIndex(streamId, callIndex) {
      return (
        byStream(streamId).find((l) => l.call_index === Number(callIndex)) ?? null
      );
    },

    async attachLeavesToBatch(batchRef, streamId, first, last) {
      const claimed = byStream(streamId).filter(
        (l) => l.batchRef === null && l.call_index >= first && l.call_index <= last
      );
      claimed.forEach((l) => {
        l.batchRef = batchRef;
      });
      return claimed.length;
    },

    async burnNonce(streamId, nonce, callIndex) {
      const key = `${streamId}:${nonce}`;
      if (nonces.has(key)) return false;
      nonces.set(key, callIndex);
      return true;
    },

    async isNonceUsed(streamId, nonce) {
      return nonces.has(`${streamId}:${nonce}`);
    },

    async highestCallIndex(streamId) {
      const seen = [...nonces.entries()]
        .filter(([key]) => key.startsWith(`${streamId}:`))
        .map(([, callIndex]) => callIndex);
      return seen.length ? Math.max(...seen) : null;
    },

    async createBatch(batch) {
      const stored = {
        ...batch,
        streamId: Number(batch.streamId),
        id: nextBatchId++,
        batchId: null,
        status: "pending",
        voidedCalls: 0,
        refundedAmount: 0,
        txHash: null,
        createdAt: Date.now(),
      };
      batches.push(stored);
      return stored;
    },

    async markRecorded(id, { batchId, txHash }) {
      const batch = batches.find((b) => b.id === id);
      if (!batch) return null;
      Object.assign(batch, { batchId: Number(batchId), txHash: txHash ?? null, status: "recorded" });
      return batch;
    },

    async markVoided(id, { voidedCalls, refundedAmount, txHash }) {
      const batch = batches.find((b) => b.id === id);
      if (!batch) return null;
      Object.assign(batch, {
        voidedCalls,
        refundedAmount,
        txHash: txHash ?? batch.txHash,
        status: voidedCalls >= batch.callCount ? "voided" : "challenged",
      });
      return batch;
    },

    async findBatchById(id) {
      return batches.find((b) => b.id === id) ?? null;
    },

    async findBatchByOnChainId(streamId, batchId) {
      return (
        batches.find(
          (b) => b.streamId === Number(streamId) && b.batchId === Number(batchId)
        ) ?? null
      );
    },

    async findBatchesByStream(streamId) {
      const data = batches
        .filter((b) => b.streamId === Number(streamId))
        .sort((a, b) => b.id - a.id);
      return { data, meta: { total: data.length, page: 1, limit: 20, pages: 1 } };
    },

    async findPendingBatches(limit = 50) {
      return batches.filter((b) => b.status === "pending").slice(0, limit);
    },

    createStores() {
      return {
        nonceStore: {
          has: (streamId, nonce) => this.isNonceUsed(streamId, nonce),
          add: (streamId, nonce, _client, callIndex) =>
            this.burnNonce(streamId, nonce, callIndex),
        },
        indexStore: {
          highest: (streamId) => this.highestCallIndex(streamId),
          set: async () => {},
        },
      };
    },

    /** Test-only: reach in and corrupt an archived leaf. */
    _tamper(streamId, callIndex, patch) {
      const leaf = byStream(streamId).find((l) => l.call_index === Number(callIndex));
      Object.assign(leaf, patch);
      return leaf;
    },

    _raw: { leaves, batches, nonces },
  };
}

module.exports = { createMemoryAttestationRepo };
