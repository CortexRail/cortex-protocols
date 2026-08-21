/**
 * Unit tests for the attestation primitives.
 *
 * Pure crypto and pure data structures — no database, no container — so a
 * regression in the wire format or the tree shows up immediately rather than
 * only once the integration suite can run.
 */

const { Keypair } = require("@stellar/stellar-sdk");
const canonical = require("../../attestation/canonical");
const AttestationBuilder = require("../../attestation/AttestationBuilder");
const AttestationVerifier = require("../../attestation/AttestationVerifier");
const MerkleBatchBuilder = require("../../attestation/MerkleBatchBuilder");

const { Reason } = AttestationVerifier;

const SELLER = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 7));
const IMPOSTOR = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 9));

function newBuilder(signer = SELLER) {
  return new AttestationBuilder({ signer, now: () => 1_700_000_000 });
}

function attestMany(builder, streamId, count, startAt = 0) {
  if (startAt) builder.seed(streamId, startAt - 1);
  return Array.from({ length: count }, (_, i) =>
    builder.attest({ streamId, request: { q: i }, response: { a: i } })
  );
}

describe("canonical encoding", () => {
  const attestation = {
    stream_id: 42,
    call_index: 7,
    request_hash: "07".repeat(32),
    response_hash: "87".repeat(32),
    timestamp: 1_700_000_007,
    nonce: "07".repeat(32),
  };

  it("encodes a leaf as exactly 120 fixed-width bytes", () => {
    const encoded = canonical.encodeLeafPreimage(attestation);
    expect(encoded).toHaveLength(canonical.LEAF_PREIMAGE_BYTES);
    expect(encoded.readBigUInt64BE(canonical.OFFSETS.streamId)).toBe(42n);
    expect(encoded.readBigUInt64BE(canonical.OFFSETS.callIndex)).toBe(7n);
  });

  it("round-trips a leaf through encode/decode", () => {
    expect(canonical.decodeLeafPreimage(canonical.encodeLeafPreimage(attestation))).toEqual(
      attestation
    );
  });

  /**
   * These are the same constants asserted in the contract's attestation_test.rs.
   * If the two encoders ever drift, both sides fail rather than quietly
   * producing roots that no longer verify against each other.
   */
  it("matches the pinned cross-language vectors", () => {
    expect(canonical.leafHash(attestation).toString("hex")).toBe(
      "b4c1330bdbc48325bda5539652c39793f3e7f41d8d454dd87733adbf3ee04d4c"
    );
    expect(
      canonical.hashInternal(Buffer.alloc(32, 0xaa), Buffer.alloc(32, 0x11)).toString("hex")
    ).toBe("7bc00103de1206e4948808b12bd2016b6923258e43b9c23724ed104cfdd1fdea");
    expect(
      canonical
        .batchCommitmentMessage({ stream_id: 42, merkle_root: "ab".repeat(32), call_count: 20 })
        .toString("hex")
    ).toBe(
      "02000000000000002a" + "ab".repeat(32) + "0000000000000014"
    );
  });

  it("orders internal-node children by byte value, not argument order", () => {
    const a = Buffer.alloc(32, 0xaa);
    const b = Buffer.alloc(32, 0x11);
    expect(canonical.hashInternal(a, b)).toEqual(canonical.hashInternal(b, a));
  });

  it("separates leaf and internal hashing domains", () => {
    // A 64-byte internal preimage and a 120-byte leaf preimage can never
    // collide, which is what stops an internal node being replayed as a leaf.
    const leaf = canonical.leafHash(attestation);
    const internal = canonical.hashInternal(leaf, leaf);
    expect(leaf.toString("hex")).not.toBe(internal.toString("hex"));
  });

  it("hashes payloads independently of key order", () => {
    expect(canonical.hashPayload({ a: 1, b: { c: 2, d: 3 } })).toEqual(
      canonical.hashPayload({ b: { d: 3, c: 2 }, a: 1 })
    );
  });

  it("rejects a hash field of the wrong width", () => {
    expect(() =>
      canonical.encodeLeafPreimage({ ...attestation, nonce: "00".repeat(16) })
    ).toThrow(/64 hex characters/);
  });
});

