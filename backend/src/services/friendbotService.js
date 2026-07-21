/**
 * friendbotService.js
 *
 * Funds a Stellar Testnet account via Stellar Friendbot, the public faucet
 * service for the test network. Only ever call this against Testnet — the
 * caller (the /fund route) is responsible for the Mainnet restriction.
 */

const FRIENDBOT_URL = "https://friendbot.stellar.org";

/**
 * Request Friendbot funding for a Testnet account.
 *
 * @param {string} publicKey - Stellar G-address to fund
 * @returns {Promise<{ publicKey: string, funded: boolean, hash: string|null }>}
 */
async function fundAccount(publicKey) {
  let response;
  try {
    response = await fetch(`${FRIENDBOT_URL}?addr=${encodeURIComponent(publicKey)}`);
  } catch {
    throw new Error("Unable to reach Stellar Friendbot. Please try again later.");
  }

  let body = null;
  try {
    body = await response.json();
  } catch {
    // Friendbot did not return a JSON body; fall through with a generic message.
  }

  if (!response.ok) {
    const detail = body?.detail || body?.title || "Friendbot funding request failed.";
    throw new Error(detail);
  }

  return {
    publicKey,
    funded: true,
    hash: body?.hash ?? null,
  };
}

module.exports = { fundAccount, FRIENDBOT_URL };
