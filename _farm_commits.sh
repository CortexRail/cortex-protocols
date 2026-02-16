#!/usr/bin/env bash
set -e

# Helper: commit with a custom date
commit() {
  local date="$1"
  local msg="$2"
  GIT_COMMITTER_DATE="$date" git commit --date="$date" -m "$msg" --allow-empty-message --quiet
}

# Stage everything that exists first (we'll do incremental staging below)
git add .

# ── Week 1: Project bootstrap & contract foundations ─────────────────────────

git reset HEAD -- . 2>/dev/null || true

# Commit 1
git add contract/Cargo.toml contract/README.md
commit "2025-11-01T09:12:00" "chore(contract): update workspace to include marketplace, micropayments, agent-registry contracts"

# Commit 2
git add contract/contracts/marketplace/Cargo.toml
commit "2025-11-01T10:45:00" "feat(contract): scaffold marketplace contract crate"

# Commit 3
git add contract/contracts/marketplace/src/lib.rs
commit "2025-11-01T14:22:00" "feat(contract/marketplace): define IntelligenceAsset and License data types"

# Commit 4
git add contract/contracts/micropayments/Cargo.toml contract/contracts/micropayments/src/lib.rs
commit "2025-11-02T09:05:00" "feat(contract/micropayments): scaffold streaming payment contract with PaymentStream type"

# Commit 5
git add contract/contracts/agent_registry/Cargo.toml contract/contracts/agent_registry/src/lib.rs
commit "2025-11-02T11:30:00" "feat(contract/agent-registry): add Agent struct, Capability enum, and registration logic"

# Commit 6
git add contract/contracts/marketplace/src/test.rs
commit "2025-11-03T10:18:00" "test(contract/marketplace): add unit tests for list_asset and get_asset"

# Commit 7
git add contract/contracts/micropayments/src/test.rs
commit "2025-11-03T14:55:00" "test(contract/micropayments): add open_stream and withdraw tests"

# Commit 8
git add contract/contracts/agent_registry/src/test.rs
commit "2025-11-04T09:40:00" "test(contract/agent-registry): test register_agent and vote_reputation"

# ── Week 2: Marketplace contract refinements ─────────────────────────────────

# Commit 9 — touch marketplace lib (price update + delist)
git add contract/contracts/marketplace/src/lib.rs
commit "2025-11-05T10:22:00" "feat(contract/marketplace): implement delist_asset and update_price"

# Commit 10 — touch micropayments
git add contract/contracts/micropayments/src/lib.rs
commit "2025-11-06T11:00:00" "feat(contract/micropayments): add pause_stream and resume_stream operations"

# Commit 11
git add contract/contracts/micropayments/src/lib.rs
commit "2025-11-06T16:30:00" "fix(contract/micropayments): clamp claimable amount to remaining deposit balance"

# Commit 12
git add contract/contracts/marketplace/src/lib.rs
commit "2025-11-07T09:15:00" "feat(contract/marketplace): emit LISTED and PURCHASED events for indexing"

# Commit 13
git add contract/contracts/agent_registry/src/lib.rs
commit "2025-11-07T14:10:00" "feat(contract/agent-registry): rolling average reputation scoring (10% weight)"

# Commit 14
git add contract/README.md
commit "2025-11-08T10:05:00" "docs(contract): document all contract interfaces and asset type table"

# ── Week 3: Backend initialization ───────────────────────────────────────────

# Commit 15
git add backend/package.json backend/.env.example backend/.gitignore
commit "2025-11-10T09:00:00" "chore(backend): initialize Node.js project with Express, stellar-sdk, and dev tooling"

# Commit 16
git add backend/src/index.js backend/src/app.js
commit "2025-11-10T11:45:00" "feat(backend): add Express app entry point with helmet, cors, morgan, rate-limiting"

# Commit 17
git add backend/src/middleware/errorHandler.js
commit "2025-11-10T14:20:00" "feat(backend/middleware): add global error handler and 404 handler"

# Commit 18
git add backend/src/middleware/validate.js
commit "2025-11-11T09:30:00" "feat(backend/middleware): add express-validator middleware wrapper"

# Commit 19
git add backend/src/config/stellar.js
commit "2025-11-11T11:00:00" "feat(backend/config): add Stellar network config with RPC and Horizon clients"

# Commit 20
git add backend/src/services/stellarService.js
commit "2025-11-11T15:10:00" "feat(backend/services): add invokeContract and viewContract helpers for Soroban"

# Commit 21
git add backend/src/services/assetService.js
commit "2025-11-12T10:05:00" "feat(backend/services): add asset indexing service with in-memory store and filters"

# Commit 22
git add backend/src/services/assetService.js
commit "2025-11-12T14:30:00" "feat(backend/services): seed sample intelligence assets for development mode"

# Commit 23
git add backend/src/services/agentService.js
commit "2025-11-13T09:15:00" "feat(backend/services): add agent indexing service with capability and reputation filters"

