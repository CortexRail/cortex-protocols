const crypto = require("crypto");
const jwt = require("jsonwebtoken");
const streamRepository = require("../repositories/streamRepository");
const usageEventRepository = require("../repositories/usageEventRepository");
const { withTransaction } = require("../db/connection");

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
 *
 * Keys are sorted before hashing: without that, a buyer replaying a cached
 * response could evade ReplayAbuseDetector by reordering its JSON properties.
 * An empty body hashes to null rather than to the hash of "{}", so clients
 * that meter without sending anything are never counted as repeating.
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
 * Decrement call counter atomically inside a transaction.
 * Returns { calls_remaining, settle_now: bool }
 *
 * @param {string} tokenString - stream_token JWT
 * @param {object} [options]
 * @param {string|null} [options.payloadHash] - canonical hash of the request
 *   payload, logged for replay detection (see hashPayload)
 */
async function meterCall(tokenString, { payloadHash = null } = {}) {
  const decoded = verifyToken(tokenString);
  const streamId = Number(decoded.streamId);

  return withTransaction(async (client) => {
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

    const newCallsRemaining = stream.callsRemaining - 1;
    const newCallsUsed = stream.callsUsed + 1;

    // 2. Update database
    const updated = await streamRepository.updateCalls(
      streamId,
      newCallsRemaining,
      newCallsUsed,
      client
    );

    // 3. Log the call for the fraud detectors. Same transaction as the
    // decrement, so the usage log can never claim a call that wasn't billed
    // (or miss one that was).
    await usageEventRepository.record(
      {
        source: "stream",
        streamId,
        // Old tokens predate the asset binding; those calls log a null asset.
        assetId: decoded.assetId ?? null,
        caller: stream.sender,
        counterparty: stream.recipient,
        payloadHash,
        pricePaid: stream.pricePerCall ?? 0,
      },
      client
    );

    // "BatchSettler.js runs every 60s, finds streams where calls_used >= batch_size (25)"
    // settle_now is true when calls_used >= 25
    const settle_now = (newCallsUsed >= 25);

    return {
      calls_remaining: newCallsRemaining,
      settle_now,
      stream: updated,
    };
  });
}

module.exports = {
  verifyToken,
  meterCall,
  hashPayload,
};
