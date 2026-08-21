/**
 * End-to-end attestation flow.
 *
 * The scenarios the acceptance criteria name, run against the real
 * AttestationArchive over an in-memory repository (see
 * helpers/memoryAttestationRepo.js — the SQL has its own suite):
 *
 *   1. a seller attests 50 calls, batches them into a Merkle root, and the
 *      buyer independently verifies every attestation against the archive and
 *      the committed root;
 *   2. a forged attestation inside a batch is identified, and the proof needed
 *      to void it on-chain is producible;
 *   3. a nonce replayed across two different batches is rejected.
 *
 * "Independently" is the load-bearing word: the buyer path below never reads a
 * verdict the backend computed, only the bytes it stored.
 */

const { Keypair } = require("@stellar/stellar-sdk");
const AttestationBuilder = require("../../attestation/AttestationBuilder");
const AttestationVerifier = require("../../attestation/AttestationVerifier");
const AttestationArchive = require("../../attestation/AttestationArchive");
const MerkleBatchBuilder = require("../../attestation/MerkleBatchBuilder");
const { createMemoryAttestationRepo } = require("../helpers/memoryAttestationRepo");

const { Reason } = AttestationVerifier;

const SELLER = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 3));
const IMPOSTOR = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 4));
const STREAM_ID = 4242;

/** A backend: archive, repository, and the verifier the metering path uses. */
function newBackend() {
  const repository = createMemoryAttestationRepo();
  const verifier = new AttestationVerifier({
    ...repository.createStores(),
    now: () => 1_700_100_000,
  });
  return { repository, verifier, archive: new AttestationArchive({ repository, verifier }) };
}

function newSeller() {
  return new AttestationBuilder({ signer: SELLER, now: () => 1_700_000_000 });
}

/**
 * One metered call, exactly as MeteringEngine runs it: verify the seller's
 * attestation, then archive it. Returns the verifier's verdict.
 */
async function meter(backend, attestation) {
  const result = await backend.verifier.accept(attestation, {
    signer: SELLER.publicKey(),
    streamId: STREAM_ID,
  });
  if (result.valid) {
    await backend.archive.archive({ ...attestation, signer: SELLER.publicKey() });
  }
  return result;
}

/** Commit the pending tail, mimicking the on-chain record_usage_batch. */
async function commit(backend, onChainBatchId) {
  const built = await backend.archive.buildBatch(STREAM_ID, { signer: SELLER });
  await backend.archive.markRecorded(built.batch.id, {
    batchId: onChainBatchId,
    txHash: `tx-${onChainBatchId}`,
  });
  return built;
}

