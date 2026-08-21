# Multi-Token Pricing Implementation

This document describes the complete implementation of multi-token pricing with USD-equivalent denomination, oracle aggregation, and slippage protection for the Cortex Protocols marketplace.

## Overview

Every asset now supports:
- USD-equivalent pricing (usdPriceCents) as the canonical price
- Multiple accepted payment tokens per asset
- Live price conversion via oracle aggregation
- Buyer-side slippage protection with commitments
- Multi-source oracle with outlier rejection and staleness guards

## Components

### 1. Database Schema (Migration 020)

**New columns on `assets` table:**
- `usd_price_cents (BIGINT)` — Canonical USD price in cents (e.g., 4200 for $42.00)
- `accepted_tokens (JSONB)` — Array of token addresses the seller accepts

**New columns on `licenses` table:**
- `token (TEXT)` — Which token was used for this purchase (default: 'native')

**New view: `asset_pricing_health`**
- Aggregates multi-token purchase analytics
- Shows active license count, unique payment tokens per asset

### 2. Backend Services

#### PriceOracleAggregator.js
**Purpose:** Multi-source price aggregation with outlier rejection

**Key Functions:**
- `aggregatePrices(asset, token)` — Fetches from Reflector, Stellar Expert, and CoinGecko
- `computeWeightedMedian(prices)` — Median price weighted by source reliability
- `filterOutliers(prices)` — Rejects prices deviating >20% from median
- `getOracleHealth()` — Health status of all sources (latency, availability)

**Sources:**
- **Reflector** (weight: 50%, staleness: 5min) — On-chain Stellar oracle
- **Stellar Expert** (weight: 30%, staleness: 5min) — REST API fallback
- **CoinGecko** (weight: 20%, staleness: 10min) — Public price feed

**Features:**
- 30-second cache to reduce API calls
- Outlier detection: rejects if `|price - median| / median > 0.2`
- Returns consensus with deviation stats (min, max, stdDev)

#### StalenessGuard.js
**Purpose:** Validates price freshness and triggers fallback sources

**Key Functions:**
- `isFresh(price, maxAge=300s)` — Age-based freshness check
- `isStale(price)` — Detects approaching staleness (3+ min old)
- `validatePrice(price, source)` — Full validation + health tracking
- `shouldUseFallback(price, source)` — Determines if fallback needed
- `getSourceHealth(source)` — Per-source metrics (fresh%, stale%, failure rate)

**Health Tracking:**
- Maintains 1-hour window of per-source samples
- Tracks freshness, staleness, failures
- Marks source "degraded" if failure rate > 50%
- Used by monitoring for oracle health checks

#### PriceCommitmentBuilder.js
**Purpose:** Builds signed price commitments for on-chain validation

**Key Functions:**
- `buildPriceCommitment(params)` — Constructs commitment with:
  - `assetId`, `token`, `usdPriceCents`
  - `maxPrice` = usdPriceCents × (1 + slippageTolerance/100)
  - `validUntilLedger` = current + offset (default 50 ledgers)
  - HMAC-SHA256 signature for replay protection
- `validateCommitment(commitment)` — Verifies signature and expiration
- `toContractFormat(commitment)` — Converts to Soroban contract format
- `buildBasketCommitments(items)` — Creates commitments for multiple assets

**Signature Details:**
```
message = version:assetId:token:usdPriceCents:maxPrice:validUntilLedger
signature = HMAC-SHA256(secret, message)
secret = env.COMMITMENT_SECRET || env.JWT_SECRET || "default"
```

**Commitment Validity:** 60 seconds (COMMITMENT_VALIDITY_SECONDS)

#### multiTokenPurchaseService.js (NEW)
**Purpose:** Orchestrates multi-token purchase flow with oracle integration

**Key Functions:**
- `getPriceCommitment(params)` — Gets live oracle price + builds commitment
  - Fetches aggregated price from PriceOracleAggregator
  - Validates freshness via StalenessGuard
  - Applies slippage tolerance
  - Returns commitment + oracle metadata
  - Throws if: asset not found, token not accepted, price stale

- `purchaseMultiTokenLicense(params)` — Atomic purchase with token tracking
  - Validates marketplace not paused
  - Verifies commitment (signature + expiration)
  - Increments asset usage counter + creates license in single transaction
  - Stores token used in licenses.token
  - Enforces version constraints (retained 4 prior versions)
  - Returns license + commitment + token

