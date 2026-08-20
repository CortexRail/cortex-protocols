const crypto = require("crypto");

// Store pending quotes in memory (Map). Key: quote signature, Value: quote object.
const pendingQuotes = new Map();

// Helper to get secret key for HMAC
function getSecret() {
  return process.env.JWT_SECRET || process.env.SERVER_SECRET_KEY || "default-quote-secret";
}

/**
 * Generate a signed quote for an asset.
 * Valid for 60 seconds.
 */
function generateQuote(buyer, assetId, price) {
  const expiresAt = Date.now() + 60 * 1000;
  const message = `${buyer}:${assetId}:${price}:${expiresAt}`;
  
  const signature = crypto
    .createHmac("sha256", getSecret())
    .update(message)
    .digest("hex");

  const quote = {
    buyer,
    assetId: Number(assetId),
    price: Number(price),
    expiresAt,
    signature,
  };

  // Store quote in memory
  pendingQuotes.set(signature, quote);

  // Set TTL cleanup
  setTimeout(() => {
    pendingQuotes.delete(signature);
  }, 60 * 1000);

  return quote;
}

/**
 * Validate a quote signature, expiration, and presence in pending store.
 * Returns true if valid, false otherwise.
 */
function validateQuote(quote) {
  if (!quote || !quote.signature || !quote.buyer || !quote.assetId || !quote.price || !quote.expiresAt) {
    return false;
  }

  // 1. Check expiration
  if (Date.now() > quote.expiresAt) {
    return false;
  }

  // 2. Validate signature
  const message = `${quote.buyer}:${quote.assetId}:${quote.price}:${quote.expiresAt}`;
  const expectedSignature = crypto
    .createHmac("sha256", getSecret())
    .update(message)
    .digest("hex");

  if (quote.signature !== expectedSignature) {
    return false;
  }

  // 3. Verify presence in pending quotes to prevent replay attacks
  if (!pendingQuotes.has(quote.signature)) {
    return false;
  }

  // To prevent reuse, we can delete the quote from the pending map.
  pendingQuotes.delete(quote.signature);
  return true;
}

/**
 * Route a listing to the appropriate pricing flow.
 *
 * Capacity-constrained assets (those with a positive `capacity` field, i.e.
 * scarce high-demand streams) are routed into the sealed-bid auction flow;
 * everything else gets the direct signed-quote flow.
 *
 * @param {object} asset - Asset row (must expose `capacity` and `price`).
 * @returns {{ mode: "auction"|"quote", reason: string }}
 */
function routeAsset(asset) {
  if (asset && Number(asset.capacity) > 0) {
    return {
      mode: "auction",
      reason: "capacity-constrained",
    };
  }
  return { mode: "quote", reason: "first-come" };
}

/**
 * True when the asset should be priced via a sealed-bid auction instead of
 * a direct quote.
 */
function shouldAuction(asset) {
  return routeAsset(asset).mode === "auction";
}

module.exports = {
  generateQuote,
  validateQuote,
  routeAsset,
  shouldAuction,
  _pendingQuotes: pendingQuotes, // Exported for testing/debugging
};