describe("attestation end-to-end", () => {
  describe("50 attested calls, batched and independently verified", () => {
    let backend;
    let built;

    beforeEach(async () => {
      backend = newBackend();
      const seller = newSeller();

      for (let i = 0; i < 50; i++) {
        const attestation = seller.attest({
          streamId: STREAM_ID,
          request: { query: `q-${i}` },
          response: { answer: `a-${i}` },
        });
        const result = await meter(backend, attestation);
        expect(result.valid).toBe(true);
      }

      built = await commit(backend, 1);
    });

    it("commits all 50 calls under one root", () => {
      expect(built.batch.callCount).toBe(50);
      expect(built.batch.firstCallIndex).toBe(0);
      expect(built.batch.lastCallIndex).toBe(49);
      expect(built.batch.merkleRoot).toMatch(/^[0-9a-f]{64}$/);
    });

    it("lets a buyer re-derive the committed root from the archive alone", async () => {
      const { leaves } = await backend.archive.loadBatch(STREAM_ID, 1);
      const attestations = leaves.map(AttestationArchive.toWireAttestation);

      // The buyer rebuilds the tree from scratch. Nothing here reads the stored
      // root except the final comparison.
      const rebuilt = MerkleBatchBuilder.build(attestations);
      expect(rebuilt.root).toBe(built.batch.merkleRoot);
    });

    it("lets a buyer verify all 50 signatures and all 50 proofs without the backend's opinion", async () => {
      const { leaves } = await backend.archive.loadBatch(STREAM_ID, 1);
      const attestations = leaves.map(AttestationArchive.toWireAttestation);
      const rebuilt = MerkleBatchBuilder.build(attestations);
      const buyerVerifier = new AttestationVerifier({ now: () => 1_700_100_000 });

      expect(attestations).toHaveLength(50);
      attestations.forEach((attestation, position) => {
        expect(
          buyerVerifier.check(attestation, {
            signer: SELLER.publicKey(),
            streamId: STREAM_ID,
          }).valid
        ).toBe(true);

        const proof = MerkleBatchBuilder.proofForPosition(rebuilt, position);
        expect(MerkleBatchBuilder.verifyProof(attestation, proof, built.batch.merkleRoot)).toBe(
          true
        );
      });
    });

    it("reports a clean audit", async () => {
      const audit = await backend.archive.audit(STREAM_ID, 1);
      expect(audit).toMatchObject({
        found: true,
        valid: true,
        reason: null,
        rootMatches: true,
        commitmentValid: true,
        firstInvalidIndex: null,
      });
    });

    it("catches a backend that tampers with an archived leaf after the fact", async () => {
      // The archive is untrusted storage: rewriting a stored response hash
      // breaks both the signature and the root, and the buyer sees it.
      backend.repository._tamper(STREAM_ID, 20, { response_hash: "de".repeat(32) });

      const audit = await backend.archive.audit(STREAM_ID, 1);
      expect(audit.valid).toBe(false);
      expect(audit.rootMatches).toBe(false);
      expect(audit.leafResults[20].reason).toBe(Reason.BAD_SIGNATURE);
    });

    it("produces a usable proof for every call in the batch", async () => {
      for (const callIndex of [0, 17, 49]) {
        const proof = await backend.archive.getProof(STREAM_ID, 1, callIndex);
        expect(proof.rootMatches).toBe(true);
        expect(proof.verdict.valid).toBe(true);
        expect(MerkleBatchBuilder.verifyProof(proof.attestation, proof.proof, proof.root)).toBe(
          true
        );
      }
    });
  });

  describe("a forged attestation inside a batch", () => {
    let backend;
    let built;
    const FORGED_AT = 6;

    beforeEach(async () => {
      backend = newBackend();
      const seller = newSeller();

      // Ten calls, of which one was never actually signed by the seller — the
      // shape of a backend or seller padding the bill.
      for (let i = 0; i < 10; i++) {
        const attestation = seller.attest({
          streamId: STREAM_ID,
          request: { q: i },
          response: { a: i },
        });

        if (i === FORGED_AT) {
          // Metering rejects it, so the fabrication has to be written straight
          // into the archive — exactly what a compromised backend would do.
          const forged = { ...attestation, signature: "ab".repeat(64) };
          expect((await meter(backend, forged)).reason).toBe(Reason.BAD_SIGNATURE);
          await backend.repository.burnNonce(STREAM_ID, forged.nonce, forged.call_index);
          await backend.archive.archive({ ...forged, signer: SELLER.publicKey() });
        } else {
          expect((await meter(backend, attestation)).valid).toBe(true);
        }
      }

      built = await commit(backend, 1);
    });

    it("is refused at metering time", async () => {
      // Restated directly: the honest path never credits it.
      const seller = newSeller();
      const attestation = seller.attest({ streamId: STREAM_ID, request: {}, response: {} });
      const result = await backend.verifier.accept(
        { ...attestation, signature: "cd".repeat(64) },
        { signer: SELLER.publicKey(), streamId: STREAM_ID }
      );
      expect(result.valid).toBe(false);
      expect(result.reason).toBe(Reason.BAD_SIGNATURE);
    });

    it("is identified by the buyer's audit, at the right position", async () => {
      const audit = await backend.archive.audit(STREAM_ID, 1);

      expect(audit.valid).toBe(false);
      expect(audit.reason).toBe(Reason.BAD_SIGNATURE);
      expect(audit.firstInvalidIndex).toBe(FORGED_AT);
      expect(audit.disputableCallIndex).toBe(FORGED_AT);
      // Its neighbours are untouched — the batch is not wholesale bad.
      expect(audit.leafResults[FORGED_AT - 1].valid).toBe(true);
      expect(audit.leafResults[FORGED_AT + 1].valid).toBe(true);
    });

    it("still sits under the committed root, so the challenge is provable", async () => {
      // The seller committed to the forgery. That is the whole point: they
      // cannot now disown it, and the Merkle proof pins it to their root.
      const proof = await backend.archive.getProof(STREAM_ID, 1, FORGED_AT);

      expect(proof.rootMatches).toBe(true);
      expect(MerkleBatchBuilder.verifyProof(proof.attestation, proof.proof, proof.root)).toBe(true);
      expect(proof.verdict.valid).toBe(false);
      expect(proof.verdict.provableOnChain).toBe(true);
    });

    it("prices the void as the suffix from the forged call to the end of the batch", async () => {
      const proof = await backend.archive.getProof(STREAM_ID, 1, FORGED_AT);

      // Positions 6..9 — matches challenge_usage_batch's arithmetic exactly, so
      // the UI can show the refund before the buyer pays for the transaction.
      expect(proof.position).toBe(6);
      expect(proof.voidableCalls).toBe(4);
    });

    it("mirrors the on-chain void back into the archive", async () => {
      const voided = await backend.archive.markVoided(built.batch.id, {
        voidedCalls: 4,
        refundedAmount: 4000,
        txHash: "tx-challenge",
      });

      // Four of ten: challenged, not voided outright.
      expect(voided.status).toBe("challenged");
      expect(voided.voidedCalls).toBe(4);
    });

    it("marks a batch fully voided when the forgery is its first call", async () => {
      const fresh = newBackend();
      const seller = newSeller();
      const forged = { ...seller.attest({ streamId: STREAM_ID, request: {}, response: {} }),
        signature: "ab".repeat(64) };
      await fresh.archive.archive({ ...forged, signer: SELLER.publicKey() });
      for (let i = 1; i < 5; i++) {
        await meter(fresh, seller.attest({ streamId: STREAM_ID, request: { i }, response: { i } }));
      }
      const freshBuilt = await commit(fresh, 1);

      const proof = await fresh.archive.getProof(STREAM_ID, 1, 0);
      expect(proof.voidableCalls).toBe(5);

      const voided = await fresh.archive.markVoided(freshBuilt.batch.id, {
        voidedCalls: 5,
        refundedAmount: 5000,
      });
      expect(voided.status).toBe("voided");
    });
  });

  describe("a nonce replayed across two different batches", () => {
    let backend;
    let firstBatchNonce;

    beforeEach(async () => {
      backend = newBackend();
      const seller = newSeller();

      for (let i = 0; i < 4; i++) {
        const attestation = seller.attest({
          streamId: STREAM_ID,
          request: { q: i },
          response: { a: i },
        });
        if (i === 0) firstBatchNonce = attestation.nonce;
        expect((await meter(backend, attestation)).valid).toBe(true);
      }

      await commit(backend, 1);
    });

    it("is rejected when the nonce reappears in a later batch", async () => {
      const seller = newSeller();
      seller.seed(STREAM_ID, 3);

      // Honestly signed, freshly indexed, and still fraudulent: the nonce was
      // already spent, in a batch that is already committed on-chain.
      const replay = seller.attest({
        streamId: STREAM_ID,
        request: { q: "replayed" },
        response: { a: "replayed" },
        nonce: firstBatchNonce,
      });

      const result = await meter(backend, replay);
      expect(result.valid).toBe(false);
      expect(result.reason).toBe(Reason.NONCE_REUSED);
      expect(result.provableOnChain).toBe(true);
    });

    it("keeps the replay protection across a process restart", async () => {
      // A fresh verifier over the same durable stores — the replay set lives in
      // the repository, not in one process's memory.
      const restarted = new AttestationVerifier({
        ...backend.repository.createStores(),
        now: () => 1_700_100_000,
      });

      const seller = newSeller();
      seller.seed(STREAM_ID, 3);
      const replay = seller.attest({
        streamId: STREAM_ID,
        request: {},
        response: {},
        nonce: firstBatchNonce,
      });

      const result = await restarted.accept(replay, {
        signer: SELLER.publicKey(),
        streamId: STREAM_ID,
      });
      expect(result.reason).toBe(Reason.NONCE_REUSED);
    });

    it("is caught by the buyer's audit when a compromised backend archives it anyway", async () => {
      const seller = newSeller();
      seller.seed(STREAM_ID, 3);
      const replay = seller.attest({
        streamId: STREAM_ID,
        request: {},
        response: {},
        nonce: firstBatchNonce,
      });

      // Written past the verifier, then batched and committed.
      await backend.archive.archive({ ...replay, signer: SELLER.publicKey() });
      for (let i = 5; i < 8; i++) {
        const attestation = seller.attest({ streamId: STREAM_ID, request: { i }, response: { i } });
        await meter(backend, attestation);
      }
      await commit(backend, 2);

      // Within the second batch every leaf is individually well-signed, so the
      // batch audits clean in isolation — the duplication is only visible
      // against the first batch. That is precisely why the contract's
      // replay challenge takes two committed leaves and two proofs.
      const audit = await backend.archive.audit(STREAM_ID, 2);
      expect(audit.rootMatches).toBe(true);

      const original = await backend.archive.getProof(STREAM_ID, 1, 0);
      const duplicate = await backend.archive.getProof(STREAM_ID, 2, 4);

      expect(original.attestation.nonce).toBe(duplicate.attestation.nonce);
      expect(original.attestation.call_index).toBeLessThan(duplicate.attestation.call_index);
      // Both are provably committed, which is the whole evidentiary package
      // challenge_nonce_replay needs.
      expect(original.rootMatches).toBe(true);
      expect(duplicate.rootMatches).toBe(true);
      // The later batch loses its suffix from the replayed call onward.
      expect(duplicate.voidableCalls).toBe(4);
    });
  });

  describe("batch assembly", () => {
    it("stops at a gap rather than committing across it", async () => {
      const backend = newBackend();
      const seller = newSeller();

      for (let i = 0; i < 6; i++) {
        const attestation = seller.attest({ streamId: STREAM_ID, request: { i }, response: { i } });
        // Call 3 is rejected and never archived, leaving a hole.
        if (i !== 3) await meter(backend, attestation);
      }

      const built = await backend.archive.buildBatch(STREAM_ID, { signer: SELLER });
      expect(built.batch.callCount).toBe(3);
      expect(built.batch.lastCallIndex).toBe(2);

      // The tail past the gap waits for its own batch.
      const next = await backend.archive.buildBatch(STREAM_ID, { signer: SELLER });
      expect(next.batch.firstCallIndex).toBe(4);
      expect(next.batch.callCount).toBe(2);
    });

    it("refuses a batch commitment signed by the wrong key", async () => {
      const backend = newBackend();
      const seller = newSeller();
      for (let i = 0; i < 3; i++) {
        await meter(backend, seller.attest({ streamId: STREAM_ID, request: { i }, response: { i } }));
      }

      const prepared = await backend.archive.prepareBatch(STREAM_ID);
      const forged = MerkleBatchBuilder.signBatch(prepared.tree, IMPOSTOR);

      await expect(
        backend.archive.commitBatch(STREAM_ID, prepared.tree, {
          seller: SELLER.publicKey(),
          batchSignature: forged.batchSignature,
        })
      ).rejects.toThrow(/does not verify/);
    });

    it("returns nothing when there is nothing to batch", async () => {
      const backend = newBackend();
      expect(await backend.archive.prepareBatch(STREAM_ID)).toBeNull();
      expect(await backend.archive.buildBatch(STREAM_ID, { signer: SELLER })).toBeNull();
    });
  });
});
