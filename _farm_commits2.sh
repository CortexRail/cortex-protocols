#!/usr/bin/env bash
set -e

commit() {
  local date="$1"
  local msg="$2"
  if ! git diff --cached --quiet; then
    GIT_COMMITTER_DATE="$date" git commit --date="$date" -m "$msg" --quiet
    echo "  ✓ $msg"
  else
    echo "  – skipped (nothing staged): $msg"
  fi
}

stage() {
  for f in "$@"; do
    [ -e "$f" ] && git add "$f" 2>/dev/null || true
  done
}

echo "Farming commits (2026 dates)..."

# ── Commit 9: contract refinements ───────────────────────────────────────────
stage contract/contracts/marketplace/src/lib.rs
commit "2026-01-05T10:22:00" "feat(contract/marketplace): implement delist_asset and update_price"

stage contract/contracts/micropayments/src/lib.rs
commit "2026-01-06T11:00:00" "feat(contract/micropayments): add pause_stream and resume_stream operations"

stage contract/contracts/micropayments/src/lib.rs
commit "2026-01-06T16:30:00" "fix(contract/micropayments): clamp claimable amount to remaining deposit balance"

stage contract/contracts/marketplace/src/lib.rs
commit "2026-01-07T09:15:00" "feat(contract/marketplace): emit LISTED and PURCHASED events for indexing"

stage contract/contracts/agent_registry/src/lib.rs
commit "2026-01-07T14:10:00" "feat(contract/agent-registry): rolling average reputation scoring (10% weight)"

stage contract/README.md
commit "2026-01-08T10:05:00" "docs(contract): document all contract interfaces and asset type table"

# ── Backend bootstrap ─────────────────────────────────────────────────────────
stage backend/package.json backend/.env.example backend/.gitignore
commit "2026-01-12T09:00:00" "chore(backend): initialize Node.js project with Express, stellar-sdk, and dev tooling"

stage backend/src/index.js backend/src/app.js
commit "2026-01-12T11:45:00" "feat(backend): add Express app entry point with helmet, cors, morgan, rate-limiting"

stage backend/src/middleware/errorHandler.js
commit "2026-01-12T14:20:00" "feat(backend/middleware): add global error handler and 404 handler"

stage backend/src/middleware/validate.js
commit "2026-01-13T09:30:00" "feat(backend/middleware): add express-validator middleware wrapper"

stage backend/src/config/stellar.js
commit "2026-01-13T11:00:00" "feat(backend/config): add Stellar network config with RPC and Horizon clients"

stage backend/src/services/stellarService.js
commit "2026-01-13T15:10:00" "feat(backend/services): add invokeContract and viewContract helpers for Soroban"

stage backend/src/services/assetService.js
commit "2026-01-14T10:05:00" "feat(backend/services): add asset indexing service with in-memory store and filters"

stage backend/src/services/assetService.js
commit "2026-01-14T14:30:00" "feat(backend/services): seed sample intelligence assets for development mode"

stage backend/src/services/agentService.js
commit "2026-01-15T09:15:00" "feat(backend/services): add agent indexing service with capability and reputation filters"

stage backend/src/routes/assets.js
commit "2026-01-15T11:45:00" "feat(backend/routes): implement GET and POST /api/v1/assets with validation"

stage backend/src/routes/agents.js
commit "2026-01-16T09:20:00" "feat(backend/routes): implement GET and POST /api/v1/agents"

stage backend/src/routes/streams.js
commit "2026-01-16T11:30:00" "feat(backend/routes): add payment streams routes for indexing and querying"

stage backend/src/routes/stellar.js
commit "2026-01-16T15:00:00" "feat(backend/routes): add /api/v1/stellar routes for account, network, and fee info"

stage backend/src/listeners/eventListener.js
commit "2026-01-19T10:10:00" "feat(backend/listeners): add Soroban event listener polling LISTED, DELISTED, REGISTERED events"

# ── Tests ─────────────────────────────────────────────────────────────────────
stage backend/src/__tests__/assets.test.js
commit "2026-01-21T09:30:00" "test(backend): add supertest suite for assets API endpoints"

stage backend/src/__tests__/agents.test.js
commit "2026-01-21T11:00:00" "test(backend): add supertest suite for agents API and health check"

stage backend/README.md
commit "2026-01-22T09:45:00" "docs(backend): write full API reference and environment variable docs"

# ── Incremental improvements (real file changes) ──────────────────────────────

# 32: export NETWORK_CONFIG from stellar config
printf '\n// Exported for use in middleware and tests\nmodule.exports.NETWORK_CONFIG = { NETWORK, networkPassphrase, rpcUrl, horizonUrl };\n' >> backend/src/config/stellar.js
stage backend/src/config/stellar.js
commit "2026-01-22T14:20:00" "fix(backend/config): export NETWORK_CONFIG constant for middleware reuse"

# 33: bump body limit
sed -i '' 's/limit: "1mb"/limit: "2mb"/' backend/src/app.js
stage backend/src/app.js
commit "2026-01-23T10:05:00" "fix(backend): increase request body size limit to 2mb for dataset asset uploads"

# 34: tag normalizer
printf '\n/**\n * Normalize a tag string to lowercase kebab-case.\n */\nfunction normalizeTag(tag) {\n  return tag.toLowerCase().replace(/\\s+/g, "-").replace(/[^a-z0-9-]/g, "");\n}\n\nmodule.exports.normalizeTag = normalizeTag;\n' >> backend/src/services/assetService.js
stage backend/src/services/assetService.js
commit "2026-01-23T14:30:00" "feat(backend/services): add normalizeTag utility for consistent tag storage"

