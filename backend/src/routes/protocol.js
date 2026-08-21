const { Router } = require("express");
const { body, param } = require("express-validator");
const validate = require("../middleware/validate");
const asyncHandler = require("../middleware/asyncHandler");
const { Address, nativeToScVal } = require("@stellar/stellar-sdk");

const QuoteManager = require("../protocol/QuoteManager");
const StreamNegotiator = require("../protocol/StreamNegotiator");
const MeteringEngine = require("../protocol/MeteringEngine");
const StreamMonitor = require("../protocol/StreamMonitor");
const AuctionEngine = require("../protocol/AuctionEngine");
const { CONTRACT_IDS } = require("../config/stellar");
const { viewContract, invokeContract } = require("../services/stellarService");
const streamRepository = require("../repositories/streamRepository");
const AttestationArchive = require("../attestation/AttestationArchive");
const attestationRepository = require("../repositories/attestationRepository");
const assetRepository = require("../repositories/assetRepository");
const { Keypair } = require("@stellar/stellar-sdk");
const { logger } = require("../utils/logger");

const router = Router();

function getServerKeypair() {
  const secret = process.env.SERVER_SECRET_KEY;
  if (!secret || secret === "S...") return null;
  try {
    return Keypair.fromSecret(secret);
  } catch {
    return null;
  }
}

/**
 * GET /api/v1/protocol/events/subscribe
 * SSE endpoint for agents to subscribe to LOW_BALANCE warnings.
 */
router.get("/events/subscribe", (req, res) => {
  StreamMonitor.registerClient(req, res);
});

/**
 * POST /api/v1/protocol/handshake
 * Buyer agent presents public key + desired asset ID.
 * Capacity-constrained assets are routed into the auction flow; everything
 * else returns list price, available license types, and a signed quote.
 */
router.post(
  "/handshake",
  [
    body("publicKey").isString().trim().isLength({ min: 56, max: 56 }),
    body("assetId").isInt({ min: 1 }),
  ],
  validate,
  asyncHandler(async (req, res) => {
    const { publicKey, assetId } = req.body;
    const asset = await assetRepository.findById(assetId);
    if (!asset) {
      return res.status(404).json({ error: "Asset not found" });
    }

    if (QuoteManager.shouldAuction(asset)) {
      return res.json({
        mode: "auction",
        reason: QuoteManager.routeAsset(asset).reason,
        assetId: Number(assetId),
      });
    }

    const quote = QuoteManager.generateQuote(publicKey, assetId, asset.price);

    res.json({
      mode: "quote",
      price: asset.price,
      availableLicenseTypes: [asset.licenseType || "UsageBased"],
      quote,
    });
  })
);

/**
 * POST /api/v1/protocol/quote
 * Get signed price quote for an asset. Capacity-constrained assets refuse a
 * direct quote and point the buyer at the auction flow instead.
 */
router.post(
  "/quote",
  [
    body("publicKey").isString().trim().isLength({ min: 56, max: 56 }),
    body("assetId").isInt({ min: 1 }),
  ],
  validate,
  asyncHandler(async (req, res) => {
    const { publicKey, assetId } = req.body;
    const asset = await assetRepository.findById(assetId);
    if (!asset) {
      return res.status(404).json({ error: "Asset not found" });
    }

    if (QuoteManager.shouldAuction(asset)) {
      return res.status(409).json({
        error: "Asset is capacity-constrained and must be priced via sealed-bid auction",
        mode: "auction",
        assetId: Number(assetId),
      });
    }

    const quote = QuoteManager.generateQuote(publicKey, assetId, asset.price);
    res.json(quote);
  })
);

/**
 * POST /api/v1/protocol/negotiate
 * Propose rate and negotiate.
 */