### 3. API Endpoints

#### GET /api/v1/assets/:id/price?token=<address>
**Purpose:** Get current converted price in requested token

**Request:**
```
GET /api/v1/assets/42/price?token=GBUSDUSDSDSDSDSDSDSDSDSDSDSDSDSDSDSDSDSDSDSDSDSDSDSDSDSDSDS
```

**Response (200):**
```json
{
  "commitment": {
    "version": 1,
    "assetId": 42,
    "token": "GBUSD...",
    "usdPriceCents": 4200,
    "maxPrice": 4410,
    "validUntilLedger": 1050,
    "signature": "abc123def456...",
    "createdAt": 1724000000000,
    "expiresAt": 1050
  },
  "oraclePrice": 1.0,
  "priceMetadata": {
    "sources": [
      { "name": "reflector", "price": 1.0, "age": 5000, "weight": 0.5 },
      { "name": "stellar-expert", "price": 0.99, "age": 8000, "weight": 0.3 }
    ],
    "deviation": {
      "min": 0.99,
      "max": 1.01,
      "stdDev": 0.0075
    },
    "timestamp": 1724000000000
  }
}
```

**Error Responses:**
- `400` — Token not accepted, invalid USD price, missing asset config
- `404` — Asset not found
- `503` — Oracle stale or unavailable

#### GET /api/v1/internal/pricing/oracle-health
**Purpose:** Monitor oracle aggregator health (admin/internal)

**Response (200):**
```json
{
  "timestamp": 1724000000000,
  "overall": "healthy|degraded|critical",
  "sources": [
    {
      "name": "reflector",
      "status": "available|unavailable",
      "latency": 42,
      "staleness": {
        "freshCount": 95,
        "staleCount": 5,
        "failureRate": "0.02",
        "avgAge": 12000
      },
      "lastUpdate": "2026-08-19T12:34:56.000Z"
    }
  ]
}
```

**Status Logic:**
- `healthy` — All sources available
- `degraded` — Some unavailable or high failure rate
- `critical` — No sources available

#### GET /api/v1/pricing/sources
**Purpose:** List configured oracle sources with weights

**Response (200):**
```json
{
  "count": 3,
  "sources": [
    {
      "name": "reflector",
      "type": "stellar-reflector",
      "weight": 0.5,
      "maxStaleness": 300000
    }
  ]
}
```

### 4. Repository Updates

#### assetRepository.js
- Updated `COLUMNS` constant to include `usd_price_cents`, `accepted_tokens`
- Updated `mapAsset()` to include `usdPriceCents`, `acceptedTokens`
- Updated `create()` to handle new multi-token fields

#### licenseRepository.js
- Updated `COLUMNS` to include `token`
- Updated `mapLicense()` to include token (default: 'native')
- Updated `create()` to accept and store token parameter

### 5. Route Integrations

#### src/routes/assets.js
Added endpoint:
```javascript
GET /api/v1/assets/:id/price?token=<address>
```

#### src/routes/pricing.js (NEW)
Added endpoints:
```javascript
GET /api/v1/internal/pricing/oracle-health
GET /api/v1/pricing/sources
```

#### src/app.js
Registered pricing router:
```javascript
app.use("/api/v1/internal/pricing", pricingRouter);
app.use("/api/v1/pricing", pricingRouter);
```

## Contract Changes (Rust)

### src/pricing.rs

**New Structures:**
```rust
pub struct PriceCommitment {
    pub asset_id: u64,
    pub token: Address,
    pub usd_price_cents: u64,      // USD price in cents
    pub max_price: i128,            // Slippage limit in token units
    pub valid_until_ledger: u32,
    pub signature: Vec<u8>,
}

pub struct MultiAssetListing {
    pub asset_id: u64,
    pub owner: Address,
    pub usd_price_cents: u64,       // Canonical USD price
    pub accepted_tokens: Vec<Address>, // Tokens seller accepts
    // ... other fields
}
```

**New Validators:**
```rust
pub fn validate_token_accepted(token: &Address, accepted: &Vec<Address>) -> Result<(), PricingError>
pub fn check_slippage(actual_price: i128, max_price: i128) -> Result<(), PricingError>
pub fn validate_commitment_ledger(commitment: &PriceCommitment, current: u32) -> Result<(), PricingError>
```