describe("AttestationBuilder", () => {
  it("assigns strictly increasing call indices", () => {
    const builder = newBuilder();
    const indices = attestMany(builder, 1, 5).map((a) => a.call_index);
    expect(indices).toEqual([0, 1, 2, 3, 4]);
  });

  it("keeps a separate counter per stream", () => {
    const builder = newBuilder();
    builder.attest({ streamId: 1, request: {}, response: {} });
    expect(builder.attest({ streamId: 2, request: {}, response: {} }).call_index).toBe(0);
  });

  it("resumes the counter after a restart via seed()", () => {
    const builder = newBuilder();
    builder.seed(9, 41);
    expect(builder.attest({ streamId: 9, request: {}, response: {} }).call_index).toBe(42);
  });

  it("never repeats a nonce", () => {
    const builder = newBuilder();
    const nonces = new Set(attestMany(builder, 1, 200).map((a) => a.nonce));
    expect(nonces.size).toBe(200);
  });

  it("produces attestations that verify under the signer's public key", () => {
    const attestation = newBuilder().attest({ streamId: 3, request: { x: 1 }, response: { y: 2 } });
    expect(new AttestationVerifier().check(attestation, { signer: SELLER.publicKey() }).valid).toBe(
      true
    );
  });

  describe("wrap()", () => {
    it("attaches an attestation without disturbing the handler's response", async () => {
      const handler = newBuilder().wrap(async (req) => ({ answer: req.n * 2 }));
      const result = await handler({ n: 21 }, { streamId: 5 });

      expect(result.answer).toBe(42);
      expect(result.attestation.stream_id).toBe(5);
      expect(new AttestationVerifier().check(result.attestation).valid).toBe(true);
    });

    it("moves a non-object response under `data` so there is room for the attestation", async () => {
      const handler = newBuilder().wrap(async () => "plain text");
      const result = await handler({}, { streamId: 5 });
      expect(result.data).toBe("plain text");
      expect(result.attestation).toBeDefined();
    });

    it("can derive the stream id from the request", async () => {
      const handler = newBuilder().wrap(async () => ({ ok: true }), {
        streamId: (req) => req.stream,
      });
      const result = await handler({ stream: 77 }, {});
      expect(result.attestation.stream_id).toBe(77);
    });
  });
});

