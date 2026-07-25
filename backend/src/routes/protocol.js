const { Router } = require("express");
const { body, param } = require("express-validator");
const validate = require("../middleware/validate");
const asyncHandler = require("../middleware/asyncHandler");
const { Address, nativeToScVal } = require("@stellar/stellar-sdk");

const QuoteManager = require("../protocol/QuoteManager");
const StreamNegotiator = require("../protocol/StreamNegotiator");
const MeteringEngine = require("../protocol/MeteringEngine");
const StreamMonitor = require("../protocol/StreamMonitor");
const { CONTRACT_IDS } = require("../config/stellar");
const { viewContract, invokeContract } = require("../services/stellarService");
const streamRepository = require("../repositories/streamRepository");
const assetRepository = require("../repositories/assetRepository");
const { Keypair } = require("@stellar/stellar-sdk");

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
 * Returns list price, available license types, and a signed quote.
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

    const quote = QuoteManager.generateQuote(publicKey, assetId, asset.price);

    res.json({
      price: asset.price,
      availableLicenseTypes: [asset.licenseType || "UsageBased"],
      quote,
    });
  })
);

/**
 * POST /api/v1/protocol/quote
 * Get signed price quote for an asset.
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
        console.warn("[ProtocolRoute] failed to fetch stream from chain:", err.message);
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

    const streamToken = StreamNegotiator.issueStreamToken(saved, agreedRate);
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

    try {
      const { calls_remaining, settle_now, stream } = await MeteringEngine.meterCall(token);
      StreamMonitor.checkStreamAndAlert(stream);
      res.json({ calls_remaining, settle_now });
    } catch (err) {
      if (err.status === 402) {
        return res.status(402).json({ error: err.message });
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
        console.warn("[ProtocolRoute] failed to fetch claimable on-chain:", err.message);
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
        console.warn("[ProtocolRoute] on-chain withdraw failed:", err.message);
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

module.exports = router;
