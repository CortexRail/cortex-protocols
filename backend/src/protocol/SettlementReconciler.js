/**
 * SettlementReconciler — periodic divergence detection and auto-healing.
 * 
 * Runs every 30s to:
 * - Query on-chain settlement status via get_settlement_status
 * - Compare against off-chain streamRepository state
 * - Flag and auto-heal divergences
 * 
 * Divergence classes:
 * - On-chain ahead: Off-chain withdrawn < on-chain withdrawn (update off-chain)
 * - Off-chain ahead: Off-chain withdrawn > on-chain withdrawn (data corruption alert)
 * - Missing stream: Exists off-chain but not on-chain (orphan detection)
 */

const streamRepository = require("../repositories/streamRepository");
const { viewContract } = require("../services/stellarService");
const { CONTRACT_IDS } = require("../config/stellar");
const { withTransaction } = require("../db/connection");

let intervalId = null;
const POLL_INTERVAL_MS = 30_000;

/**
 * Divergence types for classification.
 */
const DivergenceType = {
  ON_CHAIN_AHEAD: 'ON_CHAIN_AHEAD', // On-chain has higher withdrawn than off-chain
  OFF_CHAIN_AHEAD: 'OFF_CHAIN_AHEAD', // Off-chain has higher withdrawn than on-chain (corruption)
  MISSING_ON_CHAIN: 'MISSING_ON_CHAIN', // Stream exists off-chain but not on-chain
  STATUS_MISMATCH: 'STATUS_MISMATCH', // Stream status differs between off-chain and on-chain
};

/**
 * Fetch on-chain settlement status for multiple streams.
 * 
 * @param {number[]} streamIds - Array of stream IDs to query
 * @returns {Promise<Map<number, {lastSettledAmount: number, ledgerSequence: number}>>}
 */
async function getOnChainSettlementStatus(streamIds) {
  const contractId = CONTRACT_IDS.micropayments;
  if (!contractId) {
    console.warn('[SettlementReconciler] micropayments contract not configured');
    return new Map();
  }

  try {
    // Use a dummy caller key for view-only calls
    const { Keypair } = require("@stellar/stellar-sdk");
    const dummyKeypair = Keypair.random();
    
    const result = await viewContract(
      contractId,
      'get_settlement_status',
      [streamIds],
      dummyKeypair.publicKey()
    );

    // Parse the result into a Map for easy lookup
    const statusMap = new Map();
    if (result && typeof result === 'object') {
      for (const [streamId, status] of Object.entries(result)) {
        statusMap.set(Number(streamId), {
          lastSettledAmount: Number(status.last_settled_amount),
          ledgerSequence: Number(status.ledger_sequence),
        });
      }
    }

    return statusMap;
  } catch (err) {
    console.error('[SettlementReconciler] Failed to fetch on-chain status:', err.message);
    return new Map();
  }
}

/**
 * Compare off-chain and on-chain state to detect divergences.
 * 
 * @param {Object[]} streams - Array of off-chain stream objects
 * @param {Map} onChainStatus - Map of on-chain settlement status
 * @returns {Promise<Object[]>} Array of detected divergences
 */
async function detectDivergences(streams, onChainStatus) {
  const divergences = [];

  for (const stream of streams) {
    const onChain = onChainStatus.get(stream.id);

    if (!onChain) {
      // Stream exists off-chain but not on-chain
      divergences.push({
        type: DivergenceType.MISSING_ON_CHAIN,
        streamId: stream.id,
        offChainWithdrawn: stream.withdrawn,
        onChainWithdrawn: 0,
        offChainStatus: stream.status,
        onChainStatus: null,
        detectedAt: Date.now(),
      });
      continue;
    }

    // Compare withdrawn amounts
    if (onChain.lastSettledAmount > stream.withdrawn) {
      // On-chain is ahead - off-chain needs update
      divergences.push({
        type: DivergenceType.ON_CHAIN_AHEAD,
        streamId: stream.id,
        offChainWithdrawn: stream.withdrawn,
        onChainWithdrawn: onChain.lastSettledAmount,
        difference: onChain.lastSettledAmount - stream.withdrawn,
        offChainStatus: stream.status,
        onChainStatus: null, // Would need to fetch stream status from contract
        ledgerSequence: onChain.ledgerSequence,
        detectedAt: Date.now(),
      });
    } else if (stream.withdrawn > onChain.lastSettledAmount) {
      // Off-chain is ahead - potential data corruption
      divergences.push({
        type: DivergenceType.OFF_CHAIN_AHEAD,
        streamId: stream.id,
        offChainWithdrawn: stream.withdrawn,
        onChainWithdrawn: onChain.lastSettledAmount,
        difference: stream.withdrawn - onChain.lastSettledAmount,
        offChainStatus: stream.status,
        onChainStatus: null,
        ledgerSequence: onChain.ledgerSequence,
        detectedAt: Date.now(),
        severity: 'HIGH',
      });
    }
  }

  return divergences;
}

/**
 * Auto-heal ON_CHAIN_AHEAD divergences by updating off-chain state.
 * 
 * @param {Object[]} divergences - Array of divergences to heal
 * @returns {Promise<number>} Number of healed divergences
 */