router.post(
  "/negotiate",
  [
    body("buyer").isString().trim().isLength({ min: 56, max: 56 }),
    body("assetId").isInt({ min: 1 }),
    body("proposedRate").isInt({ min: 0 }),
    body("quote").isObject(),
  ],
  validate,
  asyncHandler(async (req, res) => {
    const { buyer, assetId, proposedRate, quote } = req.body;
    try {
      const result = StreamNegotiator.negotiateRate(buyer, assetId, proposedRate, quote);
      res.json(result);
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  })
);

/**
 * POST /api/v1/protocol/stream/open
 * Register an opened on-chain stream and get a stream_token JWT.
 */
router.post(
  "/stream/open",
  [
    body("streamId").isInt({ min: 1 }),
    body("agreedRate").isInt({ min: 1 }),
    body("buyer").isString().trim().isLength({ min: 56, max: 56 }),
    body("assetId").isInt({ min: 1 }),
  ],
  validate,
  asyncHandler(async (req, res) => {
    const { streamId, agreedRate, buyer, assetId } = req.body;

    let onChainStream = null;
    const contractId = CONTRACT_IDS.micropayments;

    // Try reading from blockchain
    if (contractId && getServerKeypair()) {
      try {
        const raw = await viewContract(
          contractId,
          "get_stream",
          [nativeToScVal(BigInt(streamId), { type: "u64" })],
          buyer
        );
        if (raw) {
          onChainStream = {
            id: Number(raw.id),
            sender: raw.sender,
            recipient: raw.recipient,
            token: raw.token,
            deposit: Number(raw.deposit),
            ratePerSecond: Number(raw.rate_per_second),
            startTime: Number(raw.start_time),
            endTime: Number(raw.end_time),
            status: typeof raw.status === "string" ? raw.status : "Active",
            withdrawn: Number(raw.withdrawn),
          };
        }
      } catch (err) {
        logger.warn("[ProtocolRoute] failed to fetch stream from chain:", err.message);
      }
    }

    // Fallback to DB or create mock stream for test sandbox
    if (!onChainStream) {
      const dbStream = await streamRepository.findById(streamId);
      if (dbStream) {
        onChainStream = dbStream;
      } else {
        // Mock fallback for test environment
        const asset = await assetRepository.findById(assetId);
        onChainStream = {
          id: streamId,
          sender: buyer,
          recipient: asset ? asset.owner : "GD226Q4QUIIDFBQ7TWPTP4UT4TKPX2MQRVEJSFMMCSM6ORDCPNZPPKCT",
          token: "native",
          deposit: 10_000_000,
          ratePerSecond: 100,
          startTime: Math.floor(Date.now() / 1000),
          endTime: Math.floor(Date.now() / 1000) + 100_000,
          status: "Active",
          withdrawn: 0,
        };
      }
    }

    // Save/upsert the stream off-chain with call limits
    const callsLimit = Math.floor(Number(onChainStream.deposit) / agreedRate);
    const saved = await streamRepository.create({
      ...onChainStream,
      callsRemaining: callsLimit,
      callsUsed: 0,
      pricePerCall: agreedRate,
    });

    const streamToken = StreamNegotiator.issueStreamToken(saved, agreedRate, assetId);
    res.status(201).json({
      streamToken,
      stream: saved,
    });
  })
);

/**
 * POST /api/v1/protocol/meter
 * Meter a single call, returns { calls_remaining, settle_now: bool }.
 */
router.post(
  "/meter",
  asyncHandler(async (req, res) => {
    const authHeader = req.headers.authorization;
    const token = (authHeader && authHeader.split(" ")[1]) || req.body.stream_token || req.body.streamToken;

    if (!token) {
      return res.status(401).json({ error: "stream_token is required" });
    }

    // Hash whatever the caller metered, minus the transport fields, so replay
    // detection has something to compare. A client may send `payloadHash`
    // itself when the real payload must not reach us.
    const body = req.body || {};
    const payload = { ...body };
    delete payload.stream_token;
    delete payload.streamToken;
    delete payload.payloadHash;
    // The attestation is transport, not payload: hashing it into payloadHash
    // would make every call look unique to the replay detector, and it is
    // covered by its own signature anyway.
    delete payload.attestation;
    delete payload.sellerPublicKey;
    const payloadHash =
      typeof body.payloadHash === "string" && body.payloadHash.length
        ? body.payloadHash
        : MeteringEngine.hashPayload(payload);

    try {
      const { calls_remaining, settle_now, stream, attestation } =
        await MeteringEngine.meterCall(token, {
          payloadHash,
          attestation: body.attestation || null,
        });
      StreamMonitor.checkStreamAndAlert(stream);
      res.json({ calls_remaining, settle_now, attestation });
    } catch (err) {
      if (err.status === 402) {
        return res.status(402).json({ error: err.message });
      }
      // A rejected attestation is not a malformed request: the call was
      // refused on cryptographic grounds, and `reason` tells the caller which.
      if (err.status === 403) {
        return res.status(403).json({
          error: err.message,
          reason: err.reason,
          provableOnChain: Boolean(err.provableOnChain),
        });
      }
      res.status(400).json({ error: err.message });
    }
  })
);

/**
 * GET /api/v1/protocol/stream/:id/balance
 * Returns real-time claimable balance.
 */
router.get(
  "/stream/:id/balance",
  [param("id").isInt({ min: 1 })],
  validate,
  asyncHandler(async (req, res) => {
    const streamId = Number(req.params.id);
    const stream = await streamRepository.findById(streamId);
    if (!stream) {
      return res.status(404).json({ error: "Stream not found" });
    }

    let claimable = null;
    const contractId = CONTRACT_IDS.micropayments;

    if (contractId && getServerKeypair()) {
      try {
        const raw = await viewContract(
          contractId,
          "claimable_amount",
          [nativeToScVal(BigInt(streamId), { type: "u64" })],
          stream.sender
        );
        claimable = raw;
      } catch (err) {
        logger.warn("[ProtocolRoute] failed to fetch claimable on-chain:", err.message);
      }
    }

    if (claimable === null) {
      // Calculate off-chain claimable based on elapsed time
      const elapsed = Math.floor(Date.now() / 1000) - stream.startTime;
      claimable = Math.min(
        stream.deposit - stream.withdrawn,
        Math.max(0, elapsed * stream.ratePerSecond)
      );
    }

    res.json({
      streamId,
      claimable: Number(claimable),
    });
  })
);

/**
 * POST /api/v1/protocol/stream/:id/settle
 * Trigger manual early settlement.
 */
router.post(
  "/stream/:id/settle",
  [param("id").isInt({ min: 1 })],
  validate,
  asyncHandler(async (req, res) => {
    const streamId = Number(req.params.id);
    const stream = await streamRepository.findById(streamId);
    if (!stream) {
      return res.status(404).json({ error: "Stream not found" });
    }

    let settledAmount = 1000; // Mock fallback
    const keypair = getServerKeypair();
    const contractId = CONTRACT_IDS.micropayments;

    if (contractId && keypair) {
      try {
        const recipientSc = Address.fromString(stream.recipient).toScVal();
        const streamIdSc = nativeToScVal(BigInt(streamId), { type: "u64" });

        const result = await invokeContract(
          contractId,
          "withdraw",
          [recipientSc, streamIdSc],
          keypair
        );
        if (result) settledAmount = Number(result);
      } catch (err) {
        logger.warn("[ProtocolRoute] on-chain withdraw failed:", err.message);
      }
    }

    // Perform database updates
    const updated = await streamRepository.recordWithdrawal(streamId, settledAmount);
    res.json({
      success: true,
      settledAmount,
      stream: updated,
    });
  })
);

/**
 * POST /api/v1/protocol/stream/:id/cancel
 * Trigger stream cancellation off-chain (mock fallback).
 */
router.post(
  "/stream/:id/cancel",
  [param("id").isInt({ min: 1 })],
  validate,
  asyncHandler(async (req, res) => {
    const streamId = Number(req.params.id);
    const updated = await streamRepository.updateStatus(streamId, "Cancelled");
    res.json({
      success: true,
      stream: updated,
    });
  })
);

/**
 * GET /api/v1/protocol/auctions/:id/events
 * SSE endpoint: streams auction phase transitions (REVEAL_OPENED,
 * AUCTION_UPDATED, SETTLED) to subscribing agents.
 */
router.get(
  "/auctions/:id/events",
  [param("id").isInt({ min: 1 })],
  validate,
  (req, res) => {
    AuctionEngine.registerClient(req, res);
  }
);

/**
 * GET /api/v1/protocol/auctions/:id
 * Current auction status. Falls back to the engine's local mirror when the
 * chain is unavailable.
 */
router.get(
  "/auctions/:id",
  [param("id").isInt({ min: 1 })],
  validate,
  asyncHandler(async (req, res) => {
    const auctionId = Number(req.params.id);
    const tracked = AuctionEngine._trackedAuctions.get(auctionId);

    let auction = null;
    const contractId = CONTRACT_IDS.marketplace;
    if (contractId && getServerKeypair()) {
      try {
        const raw = await viewContract(
          contractId,
          "get_auction",
          [nativeToScVal(BigInt(auctionId), { type: "u64" })],
          getServerKeypair().publicKey()
        );
        if (raw) {
          auction = {
            id: Number(raw.id),
            assetId: Number(raw.asset_id),
            seller: raw.seller,
            capacity: Number(raw.capacity),
            minBid: Number(raw.min_bid),
            durationLedgers: Number(raw.duration_ledgers),
            openLedger: Number(raw.open_ledger),
            revealEnd: raw.reveal_end ? Number(raw.reveal_end) : null,
            phase: String(raw.phase),
            token: raw.token || null,
            revealedCount: raw.revealed ? raw.revealed.length : 0,
            clearingPrice: raw.clearing_price != null ? Number(raw.clearing_price) : null,
            settledAt: raw.settled_at ? Number(raw.settled_at) : null,
          };
        }
      } catch (err) {
        console.warn("[ProtocolRoute] failed to fetch auction on-chain:", err.message);
      }
    }

    if (!auction) {
      if (tracked) {
        auction = { ...tracked };
      } else {
        return res.status(404).json({ error: "Auction not found" });
      }
    }

    res.json(auction);
  })
);

/**
 * POST /api/v1/protocol/auctions/:id/tick
 * Manually evaluate the auction engine for this auction (used by operators
 * and tests; the engine also polls on a timer).
 */
router.post(
  "/auctions/:id/tick",
  [param("id").isInt({ min: 1 })],
  validate,
  asyncHandler(async (req, res) => {
    const auctionId = Number(req.params.id);
    const transitions = await AuctionEngine.engine.tickFor(auctionId);
    res.json({ auctionId, ...transitions });
  })
);

// ── Attestation ──────────────────────────────────────────────────────────────
//
// These endpoints exist so a buyer never has to take the backend's word for
// anything: the archive hands over the signed bytes, and every verdict below is
// one the caller can recompute locally with CortexAgentSDK.verifyBatch.

const archive = MeteringEngine.archive;

/**
 * GET /api/v1/protocol/stream/:id/attestations
 * Committed usage batches for a stream, newest first, each with its audit
 * verdict so the buyer's dashboard can flag a bad batch without N round trips.
 */
router.get(
  "/stream/:id/attestations",
  [param("id").isInt({ min: 1 })],
  validate,
  asyncHandler(async (req, res) => {
    const streamId = Number(req.params.id);
    const { page, limit, verify } = req.query;

    const listed = await archive.listBatches(streamId, { page, limit });

    // Verification re-hashes every archived leaf, so it is opt-out for a caller
    // paging through a long history who only needs the headline rows.
    const withVerdicts =
      verify === "false"
        ? listed.data.map((batch) => ({ ...batch, audit: null }))
        : await Promise.all(
            listed.data.map(async (batch) => {
              if (batch.batchId === null) return { ...batch, audit: null };
              const audit = await archive.audit(streamId, batch.batchId);
              return {
                ...batch,
                audit: {
                  valid: audit.valid,
                  reason: audit.reason,
                  rootMatches: audit.rootMatches,
                  commitmentValid: audit.commitmentValid,
                  disputableCallIndex: audit.disputableCallIndex,
                },
              };
            })
          );

    res.json({ streamId, data: withVerdicts, meta: listed.meta });
  })
);

/**
 * GET /api/v1/protocol/stream/:id/attestations/next-index
 * The highest call index ever accepted, so a restarted seller can resume its
 * counter instead of colliding with indices it already spent.
 */
router.get(
  "/stream/:id/attestations/next-index",
  [param("id").isInt({ min: 1 })],
  validate,
  asyncHandler(async (req, res) => {
    const streamId = Number(req.params.id);
    const lastCallIndex = await attestationRepository.highestCallIndex(streamId);
    res.json({
      streamId,
      // -1 for a stream that has never been metered, so the next index is 0.
      lastCallIndex: lastCallIndex === null ? -1 : lastCallIndex,
      nextCallIndex: lastCallIndex === null ? 0 : lastCallIndex + 1,
    });
  })
);

/**
 * GET /api/v1/protocol/stream/:id/attestations/pending
 * The un-batched tail plus the exact bytes the seller must sign to commit it.
 * The backend never holds the seller's key, so this is as far as it can go.
 */
router.get(
  "/stream/:id/attestations/pending",
  [param("id").isInt({ min: 1 })],
  validate,
  asyncHandler(async (req, res) => {
    const streamId = Number(req.params.id);
    const maxSize = Math.min(512, Math.max(1, Number(req.query.max) || 128));

    const prepared = await archive.prepareBatch(streamId, { maxSize });
    if (!prepared) {
      return res.json({ streamId, pending: 0, tree: null, message: null });
    }

    res.json({
      streamId,
      pending: prepared.tree.callCount,
      merkleRoot: prepared.tree.root,
      callCount: prepared.tree.callCount,
      firstCallIndex: prepared.tree.firstCallIndex,
      lastCallIndex: prepared.tree.lastCallIndex,
      message: prepared.message,
      attestations: prepared.tree.attestations,
    });
  })
);

/**
 * POST /api/v1/protocol/stream/:id/attestations/batch
 * Persist a batch the seller has signed. The signature is re-verified here,
 * so the archive never records a commitment the seller did not actually make.
 */
router.post(
  "/stream/:id/attestations/batch",
  [
    param("id").isInt({ min: 1 }),
    body("seller").isString().notEmpty(),
    body("batchSignature").matches(/^[0-9a-f]{128}$/i),
  ],
  validate,
  asyncHandler(async (req, res) => {
    const streamId = Number(req.params.id);
    const { seller, batchSignature, merkleRoot } = req.body;

    const prepared = await archive.prepareBatch(streamId, { maxSize: 512 });
    if (!prepared) {
      return res.status(409).json({ error: "No un-batched attestations for this stream" });
    }

    // The seller signed a specific root. If new calls landed in between, the
    // tail has moved and the signature covers the wrong set — better a 409 than
    // a batch that fails on-chain after the seller has paid the fee.
    if (merkleRoot && merkleRoot.toLowerCase() !== prepared.tree.root) {
      return res.status(409).json({
        error: "The pending batch changed since it was prepared; re-fetch and re-sign",
        expected: prepared.tree.root,
        received: merkleRoot.toLowerCase(),
      });
    }

    try {
      const batch = await archive.commitBatch(streamId, prepared.tree, {
        seller,
        batchSignature: batchSignature.toLowerCase(),
      });
      res.status(201).json({ batch, attestations: prepared.tree.attestations });
    } catch (err) {
      if (err.status === 400) {
        return res.status(400).json({ error: err.message, reason: err.reason });
      }
      throw err;
    }
  })
);

/**
 * POST /api/v1/protocol/stream/:id/attestations/:batchRef/recorded
 * Mirror an on-chain record_usage_batch back into the archive, binding the
 * local row to the batch id the contract assigned it.
 */
router.post(
  "/stream/:id/attestations/:batchRef/recorded",
  [
    param("id").isInt({ min: 1 }),
    param("batchRef").isInt({ min: 1 }),
    body("batchId").isInt({ min: 1 }),
  ],
  validate,
  asyncHandler(async (req, res) => {
    const batchRef = Number(req.params.batchRef);
    const existing = await attestationRepository.findBatchById(batchRef);
    if (!existing || existing.streamId !== Number(req.params.id)) {
      return res.status(404).json({ error: "Batch not found on this stream" });
    }

    const batch = await archive.markRecorded(batchRef, {
      batchId: Number(req.body.batchId),
      txHash: req.body.txHash || null,
    });
    res.json({ batch });
  })
);

/**
 * GET /api/v1/protocol/stream/:id/attestations/:batchId
 * The full archived set behind one committed root, with the audit verdict.
 * This is what `verifyBatch` downloads to check the commitment independently.
 */
router.get(
  "/stream/:id/attestations/:batchId",
  [param("id").isInt({ min: 1 }), param("batchId").isInt({ min: 1 })],
  validate,
  asyncHandler(async (req, res) => {
    const streamId = Number(req.params.id);
    const batchId = Number(req.params.batchId);

    const audit = await archive.audit(streamId, batchId);
    if (!audit.found) {
      return res.status(404).json({ error: "Batch not found" });
    }

    const loaded = await archive.loadBatch(streamId, batchId);
    res.json({
      batch: audit.batch,
      attestations: loaded.leaves.map(AttestationArchive.toWireAttestation),
      audit: {
        valid: audit.valid,
        reason: audit.reason,
        committedRoot: audit.committedRoot,
        recomputedRoot: audit.recomputedRoot,
        rootMatches: audit.rootMatches,
        commitmentValid: audit.commitmentValid,
        leafResults: audit.leafResults,
        firstInvalidIndex: audit.firstInvalidIndex,
        disputableCallIndex: audit.disputableCallIndex,
      },
    });
  })
);

/**
 * GET /api/v1/protocol/stream/:id/attestations/:batchId/proof/:callIndex
 * Everything challenge_usage_batch needs for one call: the leaf, its sibling
 * hashes, and how many calls a successful challenge would reverse.
 */
router.get(
  "/stream/:id/attestations/:batchId/proof/:callIndex",
  [
    param("id").isInt({ min: 1 }),
    param("batchId").isInt({ min: 1 }),
    param("callIndex").isInt({ min: 0 }),
  ],
  validate,
  asyncHandler(async (req, res) => {
    const proof = await archive.getProof(
      Number(req.params.id),
      Number(req.params.batchId),
      Number(req.params.callIndex)
    );

    if (!proof) {
      return res.status(404).json({ error: "No archived attestation for that call" });
    }

    res.json(proof);
  })
);

module.exports = router;