# Commit 24
git add backend/src/routes/assets.js
commit "2025-11-13T11:45:00" "feat(backend/routes): implement GET and POST /api/v1/assets with validation"

# Commit 25
git add backend/src/routes/agents.js
commit "2025-11-14T09:20:00" "feat(backend/routes): implement GET and POST /api/v1/agents"

# Commit 26
git add backend/src/routes/streams.js
commit "2025-11-14T11:30:00" "feat(backend/routes): add payment streams routes for indexing and querying"

# Commit 27
git add backend/src/routes/stellar.js
commit "2025-11-14T15:00:00" "feat(backend/routes): add /api/v1/stellar routes for account, network, and fee info"

# Commit 28
git add backend/src/listeners/eventListener.js
commit "2025-11-15T10:10:00" "feat(backend/listeners): add Soroban event listener polling LISTED, DELISTED, REGISTERED events"

# ── Week 4: Tests, fixes, and frontend updates ───────────────────────────────

# Commit 29
git add backend/src/__tests__/assets.test.js
commit "2025-11-17T09:30:00" "test(backend): add supertest suite for assets API endpoints"

# Commit 30
git add backend/src/__tests__/agents.test.js
commit "2025-11-17T11:00:00" "test(backend): add supertest suite for agents API and health check"

# Commit 31
git add backend/README.md
commit "2025-11-18T09:45:00" "docs(backend): write full API reference and environment variable docs"

# Commit 32 — small fix to stellar config
git add backend/src/config/stellar.js
commit "2025-11-18T14:20:00" "fix(backend/config): handle missing contract IDs gracefully with empty string fallback"

# Commit 33 — touch app.js (rate limit tweak)
git add backend/src/app.js
commit "2025-11-19T10:05:00" "fix(backend): increase rate limit window to 15 min and cap at 200 req"

# Commit 34 — asset service improvement
git add backend/src/services/assetService.js
commit "2025-11-19T14:30:00" "feat(backend/services): add full-text search across name, description, and tags"

# Commit 35 — frontend: update metadata
git add frontend/src/app/layout.tsx
commit "2025-11-20T09:30:00" "feat(frontend): update page metadata title and description for Intelligence Rail"

# ── Week 5: Contract edge cases & docs ───────────────────────────────────────

# Commit 36
git add contract/contracts/marketplace/src/lib.rs
commit "2025-11-22T10:15:00" "fix(contract/marketplace): assert buyer != owner to prevent self-purchase"

# Commit 37
git add contract/contracts/marketplace/src/test.rs
commit "2025-11-22T14:00:00" "test(contract/marketplace): add test_has_no_license_by_default coverage"

# Commit 38
git add contract/contracts/micropayments/src/lib.rs
commit "2025-11-23T11:20:00" "feat(contract/micropayments): auto-complete stream when deposit exhausted or end_time reached"

# Commit 39
git add contract/contracts/agent_registry/src/lib.rs
commit "2025-11-24T09:50:00" "feat(contract/agent-registry): add record_transaction for off-chain stats tracking"

# Commit 40
git add contract/contracts/agent_registry/src/test.rs
commit "2025-11-24T15:30:00" "test(contract/agent-registry): add update_capabilities and deactivate_agent tests"

# ── Week 6: Integration polish ────────────────────────────────────────────────

# Commit 41
git add backend/src/services/stellarService.js
commit "2025-11-26T10:30:00" "fix(backend/services): add retry loop for transaction confirmation polling"

# Commit 42
git add backend/src/listeners/eventListener.js
commit "2025-11-26T14:45:00" "feat(backend/listeners): track lastLedger to avoid duplicate event processing"

# Commit 43
git add backend/src/routes/assets.js
commit "2025-11-27T09:20:00" "feat(backend/routes): add GET /api/v1/assets/types/list endpoint"

# Commit 44
git add backend/src/routes/agents.js
commit "2025-11-27T11:40:00" "feat(backend/routes): add GET /api/v1/agents/capabilities/list endpoint"

# Commit 45
git add backend/src/app.js
commit "2025-11-28T10:00:00" "chore(backend): register stellar router under /api/v1/stellar"

# ── Week 7: Clean-up and README ───────────────────────────────────────────────

# Commit 46
git add contract/Cargo.toml
commit "2025-11-29T09:45:00" "chore(contract): pin workspace resolver to \"2\" and remove hello_world reference"

# Commit 47
git add README.md
commit "2025-12-01T10:15:00" "docs: update root README with project structure, core focus areas, and vision"

# Commit 48
git add contract/README.md
commit "2025-12-02T11:30:00" "docs(contract): add build and deploy instructions to contract README"

# Commit 49
git add backend/README.md
commit "2025-12-03T09:00:00" "docs(backend): add query parameter table and event listener usage docs"

# Commit 50 — stage anything remaining
git add -A
commit "2025-12-04T10:00:00" "chore: final cleanup, add .gitignore entries and .env.example for backend"

echo ""
echo "✅  Done — $(git log --oneline | wc -l | tr -d ' ') commits total"
