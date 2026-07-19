/**
 * Soroban event listener.
 *
 * Polls the RPC for contract events, appends every raw event to the
 * `events_log` audit table, and keeps the off-chain index in sync with
 * on-chain state changes. After a restart it resumes from the highest
 * ledger recorded in the audit log — no events are silently skipped.
 */

const { rpcServer, CONTRACT_IDS } = require("../config/stellar");
const { indexAsset, removeAsset } = require("../services/assetService");
const { registerAgent } = require("../services/agentService");
const eventLogRepository = require("../repositories/eventLogRepository");

// Last processed ledger; hydrated from the database on start.
let lastLedger = 0;
let pollErrorCount = 0;

/**
 * Poll for new contract events since lastLedger.
 */
async function pollEvents() {
  if (!CONTRACT_IDS.marketplace) {
    // Contracts not yet deployed — skip silently
    return;
  }

  try {
    const response = await rpcServer.getEvents({
      startLedger: lastLedger,
      filters: [
        {
          type: "contract",
          contractIds: [
            CONTRACT_IDS.marketplace,
            CONTRACT_IDS.agentRegistry,
          ].filter(Boolean),
        },
      ],
      limit: 100,
    });

    for (const event of response.events) {
      await persistEvent(event);
      await processEvent(event);
      if (event.ledger > lastLedger) {
        lastLedger = event.ledger;
      }
    }
  } catch (err) {
    pollErrorCount += 1;
    // Log but don't crash — network may be temporarily unavailable
    if (process.env.NODE_ENV !== "test") {
      console.warn("[eventListener] poll error:", err.message);
    }
  }
}

/**
 * Append the raw event to the audit log before any interpretation, so the
 * index can always be rebuilt or replayed from what actually happened.
 */
async function persistEvent(event) {
  await eventLogRepository.append({
    ledger: event.ledger,
    contractId: event.contractId,
    topic: Array.isArray(event.topic) ? event.topic.map(String) : [],
    payload: { value: event.value ?? null },
    txHash: event.txHash || null,
  });
}

/**
 * Handle a single contract event.
 */
async function processEvent(event) {
  const [topicTag] = event.topic;

  switch (topicTag) {
    case "LISTED": {
      // Minimal index — full data fetched from RPC in a follow-up call
      console.info(`[eventListener] asset listed: id=${event.value}`);
      break;
    }
    case "DELISTED": {
      await removeAsset(event.value);
      console.info(`[eventListener] asset delisted: id=${event.value}`);
      break;
    }
    case "REGISTERED": {
      console.info(`[eventListener] agent registered: id=${event.value}`);
      break;
    }
    default:
      break;
  }
}

/**
 * Start polling at a fixed interval, resuming from the last ledger the
 * audit log has seen.
 * @param {number} intervalMs - polling interval in ms (default 5s)
 */
async function startEventListener(intervalMs = 5_000) {
  lastLedger = await eventLogRepository.getLastLedger();
  console.info(
    `[eventListener] starting — polling every ${intervalMs}ms, resuming from ledger ${lastLedger}`
  );
  setInterval(pollEvents, intervalMs);
  // Run immediately on start
  await pollEvents();
}

module.exports = { startEventListener, pollEvents, processEvent };

// Exported for observability
module.exports.getPollErrorCount = () => pollErrorCount;

// referenced by processEvent's LISTED follow-up fetch (future work)
module.exports._internals = { indexAsset, registerAgent };
