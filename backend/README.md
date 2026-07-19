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
| `GET` | `/api/v1/assets/types/list` | Valid asset/license types |
| `GET` | `/api/v1/agents` | Discover agents |
| `GET` | `/api/v1/agents/:id` | Get agent by ID |
| `POST` | `/api/v1/agents` | Index an agent |
| `GET` | `/api/v1/agents/capabilities/list` | Valid capability tags |
| `GET` | `/api/v1/streams` | List payment streams |
| `GET` | `/api/v1/streams/:id` | Get stream by ID |
| `POST` | `/api/v1/streams` | Index a stream |
| `GET` | `/api/v1/stellar/account/:publicKey` | Horizon account info |
| `GET` | `/api/v1/stellar/account/:publicKey/transactions` | Paginated payment history |
| `GET` | `/api/v1/stellar/network` | Network config |
| `GET` | `/api/v1/stellar/fee` | Fee statistics |
| `POST` | `/api/v1/stellar/fund` | Fund a Testnet account via Friendbot |

## Query Parameters — Assets

| Param | Type | Description |
|-------|------|-------------|
| `assetType` | enum | Filter by asset type |
| `licenseType` | enum | Filter by license model |
| `minPrice` / `maxPrice` | integer (stroops) | Price range |
| `search` | string | Full-text search on name/description/tags |
| `page` / `limit` | integer | Pagination |

## Stellar Testnet Faucet — `POST /api/v1/stellar/fund`

Funds a Stellar **Testnet** account via [Friendbot](https://developers.stellar.org/docs/learn/interactive/friendbot) for developer onboarding — no server-side signing key required.

**This endpoint is Testnet-only.** When `STELLAR_NETWORK` is not `testnet`, it always returns `403` without contacting Friendbot.

It is also rate-limited to **1 request per IP per hour** to prevent abuse of the public faucet.

### Request

```http
POST /api/v1/stellar/fund
Content-Type: application/json

{
  "publicKey": "GDQRRTSA2OFYBTJT2Y7BWE5HM5TGQJBSTD2VJKSCOH62SY7TRYLUS24Y"
}
```

### Success response — `200 OK`

```json
{
  "publicKey": "GDQRRTSA2OFYBTJT2Y7BWE5HM5TGQJBSTD2VJKSCOH62SY7TRYLUS24Y",
  "funded": true,
  "hash": "c123...abc"
}
```

### Error responses

| Status | When | Body |
|--------|------|------|
| `400 Bad Request` | `publicKey` missing or not a valid Stellar public key | `{ "error": "publicKey is required" }` |
| `403 Forbidden` | Server is configured for a non-Testnet network | `{ "error": "Friendbot is only available on Stellar Testnet." }` |
| `429 Too Many Requests` | More than 1 request from the same IP within an hour | `{ "error": "Only one Friendbot request is allowed per IP per hour. Please try again later." }` |
| `500 Internal Server Error` | Friendbot is unreachable or rejects the request (e.g. the account already exists) | `{ "error": "Internal Server Error" }` |

## Event Listener

`src/listeners/eventListener.js` polls the Soroban RPC for `LISTED`, `DELISTED`, and `REGISTERED` events and keeps the off-chain index in sync. Start it alongside the API:

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
