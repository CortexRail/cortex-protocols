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
| `POST` | `/api/v1/assets/:id/report` | File a moderation report against an asset |
| `GET` | `/api/v1/assets/types/list` | Valid asset/license types |
| `GET` | `/api/v1/admin/reports` | List moderation reports (admin only) |
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

## Community Moderation — Reporting Assets

### `POST /api/v1/assets/:id/report`

Files a moderation report against an asset.

**Request body:**

```json
{
  "reporter": "GABC...", // Stellar public key of the reporter (required)
  "reason": "Spam",      // one of: Spam, Plagiarism, Malicious, Misleading, PolicyViolation, Other
  "details": "optional free-text context, max 2000 chars"
}
```

**Response — `201 Created`:**

```json
{
  "report": {
    "id": 1,
    "assetId": 3,
    "reporter": "GABC...",
    "reason": "Spam",
    "details": "...",
    "status": "Pending",
    "resolutionNote": null,
    "createdAt": 1737558000000,
    "resolvedAt": null
  },
  "flagged": false
}
```

**Validation & status codes:**

| Status | Cause |
|--------|-------|
| `201` | Report filed |
| `404` | Asset does not exist |
| `409` | Reporter already has an open (`Pending`/`UnderReview`) report on this asset |
| `422` | Missing/empty/unrecognized `reason`, invalid `reporter` key, or `details` over 2000 chars |

**Auto-flagging:** once an asset has accumulated **more than 5** reports (any status, all-time), it is automatically marked `flagged: true` on the asset record. `flagged`/`flaggedAt` are included in every asset response (`GET /api/v1/assets`, `GET /api/v1/assets/:id`). Flagging does not remove or deactivate the asset — it's a signal for moderators.

### `GET /api/v1/admin/reports` (admin only)

Lists moderation reports, most recent first, with the related asset attached to each row. Requires the `x-admin-key` header to match `ADMIN_API_KEY` (see `.env.example`); returns `503` if no key is configured on the deployment, `401` on a missing/wrong key.

**Query params:** `status` (`Pending`/`UnderReview`/`Resolved`/`Dismissed`), `assetId`, `page`, `limit`.

**Removing a flagged asset:** the marketplace contract's `delist_asset` only accepts a signature from the asset's own owner (`owner.require_auth()`), so there is no on-chain admin override today. An admin can soft-delete a flagged asset from the off-chain index (same path the `DELISTED` event listener uses), but the on-chain listing itself still requires the owner to delist it themselves.

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