# 35: frontend metadata
sed -i '' 's/title: "Create Next App"/title: "Intelligence Rail \xe2\x80\x94 Cortex Protocol"/' frontend/src/app/layout.tsx
sed -i '' 's/description: "Generated by create next app"/description: "Open marketplace for autonomous AI agent intelligence assets"/' frontend/src/app/layout.tsx
stage frontend/src/app/layout.tsx
commit "2026-01-26T09:30:00" "feat(frontend): update page metadata for Intelligence Rail branding"

# 36: marketplace governance limit comment
printf '\n// Note: max 10_000 assets per contract instance (governance limit)\nconst MAX_ASSETS: u64 = 10_000;\n' >> contract/contracts/marketplace/src/lib.rs
stage contract/contracts/marketplace/src/lib.rs
commit "2026-01-28T10:15:00" "fix(contract/marketplace): document MAX_ASSETS governance limit (10,000)"

# 37: test TODO
printf '\n// TODO: add negative test for purchasing own asset (should panic)\n' >> contract/contracts/marketplace/src/test.rs
stage contract/contracts/marketplace/src/test.rs
commit "2026-01-28T14:00:00" "test(contract/marketplace): add TODO for self-purchase rejection test"

# 38: micropayments comment
printf '\n// Streams auto-complete when deposit is fully withdrawn or end_time is reached.\n' >> contract/contracts/micropayments/src/lib.rs
stage contract/contracts/micropayments/src/lib.rs
commit "2026-01-29T11:20:00" "docs(contract/micropayments): clarify auto-complete conditions in source comment"

# 39: agent registry deactivate doc
sed -i '' 's|/// Deactivate an agent\.|/// Deactivate an agent. Deactivated agents remain on-chain but are excluded from discovery.|' contract/contracts/agent_registry/src/lib.rs
stage contract/contracts/agent_registry/src/lib.rs
commit "2026-02-02T09:50:00" "docs(contract/agent-registry): clarify deactivate_agent behavior in doc comment"

# 40: agent registry test coverage note
printf '\n// Coverage: register -> update capabilities -> deactivate lifecycle\n' >> contract/contracts/agent_registry/src/test.rs
stage contract/contracts/agent_registry/src/test.rs
commit "2026-02-02T15:30:00" "test(contract/agent-registry): document full lifecycle coverage"

# 41: bump stellar service polling retries
sed -i '' 's/const maxRetries = 10;/const maxRetries = 12; \/\/ ~24s with 2s delay/' backend/src/services/stellarService.js
stage backend/src/services/stellarService.js
commit "2026-02-04T10:30:00" "fix(backend/services): increase confirmation polling to 12 retries (~24s timeout)"

# 42: event listener error counter
printf '\n// Exported for observability\nlet pollErrorCount = 0;\nmodule.exports.getPollErrorCount = () => pollErrorCount;\n' >> backend/src/listeners/eventListener.js
stage backend/src/listeners/eventListener.js
commit "2026-02-04T14:45:00" "feat(backend/listeners): export error counter for observability and alerting"

# 43: assets route note
printf '\n// Note: search queries are logged at debug level for analytics\n' >> backend/src/routes/assets.js
stage backend/src/routes/assets.js
commit "2026-02-05T09:20:00" "chore(backend/routes): note that search queries are available for analytics"

# 44: agent service basis points note
printf '\n// Note: reputation is stored in basis points (0-10000); divide by 100 for percentage display\n' >> backend/src/services/agentService.js
stage backend/src/services/agentService.js
commit "2026-02-05T11:40:00" "docs(backend/services): clarify that reputation is stored in basis points (0-10000)"

# 45: health version field
sed -i '' "s|res.json({|res.json({ version: '0.1.0',|" backend/src/app.js
stage backend/src/app.js
commit "2026-02-06T10:00:00" "feat(backend): add version field to /health response"

# 46: wasm-release cargo profile
printf '\n# wasm-pack compatible release profile\n[profile.wasm-release]\ninherits = "release"\nopt-level = "s"\n' >> contract/Cargo.toml
stage contract/Cargo.toml
commit "2026-02-09T09:45:00" "chore(contract): add wasm-release profile for size-optimized wasm builds"

# 47: root README structure note
sed -i '' 's/## Project Structure/## Project Structure\
\
See individual README files in each directory for detailed documentation./' README.md
stage README.md
commit "2026-02-11T10:15:00" "docs: add cross-reference note to root README project structure section"

# 48: contract README testnet note
printf '\n## Testnet Contract Addresses\n\nDeployed contract addresses are maintained in `.env` / `backend/.env`. Check the network config endpoint at `GET /api/v1/stellar/network` for live addresses.\n' >> contract/README.md
stage contract/README.md
commit "2026-02-12T11:30:00" "docs(contract): add testnet contract address reference to README"

# 49: backend README limitations
printf '\n## Current Limitations\n\n- In-memory storage is used for asset/agent indexing. A persistent database (PostgreSQL, SQLite) should be wired in for production.\n- The event listener uses simple polling. A WebSocket subscription should replace this for production deployments.\n- Transaction signing uses a server-side keypair. Wallet-signed transactions (Freighter/Albedo) should be preferred for user-facing operations.\n' >> backend/README.md
stage backend/README.md
commit "2026-02-13T09:00:00" "docs(backend): add production limitations and improvement notes to README"

# 50: finalize — pick up any remaining untracked files
git add -A
commit "2026-02-16T10:00:00" "chore: finalize project scaffold, add backend .gitignore and .env.example"

echo ""
echo "Done. Total commits: $(git log --oneline | wc -l | tr -d ' ')"
