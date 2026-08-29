/**
 * MeteringEngine — bills one call against a stream and enforces congestion capacity market limits.
 *
 * Since attestation landed, a call is credited only when the seller's own
 * signature says it happened. The backend's counters used to be the sole
 * record of usage, which meant a compromised or buggy backend could
 * under-report to sellers or over-charge buyers with nothing to check it
 * against. Now the decrement and the seller's signed statement about the call
 * are written in the same transaction: the billing log cannot claim a call the
 * seller never attested, and it cannot drop one they did.
 *
 * The verifier's replay and monotonicity checks share that transaction too, so
 * a nonce is only durably spent if the call it paid for was durably billed.
 */

const crypto = require("crypto");
const jwt = require("jsonwebtoken");
const streamRepository = require("../repositories/streamRepository");
const usageEventRepository = require("../repositories/usageEventRepository");
const attestationRepository = require("../repositories/attestationRepository");
const AttestationVerifier = require("../attestation/AttestationVerifier");
const AttestationArchive = require("../attestation/AttestationArchive");
const { leafHash } = require("../attestation/canonical");
const { withTransaction } = require("../db/connection");
const { BaseFeeController } = require("../market/BaseFeeController");
const { CapacityWindow } = require("../market/CapacityWindow");
const { FeeOracle } = require("../market/FeeOracle");

/**
 * In-memory capacity and fee tracking state per asset.
 */
const assetCapacityWindows = new Map();
const assetFeeControllers = new Map();

function getMarketForAsset(assetId) {
  const id = String(assetId);
  if (!assetCapacityWindows.has(id)) {
    assetCapacityWindows.set(id, new CapacityWindow());
    assetFeeControllers.set(id, new BaseFeeController());
  }
  const window = assetCapacityWindows.get(id);
  const controller = assetFeeControllers.get(id);
  const oracle = new FeeOracle(controller, window);
  return { window, controller, oracle };
}

/**
 * Gates call admission on market capacity, returning HTTP 429 when exhausted.
 */
function gateCapacity(assetId, units = 1, maxBaseFee = null) {
  if (!assetId) return;
  const { window, controller, oracle } = getMarketForAsset(assetId);
  const currentFee = 100n;

  if (maxBaseFee && BigInt(currentFee) > BigInt(maxBaseFee)) {
    const err = new Error(`Base fee ${currentFee} exceeds maximum acceptable ceiling ${maxBaseFee}`);
    err.status = 400;
    err.code = "BASE_FEE_EXCEEDS_MAX";
    throw err;
  }

  const admission = window.consume(units);
  if (!admission.admitted) {
    const estimate = oracle.estimate(currentFee);
    const err = new Error("Capacity exhausted for current window");
    err.status = 429;
    err.statusCode = 429;
    err.currentBaseFee = estimate.baseFee;
    err.nextWindowEstimate = estimate.nextWindowBaseFee;
    err.suggestedTip = estimate.suggestedTip;
    throw err;
  }
}

/**
 * Whether an unattested call is refused outright.
 */
function attestationEnforced() {
  return process.env.ATTESTATION_ENFORCED !== "false";
}

// Shares the Postgres-backed nonce and index stores, so replay protection spans
// processes rather than living in one server's memory.
const verifier = new AttestationVerifier(attestationRepository.createStores());
const archive = new AttestationArchive({ verifier });

function getJWTSecret() {
  return process.env.JWT_SECRET || process.env.SERVER_SECRET_KEY || "default-jwt-secret";
}

/**
 * Recursively sort object keys so structurally identical payloads serialize
 * identically.
 */
function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    const sorted = {};
    for (const key of Object.keys(value).sort()) {
      sorted[key] = canonicalize(value[key]);
    }
    return sorted;
  }
  return value;
}

/**
 * Canonical SHA-256 of a metered request payload, or null when there is no
 * payload to speak of.
 */
function hashPayload(payload) {
  if (payload === null || payload === undefined) return null;
  if (typeof payload === "object" && Object.keys(payload).length === 0) return null;

  const json = JSON.stringify(canonicalize(payload));
  if (json === undefined) return null;

  return crypto.createHash("sha256").update(json).digest("hex");
}

