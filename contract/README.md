# Cortex Protocol — Contract Deployment Guide

> Complete walkthrough: from compiled WASM to fully initialised, verified, and monitored contracts on Stellar testnet.

---

## Table of Contents

1. [Overview](#overview)
2. [Architecture](#architecture)
3. [Prerequisites](#prerequisites)
4. [Environment Setup](#environment-setup)
5. [Quick Start (Fresh Machine)](#quick-start-fresh-machine)
6. [Shell Scripts Reference](#shell-scripts-reference)
   - [fund_accounts.sh](#fund_accountssh)
   - [deploy.sh](#deploysh)
   - [init.sh](#initsh)
   - [verify.sh](#verifysh)
7. [TypeScript Deployment Client](#typescript-deployment-client)
   - [Installation](#installation)
   - [Commands](#commands)
   - [Full Pipeline](#full-pipeline)
8. [Contract Details](#contract-details)
   - [Marketplace](#marketplace-contract)
   - [Micropayments](#micropayments-contract)
   - [Agent Registry](#agent-registry-contract)
9. [Monitoring](#monitoring)
   - [Health Check](#health-check-monitor)
   - [Alerting](#alerting)
10. [CI/CD Pipeline](#cicd-pipeline)
11. [deployed_addresses.json](#deployed_addressesjson)
12. [Troubleshooting](#troubleshooting)
13. [Security Notes](#security-notes)

---

## Overview

Cortex Protocol deploys three Soroban smart contracts to Stellar testnet:

| Contract | Purpose |
|----------|---------|
| **Marketplace** | Lists, purchases, and manages intelligence assets |
| **Micropayments** | Streaming payments (per-second / per-call billing) |
| **Agent Registry** | On-chain identity and reputation for autonomous agents |

The deployment pipeline proceeds in four stages:

```
Fund accounts → Build WASM → Deploy → Initialise → Verify → Monitor
```

---

## Architecture

```
cortex-protocols/
├── contract/
│   ├── contracts/
│   │   ├── marketplace/       # Soroban marketplace contract (Rust)
│   │   ├── micropayments/     # Payment streaming contract (Rust)
│   │   └── agent_registry/    # Agent identity contract (Rust)
│   ├── scripts/
│   │   ├── deploy.sh          # Deploy + re-deploy detection
│   │   ├── init.sh            # Post-deploy initialisation
│   │   ├── verify.sh          # On-chain state verification
│   │   └── fund_accounts.sh   # Create & fund keypairs via Friendbot
│   ├── deploy/                # TypeScript deployment client
│   │   ├── src/
│   │   │   ├── types.ts       # TypeScript mirror of Rust types
│   │   │   ├── deployer.ts    # Deployment class (retry, fee bump)
│   │   │   ├── initialiser.ts # Contract initialisation
│   │   │   ├── verifier.ts    # State verification
│   │   │   └── index.ts       # CLI entry point
│   │   ├── package.json
│   │   └── tsconfig.json
│   ├── monitoring/
│   │   ├── healthCheck.ts     # 60s polling → status.json
│   │   └── alerting.ts        # Webhook alerts (Discord/Slack)
│   ├── deployed_addresses.json  # Auto-generated after deploy
│   └── .stellar/              # Keypairs — GITIGNORED
├── backend/
│   └── .env                   # Auto-updated with contract addresses
└── .github/
    └── workflows/
        └── contract-deploy.yml  # CI: build → test → deploy → verify
```

---

## Prerequisites

### Required (minimum)

| Tool | Version | Install |
|------|---------|---------|
| **Stellar CLI** | ≥ 0.9.0 | [Install guide](https://developers.stellar.org/docs/tools/developer-tools/cli/install-cli) |
| **Rust** | stable + `wasm32-unknown-unknown` | `curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs \| sh` |
| **jq** | any | `brew install jq` / `apt-get install jq` |

### Optional (TypeScript client)

| Tool | Version |
|------|---------|
| **Node.js** | ≥ 18.0.0 |
| **npm** | ≥ 9.0.0 |

### Add the `wasm32` target

```bash
rustup target add wasm32-unknown-unknown
```

---

## Environment Setup

### 1. Clone and navigate

```bash
git clone https://github.com/ONEONUORA/cortex-protocols.git
cd cortex-protocols/contract
```

### 2. Create your environment file

```bash
cp ../backend/.env.example ../backend/.env
```

### 3. Set required variables

The only **required** environment variable at deploy time is your Stellar secret key:

```bash
export STELLAR_SECRET_KEY=SXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX
```

All other variables have sensible defaults for testnet:

| Variable | Default | Description |
|----------|---------|-------------|
| `STELLAR_NETWORK` | `testnet` | Network: testnet \| mainnet \| futurenet |
| `STELLAR_RPC_URL` | `https://soroban-testnet.stellar.org` | Soroban RPC endpoint |
| `STELLAR_HORIZON_URL` | `https://horizon-testnet.stellar.org` | Horizon REST API |
| `STELLAR_PASSPHRASE` | testnet passphrase | Network passphrase |
| `FORCE_REDEPLOY` | `false` | Skip existing address check |
| `ACCOUNTS` | `deployer buyer1 buyer2` | Accounts to fund |
| `ALERT_WEBHOOK_URL` | _(empty)_ | Discord/Slack webhook for alerts |

### 4. Configure GitHub Actions secrets (for CI)

In your GitHub repository settings → Secrets and variables → Actions, add:

| Secret | Description |
|--------|-------------|
| `STELLAR_DEPLOYER_SECRET_KEY` | Secret key for the deployer account (funded on testnet) |

---

## Quick Start (Fresh Machine)

The following steps bring up all three contracts on testnet from scratch, with only Stellar CLI installed:

```bash
# 1. Clone
git clone https://github.com/ONEONUORA/cortex-protocols.git
cd cortex-protocols/contract

# 2. Install Rust + wasm target
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
source $HOME/.cargo/env
rustup target add wasm32-unknown-unknown

# 3. Fund a deployer account (creates keypair + funds via Friendbot)
bash scripts/fund_accounts.sh

# 4. Source the generated key
source .stellar/deployer.env

# 5. Deploy all contracts
bash scripts/deploy.sh

# 6. Initialise (seeds assets + agents)
bash scripts/init.sh

# 7. Verify on-chain state
bash scripts/verify.sh
```

> **Expected output of step 7:** `✔ All contracts verified successfully!`

### Alternatively, use the TypeScript client (requires Node 18+):

```bash
cd contract/deploy
npm install
source ../.stellar/deployer.env    # or: export STELLAR_SECRET_KEY=S...
npm run deploy:full                 # deploy → init → verify in one command
```

---

## Shell Scripts Reference

### `fund_accounts.sh`

Creates and funds Stellar keypairs via the testnet Friendbot.

```bash
# Fund default accounts (deployer, buyer1, buyer2)
bash scripts/fund_accounts.sh

# Fund custom set of accounts
ACCOUNTS="alice bob" bash scripts/fund_accounts.sh
```

**Outputs:**
- `.stellar/deployer.json` — keypair JSON `{ account, network, public_key, secret_key }`
- `.stellar/buyer1.json`
- `.stellar/buyer2.json`
- `.stellar/deployer.env` — sourceable `export STELLAR_SECRET_KEY=...`

All files in `.stellar/` are chmod 600 and gitignored automatically.

---

### `deploy.sh`

Builds all contracts and deploys them to Stellar testnet.

```bash
# Standard deploy (skips contracts already deployed)
STELLAR_SECRET_KEY=S... bash scripts/deploy.sh

# Force redeploy even if addresses exist
FORCE_REDEPLOY=true STELLAR_SECRET_KEY=S... bash scripts/deploy.sh
```

**Re-deployment detection:**
Before deploying, the script calls `stellar contract info --id <address>` to check if the address still exists on-chain. If it does, deployment is skipped (idempotent). Use `FORCE_REDEPLOY=true` to bypass.

**Outputs:**
- `contract/deployed_addresses.json` — structured JSON (see [below](#deployed_addressesjson))
- `backend/.env` — auto-updated with `MARKETPLACE_CONTRACT_ID`, etc.

**Retry logic:** Each contract deployment retries up to 5 times with exponential backoff (2s, 4s, 8s, 16s, 32s).

---

### `init.sh`

Post-deploy initialisation. Calls `initialize(admin)` on the marketplace, seeds 3 sample intelligence assets, and registers 2 agents.

```bash
STELLAR_SECRET_KEY=S... bash scripts/init.sh
```

**Requires:** `contract/deployed_addresses.json` (run `deploy.sh` first)

**What it does:**

1. **`marketplace::initialize(owner)`** — sets the admin/owner of the marketplace contract
2. **`marketplace::list_asset` × 3** — seeds:
   - *GPT-4 Prompt Optimizer* — Prompt, Perpetual, 5 XLM
   - *Automated Code Review Workflow* — Workflow, UsageBased, 1 XLM/call
   - *CoT Reasoning Dataset v2* — Dataset, OpenSource, 0.5 XLM
3. **`agent_registry::register_agent` × 2** — registers:
   - *ResearchBot-Alpha* — capabilities: WebResearch, TextGeneration, Reasoning, DataAnalysis
   - *CodeForge-v1* — capabilities: CodeGeneration, Reasoning, ActionExecution

---

### `verify.sh`

Queries all contract view functions and asserts the expected on-chain state. Exits with code `1` on any mismatch — suitable for CI gates.

```bash
STELLAR_SECRET_KEY=S... bash scripts/verify.sh
```

**Checks performed:**

| Contract | Function | Expected |
|----------|---------|---------|
| Marketplace | `asset_count()` | `3` |
| Marketplace | `get_asset(1)` | name = "GPT-4 Prompt Optimizer" |
| Marketplace | `get_asset(2)` | name = "Automated Code Review Workflow" |
| Marketplace | `get_asset(3)` | name = "CoT Reasoning Dataset v2" |
| Marketplace | `get_asset(999)` | `None` |
| Agent Registry | `agent_count()` | `2` |
| Agent Registry | `get_agent(1)` | name = "ResearchBot-Alpha" |
| Agent Registry | `get_agent(2)` | name = "CodeForge-v1" |
| Agent Registry | `get_reputation(1)` | `5000` (neutral) |
| Agent Registry | `get_reputation(2)` | `5000` (neutral) |
| Micropayments | `stream_count()` | `0` |
| XDR decode | `contract read --key A_COUNT` | non-empty |

---

## TypeScript Deployment Client

### Installation

```bash
cd contract/deploy
npm install
```

### Commands

```bash
npm run deploy          # Deploy all contracts
npm run init            # Initialise (requires deployed_addresses.json)
npm run verify          # Verify on-chain state
npm run deploy:full     # Complete pipeline: deploy → init → verify
npm run deploy:clean    # Force redeploy + full pipeline
npm run typecheck       # TypeScript type check (no emit)
npm run build           # Compile to dist/
```

### Configuration

The TypeScript client reads the same environment variables as the shell scripts. It also loads from:

- `contract/deploy/.env`
- `contract/.env`
- `backend/.env`
- `contract/.stellar/deployer.env`

### Full Pipeline

```bash
export STELLAR_SECRET_KEY=SXXX...
npm run deploy:full
```

Expected output:
```
╔══════════════════════════════════════════════╗
║   Cortex Protocol — Full Pipeline            ║
║   deploy → init → verify                     ║
╚══════════════════════════════════════════════╝

Step 1/3: Deployment
🚀 Starting deployment to TESTNET
   Deployer: GXXXXX...

📦 Deploying marketplace (45.2 KB)...
   ⏳ TX submitted: abc123...
   ✓ Confirmed at ledger 12345
   ✓ marketplace → CMARKETPLACE...

...

Step 2/3: Initialisation
▶ Initialising Marketplace contract
   ✓ Marketplace initialized
▶ Seeding sample intelligence assets
   [1/3] Listing: GPT-4 Prompt Optimizer... ✓
   [2/3] Listing: Automated Code Review Workflow... ✓
   [3/3] Listing: CoT Reasoning Dataset v2... ✓

Step 3/3: Verification
▶ Verifying Marketplace
   ✓ marketplace::asset_count: 3
   ✓ asset[1].name: GPT-4 Prompt Optimizer
   ...

✔ Full pipeline completed in 42.3s
```

---

## Contract Details

### Marketplace Contract

**Address (after deploy):** see `deployed_addresses.json`

| Function | Description | Auth |
|----------|-------------|------|
| `initialize(owner)` | Set admin, init asset count | owner |
| `list_asset(owner, name, desc, type, license, price)` | List new asset → returns asset_id | owner |
| `delist_asset(owner, asset_id)` | Deactivate an asset | owner |
| `update_price(owner, asset_id, new_price)` | Change price | owner |
| `purchase_license(buyer, asset_id, token)` | Buy a license via token transfer | buyer |
| `get_asset(asset_id)` | Read asset record | none |
| `asset_count()` | Total assets listed | none |
| `has_license(buyer, asset_id)` | Check if buyer holds license | none |
| `get_license(buyer, asset_id)` | Get license details | none |

**Asset types:** Prompt, Workflow, ReasoningChain, Dataset, Evaluator, MemorySystem, ModelInstruction, Tool

**License types:** Perpetual, UsageBased (100 calls default), Subscription, OpenSource

---

### Micropayments Contract

| Function | Description | Auth |
|----------|-------------|------|
| `open_stream(sender, recipient, token, deposit, rate_per_second, duration_secs)` | Open a payment stream | sender |
| `withdraw(recipient, stream_id)` | Claim accrued funds | recipient |
| `cancel_stream(sender, stream_id)` | Cancel; refund unearned | sender |
| `pause_stream(sender, stream_id)` | Pause billing | sender |
| `resume_stream(sender, stream_id)` | Resume billing | sender |
| `get_stream(stream_id)` | Read stream record | none |
| `claimable_amount(stream_id)` | Current withdrawable amount | none |
| `stream_count()` | Total streams opened | none |

---

### Agent Registry Contract

| Function | Description | Auth |
|----------|-------------|------|
| `register_agent(owner, name, desc, capabilities)` | Register new agent → returns agent_id | owner |
| `update_capabilities(owner, agent_id, capabilities)` | Update capability flags | owner |
| `vote_reputation(voter, agent_id, score)` | Submit reputation vote (0–100) | voter |
| `record_transaction(caller, agent_id)` | Increment tx counter | caller |
| `deactivate_agent(owner, agent_id)` | Deactivate agent | owner |
| `get_agent(agent_id)` | Read agent record | none |
| `agent_count()` | Total agents registered | none |
| `get_reputation(agent_id)` | Current reputation (0–10000 bp) | none |

**Capabilities:** TextGeneration, CodeGeneration, Reasoning, VisionUnderstanding, AudioProcessing, DataAnalysis, WebResearch, ActionExecution

---

## Monitoring

### Health Check Monitor

Polls each contract's view function every 60 seconds and writes a `status.json` file:

```bash
cd contract/monitoring
npx ts-node healthCheck.ts
```

**`status.json` format:**
```json
{
  "network": "testnet",
  "timestamp": "2026-07-18T11:00:00Z",
  "overall": "healthy",
  "contracts": {
    "marketplace": {
      "name": "marketplace",
      "address": "CMARKETPLACE...",
      "status": "healthy",
      "lastChecked": "2026-07-18T11:00:00Z",
      "responseTimeMs": 342,
      "consecutiveFailures": 0
    }
  }
}
```

**Status values:** `healthy` | `degraded` (>10s response) | `unreachable` (≥3 consecutive failures) | `unknown`

### Alerting

Sends a webhook notification when a contract is unreachable for >3 consecutive checks:

```bash
# Configure webhook (supports Discord, Slack, or generic)
export ALERT_WEBHOOK_URL=https://discord.com/api/webhooks/xxx/yyy

# Test the alert system
npx ts-node -e "import('./alerting.js').then(m => m.sendTestAlert())"
```

**Alert cooldown:** 10 minutes per contract (prevents spam)

**`alert_log.jsonl`** — persistent log of all triggered alerts

---

## CI/CD Pipeline

The workflow at [`.github/workflows/contract-deploy.yml`](../.github/workflows/contract-deploy.yml) runs automatically on every push to `main` that touches `contract/`.

### Stages

```
build-and-test → deploy → initialise → verify → post-commit-status
```

| Job | What it does |
|-----|-------------|
| **build-and-test** | `cargo fmt`, `clippy`, `cargo test`, build WASM |
| **deploy** | Run `deploy.sh`, upload `deployed_addresses.json` artifact |
| **initialise** | Run `init.sh` to seed assets and agents |
| **verify** | Run `verify.sh`, fail pipeline if any check fails |
| **post-commit-status** | Post addresses as GitHub commit status + PR comment |

### Required GitHub Secret

```
STELLAR_DEPLOYER_SECRET_KEY = SXXX...  (funded testnet account)
```

### Outputs

- **Commit status** — shown as ✅/❌ on each commit with deployer link to stellar.expert
- **PR comment** — table of all three contract addresses with Stellar Expert links + `.env` snippet
- **Step summary** — markdown table in the GitHub Actions run summary

### Manual trigger

```bash
# Force redeploy via workflow dispatch
gh workflow run contract-deploy.yml -f force_redeploy=true
```

---

## deployed_addresses.json

Auto-generated by `deploy.sh` and the TypeScript deployer. Do not edit manually.

```json
{
  "network": "testnet",
  "deployed_at": "2026-07-18T11:00:00Z",
  "contracts": {
    "marketplace": {
      "address": "CMARKETPLACEADDRESS...",
      "name": "MarketplaceContract"
    },
    "micropayments": {
      "address": "CMICROPAYMENTSADDR...",
      "name": "MicropaymentsContract"
    },
    "agent_registry": {
      "address": "CAGENTREGISTRYADDR...",
      "name": "AgentRegistryContract"
    }
  }
}
```

This file is automatically read by `init.sh`, `verify.sh`, the TypeScript client, and the monitoring module. It is also synced to `backend/.env`.

---

## Troubleshooting

### `STELLAR_SECRET_KEY not set`

```bash
export STELLAR_SECRET_KEY=SXXX...
# or source the generated env file:
source contract/.stellar/deployer.env
```

### `stellar: command not found`

Install the Stellar CLI:
```bash
# macOS
brew install stellar-cli

# Linux
curl -sSf https://raw.githubusercontent.com/stellar/stellar-cli/main/install.sh | sh
echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.bashrc
source ~/.bashrc

stellar version
```

### `WASM not found`

The WASM must be built before deploying:
```bash
cd contract
cargo build --target wasm32-unknown-unknown --release
```

### `Transaction submission failed: fee too low`

Increase the fee:
```bash
export MAX_FEE=5000000   # 0.5 XLM
```

### `Account not found on network`

The deployer account hasn't been funded. Run:
```bash
bash scripts/fund_accounts.sh
```
Or manually fund via Friendbot:
```bash
curl "https://friendbot.stellar.org?addr=YOUR_PUBLIC_KEY"
```

### `deployed_addresses.json not found`

Run `deploy.sh` before `init.sh` or `verify.sh`:
```bash
bash scripts/deploy.sh
```

### Contract already initialized error

`init.sh` handles this gracefully — it detects "already initialized" errors and skips re-initialization. If you need to start fresh, redeploy with `FORCE_REDEPLOY=true`.

### XDR decode returns empty

`stellar contract read` requires `--source` in some CLI versions. This is a non-fatal check in `verify.sh`. The core verification (via `contract invoke`) is unaffected.

### Verification fails after a fresh deploy

Wait a few ledgers (15-30 seconds) for the testnet to process transactions, then re-run:
```bash
sleep 30 && bash scripts/verify.sh
```

### TypeScript client: `Cannot find module '@stellar/stellar-sdk'`

```bash
cd contract/deploy
npm install
```

### TypeScript client: `ERR_UNKNOWN_FILE_EXTENSION`

Ensure you're using Node 18+ with ESM support:
```bash
node --version  # should be >= 18.0.0
npm run deploy:full  # uses ts-node/esm loader automatically
```

---

## Security Notes

- **Never commit** your `STELLAR_SECRET_KEY` to version control.
- The `.stellar/` directory is automatically added to `.gitignore` by `fund_accounts.sh`.
- Keypair files in `.stellar/` are set to `chmod 600` (owner read-only).
- In production, use a hardware wallet or Stellar's multi-sig for contract admin keys.
- The `STELLAR_DEPLOYER_SECRET_KEY` GitHub secret should belong to a dedicated CI account, not your personal key.
- Review the `MAX_FEE` setting — the default (0.1 XLM) is conservative but safe for testnet.

---

*Cortex Protocol · MIT License · [GitHub](https://github.com/ONEONUORA/cortex-protocols)*
