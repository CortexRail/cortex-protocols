/**
 * Known Stellar token contract addresses, mapped to the price symbol the
 * oracle sources (PriceOracleAggregator) actually understand.
 *
 * An asset's acceptedTokens can list any Stellar address a seller wants to
 * take payment in, but a live price can only be fetched for a token whose
 * symbol is known here. Add an entry whenever a new token is meant to be
 * priced, rather than resolved ad hoc at call sites.
 */
const KNOWN_TOKENS = {
  native: "XLM",
  GBESQQKUX6FICTI7CZHM5UDQNX3PYH4BFC4AWG26V7UJMMWBOWEKGHME: "USDC",
};

/**
 * @param {string} token - Stellar address (or "native")
 * @returns {string|null} the price symbol, or null if this token isn't in
 *   the registry
 */
function resolveTokenSymbol(token) {
  return KNOWN_TOKENS[token] || null;
}

module.exports = { KNOWN_TOKENS, resolveTokenSymbol };
