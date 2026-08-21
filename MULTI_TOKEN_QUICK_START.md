# Multi-Token Pricing Quick Start

## For Backend Developers

### Add a multi-token asset to an existing asset

```javascript
const assetRepository = require('./repositories/assetRepository');

const asset = await assetRepository.create({
  id: 42,
  owner: "GOWNER...",
  name: "My AI Model",
  usdPriceCents: 4200,  // $42.00
  acceptedTokens: [
    "native",
    "GBUSDUSDSDSDSDSDSDSDSDSDSDSDSDSDSDSDSDSDSDSDSDSDSDSDSDSDSDS" // USDC
  ],
  // ... other fields
});
```

### Get a price quote

```javascript
const { getPriceCommitment } = require('./services/multiTokenPurchaseService');

const quote = await getPriceCommitment({
  assetId: 42,
  token: "GBUSDUSDSDSDSDSDSDSDSDSDSDSDSDSDSDSDSDSDSDSDSDSDSDSDSDSDSDS",
  slippageTolerance: 5  // 5% default
});

// quote.commitment — signed by backend, valid 60 seconds
// quote.oraclePrice — current USDC/USD rate
// quote.priceMetadata — source breakdown
```

### Purchase with multi-token support

```javascript
const { purchaseMultiTokenLicense } = require('./services/multiTokenPurchaseService');

const purchase = await purchaseMultiTokenLicense({
  assetId: 42,
  buyer: "GBUYER...",
  token: "GBUSDUSDSDSDSDSDSDSDSDSDSDSDSDSDSDSDSDSDSDSDSDSDSDSDSDSDSDS",
  commitment: quote.commitment  // From getPriceCommitment
});

// purchase.license — stored with token used
// purchase.license.token === "GBUSD..."
```

### Check oracle health

```javascript
const priceOracleAggregator = require('./pricing/PriceOracleAggregator');

const health = await priceOracleAggregator.getOracleHealth();
console.log(health.overall);  // "healthy" | "degraded" | "critical"
health.sources.forEach(s => {
  console.log(`${s.name}: ${s.status} (latency: ${s.latency}ms)`);
});
```

## For Frontend Developers

### Fetch price & commitment

```javascript
// GET /api/v1/assets/42/price?token=GBUSD...
const response = await fetch('/api/v1/assets/42/price?token=GBUSD...');
const { commitment, oraclePrice, priceMetadata } = await response.json();

// commitment.maxPrice — max acceptable price with slippage
// commitment.validUntilLedger — expires at this ledger (in ~20 min)
// oraclePrice — current exchange rate
```

### Show price in buyer's preferred token

```javascript
const usdPrice = 4200;  // $42.00 in cents
const tokenPrice = oraclePrice;  // e.g., 1 USDC = 1 USD

const tokenAmount = (usdPrice / 100) / tokenPrice;  // USDC to pay
const slippageAmount = tokenAmount * 0.05;  // 5% buffer
const maxAmount = tokenAmount + slippageAmount;

console.log(`Price: $${(usdPrice / 100).toFixed(2)}`);
console.log(`USDC required: ${tokenAmount.toFixed(6)}`);
console.log(`With 5% slippage: ${maxAmount.toFixed(6)} USDC max`);
```

### Submit purchase

```javascript
const licenseResponse = await fetch('/api/v1/licenses/purchase', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    assetId: 42,
    buyer: "GBUYER...",
    token: "GBUSD...",
    commitment: commitment  // From price fetch
  })
});

const { license, token } = await licenseResponse.json();
console.log(`License purchased with ${token}`);
```

### Build transaction with Soroban

```javascript
// After receiving commitment from backend
import { Contract, TransactionBuilder, BASE_FEE } from '@stellar/stellar-sdk';

const marketplace = new Contract(CONTRACT_ID);

const txBuilder = new TransactionBuilder(account, {
  fee: BASE_FEE,
  networkPassphrase: NETWORK_PASSPHRASE
});

txBuilder.addOperation(
  marketplace.methods
    .purchase_license_multi_asset(
      buyer,
      assetId,
      token,
      priceCommitment
    )
    .toXDRObject()
);

const tx = txBuilder.build();
const signed = await window.stellar.signTransaction(tx);
const response = await server.submitTransaction(signed);
```

## Common Scenarios

### Buyer checks which tokens are accepted

```bash
curl https://api.cortex.local/api/v1/assets/42

# In response:
# {
#   "id": 42,
#   "name": "ML Model",
#   "usdPriceCents": 4200,
#   "acceptedTokens": ["native", "GBUSD...", "GEUR..."],
#   ...
# }
```

### Buyer switches between tokens

```bash
# Get price in XLM (native)
curl https://api.cortex.local/api/v1/assets/42/price?token=native

# Get price in USDC
curl https://api.cortex.local/api/v1/assets/42/price?token=GBUSD...

# Buyer chooses whichever is more convenient
```

