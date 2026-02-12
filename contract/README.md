# Cortex Protocol — Soroban Smart Contracts

Stellar Soroban smart contracts powering the Intelligence Rail marketplace.

## Contracts

### `marketplace`
Core marketplace contract for listing, discovering, and purchasing intelligence assets.

- `initialize(owner)` — Set up the marketplace admin
- `list_asset(...)` — Register an intelligence asset for sale
- `delist_asset(owner, asset_id)` — Remove an asset from the marketplace
- `update_price(owner, asset_id, price)` — Update asset pricing
- `purchase_license(buyer, asset_id, token)` — Buy a license (triggers XLM/token payment)
- `get_asset(id)` / `has_license(buyer, id)` / `asset_count()` — Query helpers

### `micropayments`
Payment streaming for usage-based intelligence asset billing.

- `open_stream(sender, recipient, token, deposit, rate, duration)` — Start a stream
- `withdraw(recipient, stream_id)` — Claim accrued payments
- `cancel_stream(sender, stream_id)` — Cancel and settle
- `pause_stream` / `resume_stream` — Flow control
- `claimable_amount(stream_id)` — Real-time balance query

### `agent_registry`
On-chain agent identity, capability declarations, and reputation.

- `register_agent(owner, name, description, capabilities)` — Create an agent identity
- `update_capabilities(owner, agent_id, capabilities)` — Update capability set
- `vote_reputation(voter, agent_id, score)` — Submit a reputation rating
- `record_transaction(caller, agent_id)` — Log completed transactions
- `deactivate_agent(owner, agent_id)` — Retire an agent

## Asset Types

| Type | Description |
|------|-------------|
| `Prompt` | Reusable prompt templates |
| `Workflow` | Multi-step agent workflows |
| `ReasoningChain` | Structured reasoning templates |
| `Dataset` | Curated training / context data |
| `Evaluator` | Quality/scoring components |
| `MemorySystem` | Persistent agent memory modules |
| `ModelInstruction` | System-level model instructions |
| `Tool` | Callable agent tools |

## License Models

| License | Description |
|---------|-------------|
| `Perpetual` | One-time purchase |
| `UsageBased` | Pay-per-call (100-call bundles) |
| `Subscription` | Time-bound access |
| `OpenSource` | Attribution required |

## Build

```bash
# Build all contracts
cargo build --target wasm32-unknown-unknown --release

# Run tests
cargo test
```

## Deploy (Testnet)

```bash
stellar contract deploy \
  --wasm target/wasm32-unknown-unknown/release/marketplace.wasm \
  --network testnet \
  --source <your-key>
```

## Testnet Contract Addresses

Deployed contract addresses are maintained in `.env` / `backend/.env`. Check the network config endpoint at `GET /api/v1/stellar/network` for live addresses.
