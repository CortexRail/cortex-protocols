const { StrKey } = require("@stellar/stellar-sdk");

/**
 * Check whether a value is a valid Stellar Ed25519 public key (a "G..."
 * address). Accepts any input type — non-strings simply return false
 * rather than throwing, so this is safe to call directly on unsanitized
 * request data.
 *
 * @param {unknown} value
 * @returns {boolean}
 */
function isValidStellarAddress(value) {
  if (typeof value !== "string") return false;
  return StrKey.isValidEd25519PublicKey(value);
}

module.exports = { isValidStellarAddress };