### Monitor oracle degradation

```bash
curl https://api.cortex.local/api/v1/internal/pricing/oracle-health

# Response shows:
# - Reflector: available, 45ms latency, 95% fresh, 5% stale
# - Stellar Expert: available, 120ms latency, 90% fresh
# - CoinGecko: unavailable (network error)
# - Overall: "degraded"

# Action: Alert operations team, investigate CoinGecko API
```

### Seller updates pricing & tokens

```javascript
// Update asset to accept EUR (EURt token)
const updated = await assetRepository.update(42, {
  usdPriceCents: 5000,  // $50.00
  acceptedTokens: ["native", "GBUSD...", "GEUR..."]
});
```

## API Reference

### GET /api/v1/assets/:id/price

**Query:** `token` (required, Stellar address)

**Response:**
```json
{
  "commitment": {
    "version": 1,
    "assetId": 42,
    "token": "GBUSD...",
    "usdPriceCents": 4200,
    "maxPrice": 4410,
    "validUntilLedger": 1050,
    "signature": "abc123...",
    "createdAt": 1724000000000
  },
  "oraclePrice": 1.00,
  "priceMetadata": {
    "sources": [
      { "name": "reflector", "price": 1.00 },
      { "name": "stellar-expert", "price": 0.99 }
    ],
    "deviation": { "min": 0.99, "max": 1.00, "stdDev": 0.005 }
  }
}
```

**Errors:**
- `400` — Invalid token / token not accepted
- `404` — Asset not found
- `503` — Oracle unavailable

### GET /api/v1/internal/pricing/oracle-health

**Response:**
```json
{
  "timestamp": 1724000000000,
  "overall": "healthy",
  "sources": [
    {
      "name": "reflector",
      "status": "available",
      "latency": 45,
      "staleness": {
        "freshCount": 95,
        "staleCount": 5,
        "failureRate": "0.02"
      }
    }
  ]
}
```

### GET /api/v1/pricing/sources

**Response:**
```json
{
  "count": 3,
  "sources": [
    { "name": "reflector", "type": "stellar-reflector", "weight": 0.5 },
    { "name": "stellar-expert", "type": "rest-api", "weight": 0.3 },
    { "name": "coingecko", "type": "rest-api", "weight": 0.2 }
  ]
}
```

## Testing

```bash
# Run all pricing tests
npm test -- src/__tests__/pricing/

# Run multi-token service tests
npm test -- src/__tests__/services/multiTokenPurchaseService.test.js

# Run integration tests
npm test -- src/__tests__/integration/multiTokenPurchase.integration.test.js

# Watch mode
npm test -- --watch
```

## Debugging

### Check commitment validity

```javascript
const { validateCommitment } = require('./pricing/PriceCommitmentBuilder');

const result = validateCommitment(commitment);
// { valid: true, reason: "VALID", age: 5000 }
// { valid: false, reason: "EXPIRED", age: 65000 }
// { valid: false, reason: "INVALID_SIGNATURE" }
```

### Check oracle sources

```javascript
const sources = priceOracleAggregator.getConfiguredSources();
sources.forEach(s => {
  console.log(`${s.name}: weight=${s.weight}, maxAge=${s.maxStaleness}ms`);
});
```

### Monitor source health

```javascript
const health = stalenessGuard.getAllSourceHealth();
health.forEach(h => {
  console.log(`${h.source}: ${h.freshCount}/${h.sampleCount} fresh`);
  console.log(`  Failure rate: ${h.failureRate}`);
  console.log(`  Avg age: ${h.avgAge}ms`);
});
```

## Troubleshooting

### "Token not accepted for asset"
- Check `asset.acceptedTokens` includes the token address
- Verify token address is correct (56 chars, starts with G)

### "Oracle price is stale"
- Check oracle health: `/api/v1/internal/pricing/oracle-health`
- If all sources unavailable, investigate network connectivity
- CoinGecko rate-limited? Check `COINGECKO_API_KEY`

### "Commitment invalid"
- Commitment older than 60 seconds? Fetch a new quote
- Token address doesn't match asset? Verify in commitment

### Slippage protection triggered on-chain
- Oracle price moved >5% since commitment was issued
- Increase slippage tolerance or retry with fresh commitment
- Check oracle health for volatile pricing

## Performance

- **Price fetch:** ~100ms (aggregates 3 sources in parallel)
- **Cache hit:** <5ms (30-second TTL)
- **Commitment build:** <2ms (HMAC signature)
- **Health check:** ~500ms (pings all sources)

## Security

- **Commitments signed** with HMAC-SHA256 (replay protection)
- **Expiration enforced** (60 seconds)
- **Outlier detection** (rejects 1 source reporting 10x price)
- **Fallback logic** (doesn't fail if one source unavailable)
- **Staleness guards** (rejects >5min old prices)
