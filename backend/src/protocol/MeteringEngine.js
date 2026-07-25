const jwt = require("jsonwebtoken");
const streamRepository = require("../repositories/streamRepository");
const { withTransaction } = require("../db/connection");

function getJWTSecret() {
  return process.env.JWT_SECRET || process.env.SERVER_SECRET_KEY || "default-jwt-secret";
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
 */
async function meterCall(tokenString) {
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
};