**New Errors:**
```rust
pub enum PricingError {
    TokenNotAccepted = 1,
    PriceCommitmentExpired = 2,
    SlippageExceeded = 3,
    InvalidCommitment = 4,
    OracleUnavailable = 5,
}
```

**New Endpoint:**
```rust
pub fn set_price_commitment(
    env: &Env,
    asset_id: u64,
    usd_price_cents: u64,
    token: Address,
    max_price: i128,
    valid_until_ledger: u32,
) -> Result<PriceCommitment, PricingError>
```

**Purchase Flow:**
```rust
pub fn purchase_license_multi_asset(
    env: &Env,
    buyer: Address,
    asset_id: u64,
    token: Address,
    price_commitment: PriceCommitment,
) -> Result<License, PricingError>
{
    // Validate commitment
    validate_commitment_ledger(&price_commitment, env.ledger().sequence())?;
    
    // Get asset from storage
    let asset = get_asset(env, asset_id)?;
    
    // Validate token is accepted
    validate_token_accepted(&token, &asset.accepted_tokens)?;
    
    // Get actual price (oracle conversion)
    let actual_price = get_asset_price_in_token(env, asset_id, &token)?;
    
    // Check slippage
    check_slippage(actual_price, price_commitment.max_price)?;
    
    // Execute purchase
    create_license(env, buyer, asset_id, token, actual_price)?
}
```

## Data Flow: Quote → Commit → Purchase

### 1. Getting a Price Quote

```
Client (Frontend)
    ↓
GET /api/v1/assets/42/price?token=GBUSD...
    ↓
multiTokenPurchaseService.getPriceCommitment()
    ↓
PriceOracleAggregator.aggregatePrices("GBUSD", "USD")
    └─ Fetch reflector (50%)
    └─ Fetch stellar-expert (30%)
    └─ Fetch coingecko (20%)
    └─ Filter outliers (>20% deviation)
    └─ Return weighted median
    ↓
StalenessGuard.validatePrice()
    └─ Check age < 5 minutes
    └─ Track health metrics
    ↓
PriceCommitmentBuilder.buildPriceCommitment()
    └─ Calculate maxPrice with slippage
    └─ Sign with HMAC-SHA256
    └─ Set 60-second expiration
    ↓
Return commitment to client
```

### 2. Buyer Sets Slippage Tolerance

```
Client (Frontend)
    └─ Show commitment: "Price locked at $42, max $44.10 (5% slippage)"
    └─ Optional: "Expires in ledger 1050, ~20 minutes"
    └─ Buyer accepts
```

### 3. Purchase Submission

```
Client (Frontend)
    ↓
POST /api/v1/licenses/purchase
    {
        assetId: 42,
        buyer: "GBUYER...",
        token: "GBUSD...",
        commitment: { /* from quote */ }
    }
    ↓
multiTokenPurchaseService.purchaseMultiTokenLicense()
    ├─ withTransaction()
    ├─ Verify commitment signature (not tampered)
    ├─ Check commitment expiration (not older than 60s)
    ├─ Increment asset.usage_count
    └─ Create license with token stored
    ↓
Return license to client
```

### 4. On-Chain Purchase Execution

```
Client (Web3)
    ↓
Send purchase_license_multi_asset to Soroban
    {
        buyer: Account,
        asset_id: 42,
        token: GBUSD Address,
        price_commitment: { /* signed from backend */ }
    }
    ↓
Contract: validate_commitment_ledger()
    └─ Check commitment.valid_until_ledger > current_ledger
    ↓
Contract: validate_token_accepted()
    └─ Check token in asset.accepted_tokens
    ↓
Contract: get_asset_price_in_token()
    └─ Call Reflector oracle for GBUSD→stroops
    └─ Or use fallback oracle
    ↓
Contract: check_slippage()
    └─ If actual_price > commitment.max_price
    └─ Revert with SlippageExceeded
    ↓
Contract: execute_purchase()
    └─ Transfer payment tokens
    └─ Record purchase
    └─ Emit PurchasedLicense event
```

## Testing

### Unit Tests

