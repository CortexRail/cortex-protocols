/**
 * Format a stroops value to a human-readable XLM string.
 * 1 XLM = 10,000,000 stroops
 *
 * @param {number|bigint} stroops
 * @returns {string} e.g. "1.5000000 XLM"
 */
function stroopsToXlm(stroops) {
  const xlm = Number(stroops) / 10_000_000;
  return `${xlm.toFixed(7)} XLM`;
}

/**
 * Format a reputation basis-point score (0–10000) to a percentage string.
 *
 * @param {number} bps
 * @returns {string} e.g. "82.00%"
 */
function reputationToPercent(bps) {
  return `${(bps / 100).toFixed(2)}%`;
}

/**
 * Truncate a Stellar public key for display.
 * e.g. "GBQNX4...BFLR3"
 *
 * @param {string} publicKey
 * @returns {string}
 */
function truncateAddress(publicKey) {
  if (!publicKey || publicKey.length < 12) return publicKey;
  return `${publicKey.slice(0, 6)}...${publicKey.slice(-5)}`;
}

module.exports = { stroopsToXlm, reputationToPercent, truncateAddress };
