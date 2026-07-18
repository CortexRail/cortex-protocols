# Cortex Protocol — Backend API

Supporting services for Intelligence Rail: agent discovery, asset indexing, and Stellar/Soroban integration.

## Stack

- **Node.js 20+** / **Express 4**
- **@stellar/stellar-sdk** for Soroban RPC and Horizon access
- **express-validator** for input validation
- **Jest + Supertest** for testing

## Getting Started

```bash
cp .env.example .env
# fill in STELLAR_* and CONTRACT_* values

npm install
npm run dev
```

## API Routes

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/health` | Health check |
| `GET` | `/api/v1/assets` | List intelligence assets |
| `GET` | `/api/v1/assets/:id` | Get asset by ID |
| `POST` | `/api/v1/assets` | Index an asset (from event listener) |
| `POST` | `/api/v1/assets/:id/purchase` | Purchase a license, optionally pinned to an asset version |
| `GET` | `/api/v1/assets/types/list` | Valid asset/license types |
| `GET` | `/api/v1/agents` | Discover agents |
| `GET` | `/api/v1/agents/:id` | Get agent by ID |
| `POST` | `/api/v1/agents` | Index an agent |
| `GET` | `/api/v1/agents/capabilities/list` | Valid capability tags |
| `GET` | `/api/v1/streams` | List payment streams |
| `GET` | `/api/v1/streams/:id` | Get stream by ID |
| `POST` | `/api/v1/streams` | Index a stream |
| `GET` | `/api/v1/stellar/account/:publicKey` | Horizon account info |
| `GET` | `/api/v1/stellar/network` | Network config |
| `GET` | `/api/v1/stellar/fee` | Fee statistics |

## Query Parameters — Assets

| Param | Type | Description |
|-------|------|-------------|
| `assetType` | enum | Filter by asset type |
| `licenseType` | enum | Filter by license model |
| `minPrice` / `maxPrice` | integer (stroops) | Price range |
| `search` | string | Full-text search on name/description/tags |
| `page` / `limit` | integer | Pagination |

## Asset and license versions

Every asset response includes:

- `version`: the asset's current on-chain version.
- `availableVersions`: the retained versions that can be purchased. This is
  the latest five total versions, including the current version. For example,
  version 1 exposes `[1]`, version 3 exposes `[1, 2, 3]`, and version 7 exposes
  `[3, 4, 5, 6, 7]`.

Every license response includes `assetVersion`, identifying the asset version
selected at purchase time. Existing indexed assets and licenses are version 1.

To pin a purchase, send an optional integer `assetVersion`:

```json
{
  "buyer": "G...",
  "assetVersion": 3
}
```

When `assetVersion` is omitted, the current asset version is selected. A
version is purchasable only when it is no newer than the current version and
is within the retained range `max(1, version - 4)` through `version`. Purchases
always use the asset's current price, license type, and active status.

## Event Listener

`src/listeners/eventListener.js` polls the Soroban RPC for `LISTED`, `UPDATED`,
`DELISTED`, and `REGISTERED` events and keeps the off-chain index in sync. An
`UPDATED` event advances `assets.version`; its payload has no description, so
the listener leaves indexed descriptions unchanged. Start it alongside the API:

```js
const { startEventListener } = require("./listeners/eventListener");
startEventListener(5_000); // poll every 5 seconds
```

## Environment Variables

See `.env.example` for the full list. Key vars:

- `STELLAR_NETWORK` — `testnet` | `mainnet`
- `STELLAR_RPC_URL` — Soroban RPC endpoint
- `MARKETPLACE_CONTRACT_ID` — deployed marketplace contract address
- `MICROPAYMENTS_CONTRACT_ID` — deployed micropayments contract address
- `AGENT_REGISTRY_CONTRACT_ID` — deployed agent registry contract address

## Tests

```bash
npm test
```

## Current Limitations

- In-memory storage is used for asset/agent indexing. A persistent database (PostgreSQL, SQLite) should be wired in for production.
- The event listener uses simple polling. A WebSocket subscription should replace this for production deployments.
- Transaction signing uses a server-side keypair. Wallet-signed transactions (Freighter/Albedo) should be preferred for user-facing operations.

> API version: v1 — Last updated July 2026