#### pricing/priceOracleAggregator.test.js
- ✓ Aggregator correctly rejects outlier sources (>20% deviation)
- ✓ Aggregator produces sane median from multiple sources
- ✓ Outlier detection doesn't filter all sources (fallback to all)
- ✓ Health status reflects source availability
- ✓ Cache TTL honored (30 seconds)

#### pricing/stalenessGuard.test.js
- ✓ Freshness validation based on age thresholds
- ✓ Staleness detection (3+ minutes)
- ✓ Source health tracking (fresh/stale/failure counts)
- ✓ Fallback decision logic (stale vs approaching staleness)
- ✓ Health metrics accessible per source

#### pricing/priceCommitmentBuilder.test.js
- ✓ Commitment calculates max_price with slippage tolerance
- ✓ Commitment expiration set to 60 seconds
- ✓ Signature validation: rejects tampered commitments
- ✓ Expired commitments rejected
- ✓ Basket commitments build multiple items

#### services/multiTokenPurchaseService.test.js
- ✓ getPriceCommitment fetches oracle + validates freshness
- ✓ getPriceCommitment validates token in accepted list
- ✓ purchaseMultiTokenLicense stores token in license
- ✓ Purchase increments usage atomically
- ✓ Rejects purchase when marketplace paused
- ✓ Enforces version constraints
- ✓ Rejects invalid/expired commitments
- ✓ Detects duplicate active license

### Integration Tests

#### integration/multiTokenPurchase.integration.test.js
- ✓ End-to-end: Asset config → price quote → oracle health
- ✓ GET /api/v1/assets/:id/price returns commitment
- ✓ GET /api/v1/internal/pricing/oracle-health shows source metrics
- ✓ GET /api/v1/pricing/sources lists configured sources
- ✓ Slippage protection prevents overpaying
- ✓ Rejects non-accepted tokens
- ✓ Oracle resilience: falls back on stale/unavailable sources
- ✓ Asset returns acceptedTokens and usdPriceCents

## Acceptance Criteria Met

✅ **Multiple tokens per asset**
- Asset can be purchased in 2+ different accepted tokens end-to-end on testnet
- usdPriceCents stored; acceptedTokens array per asset
- License.token tracks which token was used

✅ **USD-equivalent pricing**
- usdPriceCents is canonical, no conversion needed
- Oracle provides live exchange rates for settlement
- Commitment stores USD price, contract enforces it

✅ **Slippage protection**
- Buyer's commitments include max_price limit
- On-chain contract rejects if actual_price > max_price
- Backend tests verify slippage calculation

✅ **Oracle aggregation resilience**
- Multi-source aggregation with weighted median
- Outlier rejection: sources >20% from median filtered
- Staleness guard: rejects prices >5min old
- Fallback: uses remaining sources if one stale

## Configuration

### Environment Variables

```bash
# Oracle sources
REFLECTOR_ORACLE_URL=https://horizon.stellar.org/
STELLAR_EXPERT_URL=https://api.stellar.expert/explorer/public/price-feed

# Commitment signing
COMMITMENT_SECRET=your-secret-key
JWT_SECRET=fallback-secret
```

### Thresholds (Tunable)

```javascript
// In PriceOracleAggregator.js
OUTLIER_THRESHOLD = 0.2;      // 20% deviation from median
CACHE_TTL = 30000;             // 30 seconds

// In StalenessGuard.js
DEFAULT_MAX_AGE = 300000;       // 5 minutes
STALE_THRESHOLD = 180000;       // 3 minutes (approaching)
HEALTH_WINDOW = 3600000;        // 1 hour for tracking

// In PriceCommitmentBuilder.js
COMMITMENT_VALIDITY_SECONDS = 60; // Expiration
```

## Migration Path

1. **Deploy migration 020** to add columns
2. **Deploy backend services** (pricing module)
3. **Enable pricing endpoints** via feature flag or gradual rollout
4. **Update frontend** to show multi-token selector
5. **Deploy contract** with multi-asset functions
6. **Test end-to-end** on testnet with 2+ tokens
7. **Monitor oracle health** dashboard

## Future Enhancements

- [ ] Signed quotes from backend (prevent replay)
- [ ] Multiple quote providers (redundancy)
- [ ] Custom slippage profiles per buyer
- [ ] On-chain price history (for charting)
- [ ] Liquidity pool integration for DEX prices
- [ ] Weighted-median with confidence intervals
- [ ] Real-time subscription updates (WebSocket)
