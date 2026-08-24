/**
 * MeteringEngine — bills one call against a stream.
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

/**
 * Whether an unattested call is refused outright.
 *
 * On by default — an opt-out that defaults to "off" would leave the trust hole
 * open for anyone who never read the release note. Set
 * ATTESTATION_ENFORCED=false only to run a seller integration that has not been
 * migrated yet; those calls are billed on the backend's word alone and are
 * logged as such.
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
 * The Ed25519 key a stream's attestations must be signed with.
 *
 * A Stellar `G...` address is an Ed25519 public key, so the stream's recipient
 * doubles as the seller's attestation key and there is nothing to register:
 * the key that gets paid is the key that signs.
 *
 * A seller may nominate a separate operational signing key, but only through
 * the `sellerKey` claim in the stream token, which the backend signs at
 * negotiation time. It deliberately cannot come from the metering request:
 * a caller who could name the key an attestation is checked against could name
 * their own and sign their own usage, which is the exact trust hole this whole
 * subsystem exists to close.
 */
function expectedSigner(stream, tokenClaims) {
  return tokenClaims?.sellerKey || stream.recipient;
}

// Postgres's row lock queue serializes concurrent meterCall transactions for
// the same stream, but does not preserve the order they were invoked in —
// and call_index is assigned by the caller before the call is made, so a
// buyer issuing several calls back-to-back expects them billed in that same
// order. Chaining each stream's calls onto an in-process tail makes the
// invocation order the processing order, so the attestation verifier's
// monotonic call_index check (a genuine replay defense, not a bug) sees calls
// in the order they were actually made instead of whatever order the DB
// happened to grant the lock.
const streamQueues = new Map();

function enqueueForStream(streamId, task) {
  const key = String(streamId);
  const previous = streamQueues.get(key) || Promise.resolve();
  const next = previous.catch(() => {}).then(task);
  streamQueues.set(key, next);
  // A rejected `next` is the caller's to handle; observe it separately here
  // (after absorbing the rejection) so cleanup never leaves an unhandled
  // rejection of its own dangling off the same promise.
  next.catch(() => {}).then(() => {
    if (streamQueues.get(key) === next) streamQueues.delete(key);
  });
  return next;
}

/**
 * Bill one call.
 *
 * The attestation is verified and archived inside the same transaction as the
 * decrement, so the three facts — the seller said it happened, the buyer was
 * charged, and the nonce is spent — commit or roll back together.
 *
 * @param {string} tokenString - stream_token JWT
 * @param {object} [options]
 * @param {string|null} [options.payloadHash] - canonical hash of the request
 *   payload, logged for replay detection (see hashPayload)
 * @param {object|null} [options.attestation] - the seller's signed attestation
 *   for this call, as produced by AttestationBuilder
 * @throws {Error} status 403 when attestation is required and does not verify
 */
async function meterCall(tokenString, { payloadHash = null, attestation = null } = {}) {
  const decoded = verifyToken(tokenString);
  const streamId = Number(decoded.streamId);

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

    // 2. The seller's signature is what authorises the charge. Verifying
    //    before the decrement means a forged or replayed attestation costs the
    //    buyer nothing — the transaction never gets as far as billing.
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
        // Tells the caller whether this is worth an on-chain challenge or is
        // merely a malformed request.
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

    // 4. Log the call for the fraud detectors. Same transaction as the
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
      // Echoed back so the seller's SDK can confirm which call in the sequence
      // this was, and so a buyer can match the response to an archived leaf.
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
  // Exposed so the batch submitter and the routes share one verifier, and so
  // tests can inject their own stores.
  verifier,
  archive,
};
