/**
 * ChannelMonitor — watches for UNILATERAL_CLOSE events on the channels
 * contract and dispatches to a Watchtower.
 *
 * "Channels this node backs" is not a separate registry: it is exactly
 * whatever the configured Watchtower holds a justice package for.
 * `processUnilateralClose` fetches the pending close's public fields,
 * recomputes its commitment hash, and asks the Watchtower — a `null`
 * answer means either this channel is fine or this node was never asked to
 * back it, and both are the same "do nothing" outcome.
 *
 * Mirrors BatchSettler's shape: a pure per-event handler that is fully unit
 * testable against injected `viewContract`/`invokeContract`/`watchtower`,
 * wrapped by a thin start/stop polling daemon for production.
 */

const { Address, nativeToScVal, scValToNative } = require("@stellar/stellar-sdk");
const { rpcServer, CONTRACT_IDS } = require("../config/stellar");
const { viewContract, invokeContract } = require("../services/stellarService");
const { logger } = require("../utils/logger");

let intervalId = null;
let lastLedger = 0;

/**
 * Decode a channels-contract event's topic tag the same way
 * listeners/eventListener.js does for the marketplace/registry contracts.
 */
function decodeEventValue(scVal) {
  try {
    return scValToNative(scVal);
  } catch {
    return null;
  }
}

/**
 * Fetch a channel's currently pending close (public on-chain fields) and,
 * if this node's Watchtower holds a justice package for exactly that state,
 * submit `punish` on the honest party's behalf.
 *
 * @param {object} deps - injected for testability; production callers omit
 *   this and get the real stellarService-backed versions.
 * @param {Function} [deps.viewContract]
 * @param {Function} [deps.invokeContract]
 * @param {import('../channels/Watchtower')} deps.watchtower
 * @param {import('@stellar/stellar-sdk').Keypair} deps.signerKeypair - this
 *   node's own key, used only to *submit* the transaction; `punish`'s payout
 *   goes to `justice.challenger`, never to this key
 * @param {number|string} channelId
 * @returns {Promise<{action: 'skipped'|'punished', reason?: string, payout?: *}>}
 */
async function processUnilateralClose(deps, channelId) {
  const { watchtower, signerKeypair } = deps;
  const view = deps.viewContract || viewContract;
  const invoke = deps.invokeContract || invokeContract;
  const contractId = deps.contractId || CONTRACT_IDS.channels;

  if (!contractId) {
    return { action: "skipped", reason: "channels contract not configured" };
  }

  const pending = await view(
    contractId,
    "get_pending_close",
    [nativeToScVal(BigInt(channelId), { type: "u64" })],
    signerKeypair.publicKey()
  );
  if (!pending) {
    return { action: "skipped", reason: "channel is not currently closing" };
  }

  const state = {
    channel_id: Number(channelId),
    version: Number(pending.version),
    balance_a: Number(pending.balance_a),
    balance_b: Number(pending.balance_b),
    revocation_commit_a: Buffer.from(pending.revocation_commit_a).toString("hex"),
    revocation_commit_b: Buffer.from(pending.revocation_commit_b).toString("hex"),
  };

  const justice = watchtower.findJustice(state);
  if (!justice) {
    return { action: "skipped", reason: "no justice package for this state" };
  }

  logger.warn(
    `[ChannelMonitor] revoked close detected on channel ${channelId} (version ${state.version}); submitting punish`
  );

  const payout = await invoke(
    contractId,
    "punish",
    [
      Address.fromString(justice.challenger).toScVal(),
      nativeToScVal(BigInt(channelId), { type: "u64" }),
      nativeToScVal(Buffer.from(justice.revocationSecret, "hex"), { type: "bytes" }),
    ],
    signerKeypair
  );

  logger.info(`[ChannelMonitor] punished channel ${channelId}; payout=${payout}`);
  return { action: "punished", payout };
}

/**
 * Poll for UNILATERAL_CLOSE events since the last processed ledger and
 * dispatch each to processUnilateralClose.
 */
async function poll(deps) {
  const contractId = deps.contractId || CONTRACT_IDS.channels;
  if (!contractId) return;

  try {
    const response = await rpcServer.getEvents({
      startLedger: lastLedger,
      filters: [{ type: "contract", contractIds: [contractId] }],
      limit: 100,
    });

    for (const event of response.events) {
      const [topicTag] = Array.isArray(event.topic) ? event.topic.map(decodeEventValue) : [];
      if (topicTag === "UNILATERAL_CLOSE") {
        const decoded = decodeEventValue(event.value);
        const channelId = Array.isArray(decoded) ? decoded[0] : decoded?.channel_id;
        if (channelId !== undefined && channelId !== null) {
          await processUnilateralClose(deps, channelId).catch((err) =>
            logger.error(`[ChannelMonitor] error handling channel ${channelId}:`, err.message)
          );
        }
      }
      if (event.ledger > lastLedger) lastLedger = event.ledger;
    }
  } catch (err) {
    logger.warn("[ChannelMonitor] poll error:", err.message);
  }
}

function start(deps, intervalMs = 15_000) {
  if (intervalId) return;
  intervalId = setInterval(() => poll(deps), intervalMs);
}

function stop() {
  if (intervalId) {
    clearInterval(intervalId);
    intervalId = null;
  }
}

module.exports = {
  processUnilateralClose,
  poll,
  start,
  stop,
};
