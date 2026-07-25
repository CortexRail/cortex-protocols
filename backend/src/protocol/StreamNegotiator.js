const jwt = require("jsonwebtoken");
const QuoteManager = require("./QuoteManager");

// In-memory store for agreed negotiation terms (valid for 5 mins).
// Key: `${buyer}:${assetId}:${agreedRate}`, Value: agreement object.
const agreedTerms = new Map();

function getJWTSecret() {
  return process.env.JWT_SECRET || process.env.SERVER_SECRET_KEY || "default-jwt-secret";
}

/**
 * Negotiate a rate for a buyer and asset.
 * If proposed rate is >= 90% of list price, accept.
 * Otherwise, counter with 95% of list price.
 */
function negotiateRate(buyer, assetId, proposedRate, quote) {
  // Validate the quote first
  const isValid = QuoteManager.validateQuote(quote);
  if (!isValid) {
    throw new Error("Invalid or expired quote");
  }

  if (quote.buyer !== buyer || quote.assetId !== Number(assetId)) {
    throw new Error("Quote mismatch");
  }

  const listPrice = quote.price;
  const minAcceptable = Math.ceil(listPrice * 0.9);

  if (proposedRate >= minAcceptable) {
    const agreementId = `${buyer}:${assetId}:${proposedRate}`;
    const agreement = {
      buyer,
      assetId: Number(assetId),
      agreedRate: Number(proposedRate),
      status: "Agreed",
      expiresAt: Date.now() + 5 * 60 * 1000,
    };
    agreedTerms.set(agreementId, agreement);

    // Set TTL cleanup
    setTimeout(() => {
      agreedTerms.delete(agreementId);
    }, 5 * 60 * 1000);

    return { status: "Agreed", rate: Number(proposedRate), agreementId };
  } else {
    const counterRate = Math.ceil(listPrice * 0.95);
    return { status: "Countered", rate: counterRate };
  }
}

/**
 * Fetch a pending agreed term if valid.
 */
function getAgreement(buyer, assetId, rate) {
  const agreementId = `${buyer}:${assetId}:${rate}`;
  const agreement = agreedTerms.get(agreementId);
  if (agreement && agreement.expiresAt > Date.now()) {
    return agreement;
  }
  return null;
}

/**
 * Issue a stream_token JWT.
 */
function issueStreamToken(stream, pricePerCall) {
  const payload = {
    streamId: String(stream.id),
    sender: stream.sender,
    recipient: stream.recipient,
    token: stream.token,
    pricePerCall: Number(pricePerCall),
    expiresAt: Number(stream.endTime),
  };

  return jwt.sign(payload, getJWTSecret());
}

module.exports = {
  negotiateRate,
  getAgreement,
  issueStreamToken,
  _agreedTerms: agreedTerms,
};
