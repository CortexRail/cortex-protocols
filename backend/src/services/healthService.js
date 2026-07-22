/**
 * Contract connectivity health checks.
 *
 * Verifies that the backend can reach the Soroban RPC node and Horizon,
 * and that every configured contract is actually deployed on the current
 * network (its instance entry exists on the ledger). Used by the
 * /health/contracts endpoint so uptime monitors catch bad contract IDs or
 * network outages before users do.
 */

const { Contract } = require("@stellar/stellar-sdk");
const {
  rpcServer,
  horizonServer,
  NETWORK,
  CONTRACT_IDS,
} = require("../config/stellar");

/**
 * Check Soroban RPC reachability by fetching the latest ledger.
 */
async function checkRpc() {
  const started = Date.now();
  try {
    const ledger = await rpcServer.getLatestLedger();
    return {
      healthy: true,
      latencyMs: Date.now() - started,
      latestLedger: ledger.sequence,
    };
  } catch (err) {
    return {
      healthy: false,
      latencyMs: Date.now() - started,
      error: err.message,
    };
  }
}

/**
 * Check Horizon reachability via fee stats (cheap, unauthenticated).
 */
async function checkHorizon() {
  const started = Date.now();
  try {
    await horizonServer.feeStats();
    return { healthy: true, latencyMs: Date.now() - started };
  } catch (err) {
    return {
      healthy: false,
      latencyMs: Date.now() - started,
      error: err.message,
    };
  }
}

/**
 * Check that a single contract is deployed: its instance entry must exist
 * on the ledger. An unset ID reports `configured: false` rather than an
 * error so partially-deployed environments still get a meaningful report.
 */
async function checkContract(contractId) {
  if (!contractId) {
    return { configured: false, deployed: null };
  }

  try {
    const instanceKey = new Contract(contractId).getFootprint();
    const { entries } = await rpcServer.getLedgerEntries(instanceKey);
    const deployed = entries.length > 0;
    return {
      configured: true,
      contractId,
      deployed,
      ...(deployed ? {} : { error: "contract instance not found on ledger" }),
    };
  } catch (err) {
    return { configured: true, contractId, deployed: false, error: err.message };
  }
}

/**
 * Full connectivity report. `status` is "ok" only when the RPC node is
 * reachable and every configured contract is deployed; Horizon problems
 * are reported but do not degrade the status since contract calls only
 * need RPC.
 */
async function getConnectivityReport() {
  const [rpc, horizon, marketplace, micropayments, agentRegistry] =
    await Promise.all([
      checkRpc(),
      checkHorizon(),
      checkContract(CONTRACT_IDS.marketplace),
      checkContract(CONTRACT_IDS.micropayments),
      checkContract(CONTRACT_IDS.agentRegistry),
    ]);

  const contracts = { marketplace, micropayments, agentRegistry };
  const configured = Object.values(contracts).filter((c) => c.configured);
  const healthy = rpc.healthy && configured.every((c) => c.deployed);

  return {
    status: healthy ? "ok" : "degraded",
    network: NETWORK,
    rpc,
    horizon,
    contracts,
    timestamp: new Date().toISOString(),
  };
}

module.exports = {
  getConnectivityReport,
  checkRpc,
  checkHorizon,
  checkContract,
};