async function healDivergences(divergences) {
  let healed = 0;

  await withTransaction(async (client) => {
    for (const divergence of divergences) {
      if (divergence.type === DivergenceType.ON_CHAIN_AHEAD) {
        try {
          // Update off-chain withdrawn to match on-chain
          const stream = await streamRepository.findById(divergence.streamId, client);
          if (stream) {
            const amountToAdd = divergence.difference;
            await streamRepository.recordWithdrawal(divergence.streamId, amountToAdd, client);
            console.info(`[SettlementReconciler] Healed stream ${divergence.streamId}: added ${amountToAdd} to withdrawn`);
            healed++;
          }
        } catch (err) {
          console.error(`[SettlementReconciler] Failed to heal stream ${divergence.streamId}:`, err.message);
        }
      } else if (divergence.type === DivergenceType.OFF_CHAIN_AHEAD) {
        // Log high-severity divergence for manual review
        console.error(`[SettlementReconciler] HIGH SEVERITY: Stream ${divergence.streamId} off-chain ahead by ${divergence.difference} - manual review required`);
      } else if (divergence.type === DivergenceType.MISSING_ON_CHAIN) {
        console.warn(`[SettlementReconciler] Stream ${divergence.streamId} missing on-chain - possible orphan`);
      }
    }
  });

  return healed;
}

/**
 * Run a single reconciliation cycle.
 * 
 * @returns {Promise<Object>} Reconciliation results
 */
async function runReconciliation() {
  const startTime = Date.now();
  console.info('[SettlementReconciler] Starting reconciliation cycle');

  try {
    // Get all active streams from off-chain
    const streams = await withTransaction(async (client) => {
      return streamRepository.findAll({ status: 'Active' }, {}, client);
    });

    if (streams.data.length === 0) {
      console.info('[SettlementReconciler] No active streams to reconcile');
      return { checked: 0, divergences: [], healed: 0, durationMs: Date.now() - startTime };
    }

    const streamIds = streams.data.map(s => s.id);

    // Fetch on-chain status
    const onChainStatus = await getOnChainSettlementStatus(streamIds);

    // Detect divergences
    const divergences = await detectDivergences(streams.data, onChainStatus);

    if (divergences.length > 0) {
      console.warn(`[SettlementReconciler] Detected ${divergences.length} divergences`);
      
      // Auto-heal where possible
      const healable = divergences.filter(d => d.type === DivergenceType.ON_CHAIN_AHEAD);
      const healed = await healDivergences(healable);

      // Log unhealed divergences
      const unhealed = divergences.filter(d => d.type !== DivergenceType.ON_CHAIN_AHEAD);
      if (unhealed.length > 0) {
        console.error(`[SettlementReconciler] ${unhealed.length} divergences require manual review:`, 
          unhealed.map(d => `${d.type} for stream ${d.streamId}`).join(', '));
      }

      return {
        checked: streams.data.length,
        divergences,
        healed,
        unhealed: unhealed.length,
        durationMs: Date.now() - startTime,
      };
    }

    console.info(`[SettlementReconciler] Reconciliation complete: ${streams.data.length} streams checked, no divergences`);
    return {
      checked: streams.data.length,
      divergences: [],
      healed: 0,
      durationMs: Date.now() - startTime,
    };
  } catch (err) {
    console.error('[SettlementReconciler] Reconciliation cycle failed:', err);
    throw err;
  }
}

/**
 * Start the periodic reconciliation daemon.
 * 
 * @param {number} intervalMs - Polling interval in milliseconds (default: 30s)
 */
function start(intervalMs = POLL_INTERVAL_MS) {
  if (intervalId) {
    console.warn('[SettlementReconciler] Already running');
    return;
  }

  console.info(`[SettlementReconciler] Starting — running every ${intervalMs}ms`);
  
  // Run immediately on start
  runReconciliation().catch(err => {
    console.error('[SettlementReconciler] Initial reconciliation failed:', err);
  });

  intervalId = setInterval(() => {
    runReconciliation().catch(err => {
      console.error('[SettlementReconciler] Reconciliation cycle failed:', err);
    });
  }, intervalMs);
}

/**
 * Stop the reconciliation daemon.
 */
function stop() {
  if (intervalId) {
    clearInterval(intervalId);
    intervalId = null;
    console.info('[SettlementReconciler] Stopped');
  }
}

/**
 * Get recent divergences for API endpoint.
 * 
 * @param {Object} filters - Optional filters
 * @param {string} filters.type - Filter by divergence type
 * @param {number} filters.since - Only return divergences since this timestamp
 * @returns {Promise<Object[]>} Array of recent divergences
 */
async function getRecentDivergences(filters = {}) {
  // This would typically query a divergences table, but for now we run a fresh check
  const result = await runReconciliation();
  let divergences = result.divergences;

  if (filters.type) {
    divergences = divergences.filter(d => d.type === filters.type);
  }

  if (filters.since) {
    divergences = divergences.filter(d => d.detectedAt >= filters.since);
  }

  return divergences;
}

module.exports = {
  start,
  stop,
  runReconciliation,
  getRecentDivergences,
  DivergenceType,
};
