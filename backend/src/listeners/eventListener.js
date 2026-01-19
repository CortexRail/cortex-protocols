/**
 * Soroban event listener.
 *
 * Polls the RPC for contract events and keeps the off-chain index
 * in sync with on-chain state changes.
 */

const { rpcServer, CONTRACT_IDS } = require("../config/stellar");
const { indexAsset, removeAsset } = require("../services/assetService");
const { registerAgent } = require("../services/agentService");

// Track the last processed ledger to avoid re-processing
let lastLedger = 0;

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
      await processEvent(event);
      if (event.ledger > lastLedger) {
        lastLedger = event.ledger;
      }
    }
  } catch (err) {
    // Log but don't crash — network may be temporarily unavailable
    if (process.env.NODE_ENV !== "test") {
      console.warn("[eventListener] poll error:", err.message);
    }
  }
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
      removeAsset(event.value);
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
 * Start polling at a fixed interval.
 * @param {number} intervalMs - polling interval in ms (default 5s)
 */
function startEventListener(intervalMs = 5_000) {
  console.info("[eventListener] starting — polling every", intervalMs, "ms");
  setInterval(pollEvents, intervalMs);
  // Run immediately on start
  pollEvents();
}

module.exports = { startEventListener, pollEvents };