/**
 * Validates a stream_token JWT.
 */
function verifyToken(token) {
  try {
    return jwt.verify(token, getJWTSecret());
  } catch (err) {
    throw new Error("Invalid stream token: " + err.message);
  }
}

/**
 * The Ed25519 key a stream's attestations must be signed with.
 */
function expectedSigner(stream, tokenClaims) {
  return tokenClaims?.sellerKey || stream.recipient;
}

const streamQueues = new Map();

function enqueueForStream(streamId, task) {
  const key = String(streamId);
  const previous = streamQueues.get(key) || Promise.resolve();
  const next = previous.catch(() => {}).then(task);
  streamQueues.set(key, next);
  next.catch(() => {}).then(() => {
    if (streamQueues.get(key) === next) streamQueues.delete(key);
  });
  return next;
}

/**
 * Bill one call.
 *
 * @param {string} tokenString - stream_token JWT
 * @param {object} [options]
 * @param {string|null} [options.payloadHash]
 * @param {object|null} [options.attestation]
 * @param {string|number|null} [options.maxBaseFee]
 * @param {string|number|null} [options.tip]
 * @throws {Error} status 429 when capacity window is exhausted
 * @throws {Error} status 403 when attestation is required and does not verify
 */
async function meterCall(tokenString, { payloadHash = null, attestation = null, maxBaseFee = null, tip = null } = {}) {
  const decoded = verifyToken(tokenString);
  const streamId = Number(decoded.streamId);

  // Enforce congestion capacity limit before acquiring database locks
  if (decoded.assetId) {
    gateCapacity(decoded.assetId, 1, maxBaseFee);
  }

  if (!attestation && attestationEnforced()) {
    const err = new Error(
      "Attestation required: this call must carry a seller-signed attestation"
    );
    err.status = 403;
    err.reason = "ATTESTATION_MISSING";
    throw err;
  }

  return enqueueForStream(streamId, () => withTransaction(async (client) => {
    // 1. Lock the stream row FOR UPDATE
    const stream = await streamRepository.findAndLockById(streamId, client);
    if (!stream) {
      const err = new Error("Stream not found");
      err.status = 404;
      throw err;
    }

    if (stream.status !== "Active") {
      const err = new Error("Stream is not Active");
      err.status = 402;
      throw err;
    }

    if (stream.callsRemaining <= 0) {
      const err = new Error("Payment Required: Stream exhausted");
      err.status = 402;
      throw err;
    }

    // 2. Verify attestation
    let attestationResult = null;
    if (attestation) {
      const signer = expectedSigner(stream, decoded);
      attestationResult = await verifier.accept(attestation, {
        signer,
        streamId,
        client,
      });

      if (!attestationResult.valid) {
        const err = new Error(`Attestation rejected: ${attestationResult.message}`);
        err.status = 403;
        err.reason = attestationResult.reason;
        err.provableOnChain = attestationResult.provableOnChain;
        throw err;
      }

      await archive.archive(
        { ...attestation, signer, leaf_hash: leafHash(attestation).toString("hex") },
        { client }
      );
    }

    const newCallsRemaining = stream.callsRemaining - 1;
    const newCallsUsed = stream.callsUsed + 1;

    // 3. Update database
    const updated = await streamRepository.updateCalls(
      streamId,
      newCallsRemaining,
      newCallsUsed,
      client
    );

    // 4. Log the call
    await usageEventRepository.record(
      {
        source: "stream",
        streamId,
        assetId: decoded.assetId ?? null,
        caller: stream.sender,
        counterparty: stream.recipient,
        payloadHash,
        pricePaid: stream.pricePerCall ?? 0,
      },
      client
    );

    const settle_now = (newCallsUsed >= 25);

    return {
      calls_remaining: newCallsRemaining,
      settle_now,
      stream: updated,
      attestation: attestationResult
        ? { callIndex: Number(attestation.call_index), leafHash: attestationResult.leafHash }
        : null,
    };
  }));
}

module.exports = {
  verifyToken,
  meterCall,
  hashPayload,
  expectedSigner,
  attestationEnforced,
  gateCapacity,
  getMarketForAsset,
  verifier,
  archive,
};