describe("AttestationVerifier", () => {
  let verifier;
  let builder;

  beforeEach(() => {
    verifier = new AttestationVerifier({ now: () => 1_700_000_000 });
    builder = newBuilder();
  });

  it("accepts a well-formed attestation", () => {
    const attestation = builder.attest({ streamId: 1, request: {}, response: {} });
    expect(verifier.check(attestation, { signer: SELLER.publicKey() })).toMatchObject({
      valid: true,
      reason: Reason.OK,
    });
  });

  it.each([
    ["response_hash", { response_hash: "aa".repeat(32) }],
    ["request_hash", { request_hash: "bb".repeat(32) }],
    ["timestamp", { timestamp: 1_600_000_000 }],
    ["call_index", { call_index: 99 }],
    ["stream_id", { stream_id: 2 }],
    ["nonce", { nonce: "cc".repeat(32) }],
  ])("rejects an attestation whose %s was altered after signing", (_field, patch) => {
    const attestation = { ...builder.attest({ streamId: 1, request: {}, response: {} }), ...patch };
    expect(verifier.check(attestation, { signer: SELLER.publicKey() }).reason).toBe(
      Reason.BAD_SIGNATURE
    );
  });

  it("rejects an attestation signed by the wrong key", () => {
    const attestation = newBuilder(IMPOSTOR).attest({ streamId: 1, request: {}, response: {} });
    // The claimed signer is checked before the curve arithmetic, so this is a
    // mismatch rather than a bad signature — both are refusals.
    expect(verifier.check(attestation, { signer: SELLER.publicKey() }).reason).toBe(
      Reason.SIGNER_MISMATCH
    );
  });

  it("rejects a signature transplanted from another seller", () => {
    const honest = builder.attest({ streamId: 1, request: {}, response: {} });
    const forged = newBuilder(IMPOSTOR).attest({ streamId: 1, request: {}, response: {} });
    // Same claimed signer, signature actually produced by someone else.
    const transplanted = { ...honest, signature: forged.signature };
    expect(verifier.check(transplanted, { signer: SELLER.publicKey() }).reason).toBe(
      Reason.BAD_SIGNATURE
    );
  });

  it("flags a bad signature as provable on-chain", () => {
    const attestation = builder.attest({ streamId: 1, request: {}, response: {} });
    const result = verifier.check(
      { ...attestation, signature: "ab".repeat(64) },
      { signer: SELLER.publicKey() }
    );
    expect(result.reason).toBe(Reason.BAD_SIGNATURE);
    expect(result.provableOnChain).toBe(true);
  });

  it("rejects an attestation for a different stream", () => {
    const attestation = builder.attest({ streamId: 1, request: {}, response: {} });
    expect(verifier.check(attestation, { streamId: 2 }).reason).toBe(Reason.STREAM_MISMATCH);
  });

  it("rejects an attestation dated far in the future", () => {
    const attestation = builder.attest({
      streamId: 1,
      request: {},
      response: {},
      timestamp: 1_700_999_999,
    });
    expect(verifier.check(attestation).reason).toBe(Reason.CLOCK_SKEW);
  });

  it("rejects a replayed nonce on the second presentation", async () => {
    const attestation = builder.attest({ streamId: 1, request: {}, response: {} });
    expect((await verifier.accept(attestation)).valid).toBe(true);

    const result = await verifier.accept(attestation);
    expect(result.reason).toBe(Reason.NONCE_REUSED);
    expect(result.provableOnChain).toBe(true);
  });

  it("rejects a nonce replayed under a fresh call index", async () => {
    const first = builder.attest({ streamId: 1, request: {}, response: {} });
    await verifier.accept(first);

    // A seller re-serving an old nonce as a "new" call has to re-sign it,
    // so this is a genuinely valid signature over a spent nonce.
    const replay = builder.attest({
      streamId: 1,
      request: {},
      response: {},
      nonce: first.nonce,
    });
    expect((await verifier.accept(replay)).reason).toBe(Reason.NONCE_REUSED);
  });

  it("rejects a call index that does not advance", async () => {
    await verifier.accept(builder.attest({ streamId: 1, request: {}, response: {}, callIndex: 5 }));
    const stale = builder.attest({ streamId: 1, request: {}, response: {}, callIndex: 3 });
    expect((await verifier.accept(stale)).reason).toBe(Reason.INDEX_NOT_MONOTONIC);
  });

  it("keeps nonce sets separate per stream", async () => {
    const first = builder.attest({ streamId: 1, request: {}, response: {} });
    await verifier.accept(first);

    // Same nonce, different stream: a distinct signed message, and the streams
    // do not share a replay set.
    const other = builder.attest({ streamId: 2, request: {}, response: {}, nonce: first.nonce });
    expect((await verifier.accept(other)).valid).toBe(true);
  });

  describe("checkSet", () => {
    it("accepts a clean run", () => {
      const result = verifier.checkSet(attestMany(builder, 1, 20), {
        signer: SELLER.publicKey(),
        streamId: 1,
      });
      expect(result.valid).toBe(true);
      expect(result.firstInvalidIndex).toBeNull();
    });

    it("pinpoints the first forged member", () => {
      const set = attestMany(builder, 1, 10);
      set[6] = { ...set[6], signature: "ff".repeat(64) };

      const result = verifier.checkSet(set, { signer: SELLER.publicKey(), streamId: 1 });
      expect(result.valid).toBe(false);
      expect(result.firstInvalidIndex).toBe(6);
      expect(result.results[6].reason).toBe(Reason.BAD_SIGNATURE);
      expect(result.results[5].valid).toBe(true);
    });

    it("catches a nonce repeated inside one set, without any store", () => {
      const set = attestMany(builder, 1, 5);
      set[3] = builder.attest({
        streamId: 1,
        request: {},
        response: {},
        callIndex: 3,
        nonce: set[0].nonce,
      });

      const result = verifier.checkSet(set, { signer: SELLER.publicKey(), streamId: 1 });
      expect(result.results[3].reason).toBe(Reason.NONCE_REUSED);
    });
  });
});

