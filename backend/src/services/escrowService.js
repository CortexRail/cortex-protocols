/**
 * Escrow service — tracks escrow state mirrored from chain and computes hold countdown.
 */

const escrowRepository = require("../repositories/escrowRepository");

// Estimated seconds per Stellar ledger block (~5s)
const SECONDS_PER_LEDGER = 5;

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

/**
 * Sync / upsert an escrow record mirrored from chain events.
 */
async function syncEscrow(escrowHoldData) {
  return escrowRepository.upsert(escrowHoldData);
}

/**
 * Retrieve escrow state and calculate hold-period countdown metrics.
 * @param {number} licenseId
 * @param {number} currentLedger - current network ledger sequence number (optional)
 */
async function getEscrowWithCountdown(licenseId, currentLedger = 0) {
  const escrow = await escrowRepository.findByLicenseId(licenseId);
  if (!escrow) {
    throw httpError(404, `Escrow for license ${licenseId} not found`);
  }

  const remainingLedgers = Math.max(0, escrow.holdUntilLedger - currentLedger);
  const estimatedSecondsRemaining = remainingLedgers * SECONDS_PER_LEDGER;
  const isHoldExpired = currentLedger > 0 ? currentLedger >= escrow.holdUntilLedger : false;

  return {
    ...escrow,
    countdown: {
      currentLedger,
      holdUntilLedger: escrow.holdUntilLedger,
      remainingLedgers,
      estimatedSecondsRemaining,
      isHoldExpired,
      canRelease: escrow.status === "Held" && isHoldExpired,
    },
  };
}

/**
 * List all escrow holds for a buyer.
 */
async function getEscrowsForBuyer(buyer) {
  return escrowRepository.findAllByBuyer(buyer);
}

/**
 * Update escrow status (e.g. from contract event handlers).
 */
async function setEscrowStatus(licenseId, status) {
  return escrowRepository.updateStatus(licenseId, status);
}

module.exports = {
  syncEscrow,
  getEscrowWithCountdown,
  getEscrowsForBuyer,
  setEscrowStatus,
  SECONDS_PER_LEDGER,
};