describe("MerkleBatchBuilder", () => {
  let builder;

  beforeEach(() => {
    builder = newBuilder();
  });

  // Sizes cover a perfect tree, both odd-tail shapes, and the single-leaf case
  // where the root is the leaf and the proof is empty.
  it.each([1, 2, 3, 5, 8, 11, 50, 64])(
    "produces a proof for every leaf in a batch of %i",
    (size) => {
      const attestations = attestMany(builder, 1, size);
      const batch = MerkleBatchBuilder.build(attestations);

      expect(batch.callCount).toBe(size);
      attestations.forEach((attestation, position) => {
        const proof = MerkleBatchBuilder.proofForPosition(batch, position);
        expect(MerkleBatchBuilder.verifyProof(attestation, proof, batch.root)).toBe(true);
      });
    }
  );

  it("keeps proof length logarithmic in batch size", () => {
    const batch = MerkleBatchBuilder.build(attestMany(builder, 1, 128));
    expect(MerkleBatchBuilder.proofForPosition(batch, 0)).toHaveLength(7);
  });

  it("rejects a proof for a leaf that is not in the batch", () => {
    const attestations = attestMany(builder, 1, 8);
    const batch = MerkleBatchBuilder.build(attestations);
    const outsider = newBuilder().attest({ streamId: 1, request: { other: true }, response: {} });

    expect(
      MerkleBatchBuilder.verifyProof(
        outsider,
        MerkleBatchBuilder.proofForPosition(batch, 3),
        batch.root
      )
    ).toBe(false);
  });

  it("changes the root when any single leaf changes", () => {
    const attestations = attestMany(builder, 1, 16);
    const original = MerkleBatchBuilder.build(attestations).root;

    const tampered = [...attestations];
    tampered[9] = { ...tampered[9], response_hash: "de".repeat(32) };
    expect(MerkleBatchBuilder.build(tampered).root).not.toBe(original);
  });

  it("addresses a leaf by call index as well as position", () => {
    const attestations = attestMany(builder, 1, 10, 100);
    const batch = MerkleBatchBuilder.build(attestations);

    expect(batch.firstCallIndex).toBe(100);
    expect(MerkleBatchBuilder.proofForCallIndex(batch, 104)).toEqual(
      MerkleBatchBuilder.proofForPosition(batch, 4)
    );
  });

  it("refuses a batch with a gap in its call indices", () => {
    const attestations = attestMany(builder, 1, 5);
    attestations.splice(2, 1);
    // The contract turns call_index into a refundable position by subtracting
    // first_call_index; a gap would make that arithmetic wrong.
    expect(() => MerkleBatchBuilder.build(attestations)).toThrow(/contiguous/);
  });

  it("refuses a batch that mixes streams", () => {
    const attestations = [
      builder.attest({ streamId: 1, request: {}, response: {} }),
      builder.attest({ streamId: 2, request: {}, response: {}, callIndex: 1 }),
    ];
    expect(() => MerkleBatchBuilder.build(attestations)).toThrow(/mixes streams/);
  });

  it("refuses an empty batch", () => {
    expect(() => MerkleBatchBuilder.build([])).toThrow(/at least one/);
  });

  describe("batch commitment signature", () => {
    it("verifies under the signing key", () => {
      const batch = MerkleBatchBuilder.build(attestMany(builder, 1, 20));
      const commitment = MerkleBatchBuilder.signBatch(batch, SELLER);
      expect(MerkleBatchBuilder.verifyBatchSignature(commitment, SELLER.publicKey())).toBe(true);
    });

    it("does not verify under any other key", () => {
      const batch = MerkleBatchBuilder.build(attestMany(builder, 1, 20));
      const commitment = MerkleBatchBuilder.signBatch(batch, SELLER);
      expect(MerkleBatchBuilder.verifyBatchSignature(commitment, IMPOSTOR.publicKey())).toBe(false);
    });

    it("does not cover a different call count", () => {
      const batch = MerkleBatchBuilder.build(attestMany(builder, 1, 20));
      const commitment = MerkleBatchBuilder.signBatch(batch, SELLER);
      // Inflating the count is the obvious over-billing move; the count is
      // inside the signed bytes precisely so it fails here.
      expect(
        MerkleBatchBuilder.verifyBatchSignature(
          { ...commitment, callCount: 200 },
          SELLER.publicKey()
        )
      ).toBe(false);
    });

    it("does not carry across streams", () => {
      const batch = MerkleBatchBuilder.build(attestMany(builder, 1, 20));
      const commitment = MerkleBatchBuilder.signBatch(batch, SELLER);
      expect(
        MerkleBatchBuilder.verifyBatchSignature({ ...commitment, streamId: 99 }, SELLER.publicKey())
      ).toBe(false);
    });
  });
});
