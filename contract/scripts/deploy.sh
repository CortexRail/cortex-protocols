#!/usr/bin/env bash
# =============================================================================
# Cortex Protocol — Contract Deployment Script
# =============================================================================
# Usage:
#   STELLAR_SECRET_KEY=S... bash deploy.sh [--network testnet|mainnet] [--force]
#
# Outputs:
#   contract/deployed_addresses.json  — structured JSON with contract addresses
#   contract/.stellar/                — keypair files (gitignored)
#
# Requires: stellar CLI, jq
# =============================================================================

set -euo pipefail

# ── Configuration ─────────────────────────────────────────────────────────────

NETWORK="${STELLAR_NETWORK:-testnet}"
WASM_DIR="target/wasm32-unknown-unknown/release"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONTRACT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
ADDRESSES_FILE="$CONTRACT_DIR/deployed_addresses.json"
STELLAR_DIR="$CONTRACT_DIR/.stellar"
FORCE_REDEPLOY="${FORCE_REDEPLOY:-false}"
MAX_RETRIES=5

# ── Colours ───────────────────────────────────────────────────────────────────

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
RESET='\033[0m'

log_info()    { echo -e "${CYAN}[INFO]${RESET}  $*"; }
log_ok()      { echo -e "${GREEN}[OK]${RESET}    $*"; }
log_warn()    { echo -e "${YELLOW}[WARN]${RESET}  $*"; }
log_error()   { echo -e "${RED}[ERROR]${RESET} $*" >&2; }
log_step()    { echo -e "\n${BOLD}▶ $*${RESET}"; }

# ── Preflight Checks ──────────────────────────────────────────────────────────

preflight() {
  log_step "Preflight checks"

  if ! command -v stellar &>/dev/null; then
    log_error "stellar CLI not found. Install: https://developers.stellar.org/docs/tools/developer-tools/cli/install-cli"
    exit 1
  fi
  if ! command -v jq &>/dev/null; then
    log_error "jq not found. Install: https://stedolan.github.io/jq/download/"
    exit 1
  fi
  if [[ -z "${STELLAR_SECRET_KEY:-}" ]]; then
    log_error "STELLAR_SECRET_KEY environment variable is not set."
    exit 1
  fi

  mkdir -p "$STELLAR_DIR"
  log_ok "All preflight checks passed (network=$NETWORK)"
}

# ── Build Contracts ───────────────────────────────────────────────────────────

build_contracts() {
  log_step "Building contracts (wasm32)"
  cd "$CONTRACT_DIR"
  cargo build --target wasm32-unknown-unknown --release --quiet
  log_ok "Build complete"
}

# ── Deploy with Retry ─────────────────────────────────────────────────────────

deploy_with_retry() {
  local name="$1"
  local wasm="$2"
  local attempt=0
  local addr=""
  local wait_secs=2

  while [[ $attempt -lt $MAX_RETRIES ]]; do
    attempt=$((attempt + 1))
    log_info "  Attempt $attempt/$MAX_RETRIES deploying $name..."
    if addr=$(stellar contract deploy \
          --wasm "$wasm" \
          --network "$NETWORK" \
          --source "$STELLAR_SECRET_KEY" \
          2>&1); then
      # stellar CLI writes the address to stdout; strip any extra lines
      addr=$(echo "$addr" | grep -E '^[A-Z0-9]{56}$' | head -1)
      if [[ -n "$addr" ]]; then
        echo "$addr"
        return 0
      fi
    fi
    log_warn "  Attempt $attempt failed. Retrying in ${wait_secs}s..."
    sleep "$wait_secs"
    wait_secs=$((wait_secs * 2))
  done

  log_error "All $MAX_RETRIES attempts failed for $name"
  return 1
}

# ── Check Existing Deployment ─────────────────────────────────────────────────

get_existing_address() {
  local name="$1"
  if [[ -f "$ADDRESSES_FILE" ]]; then
    local addr
    addr=$(jq -r --arg k "$name" '.contracts[$k].address // empty' "$ADDRESSES_FILE" 2>/dev/null || true)
    echo "$addr"
  fi
}

contract_exists_on_chain() {
  local addr="$1"
  stellar contract info \
    --id "$addr" \
    --network "$NETWORK" \
    &>/dev/null 2>&1
}

# ── Deploy Single Contract ────────────────────────────────────────────────────

deploy_contract() {
  local name="$1"
  local wasm_name="${name//-/_}"
  local wasm="$WASM_DIR/${wasm_name}.wasm"

  if [[ ! -f "$wasm" ]]; then
    log_error "WASM not found: $wasm"
    return 1
  fi

  # Check if already deployed
  if [[ "$FORCE_REDEPLOY" != "true" ]]; then
    local existing
    existing=$(get_existing_address "$name")
    if [[ -n "$existing" ]]; then
      if contract_exists_on_chain "$existing"; then
        log_ok "  $name already deployed at $existing (skipping — use FORCE_REDEPLOY=true to redeploy)"
        echo "$existing"
        return 0
      else
        log_warn "  $name address $existing not found on-chain, redeploying..."
      fi
    fi
  fi

  log_info "  Deploying $name from $wasm..."
  local addr
  addr=$(deploy_with_retry "$name" "$wasm")
  log_ok "  $name → $addr"
  echo "$addr"
}

# ── Write deployed_addresses.json ─────────────────────────────────────────────

write_addresses_json() {
  local marketplace="$1"
  local micropayments="$2"
  local agent_registry="$3"
  local timestamp
  timestamp=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

  jq -n \
    --arg network "$NETWORK" \
    --arg ts "$timestamp" \
    --arg mp "$marketplace" \
    --arg mc "$micropayments" \
    --arg ar "$agent_registry" \
    '{
      "network": $network,
      "deployed_at": $ts,
      "contracts": {
        "marketplace": {
          "address": $mp,
          "name": "MarketplaceContract"
        },
        "micropayments": {
          "address": $mc,
          "name": "MicropaymentsContract"
        },
        "agent_registry": {
          "address": $ar,
          "name": "AgentRegistryContract"
        }
      }
    }' > "$ADDRESSES_FILE"

  log_ok "Addresses written to $ADDRESSES_FILE"
}

# ── Sync addresses to backend .env ───────────────────────────────────────────

sync_to_backend_env() {
  local marketplace="$1"
  local micropayments="$2"
  local agent_registry="$3"

  local backend_env="$CONTRACT_DIR/../backend/.env"

  if [[ ! -f "$backend_env" ]]; then
    if [[ -f "$CONTRACT_DIR/../backend/.env.example" ]]; then
      cp "$CONTRACT_DIR/../backend/.env.example" "$backend_env"
      log_info "Created backend/.env from .env.example"
    else
      log_warn "backend/.env not found, skipping sync"
      return 0
    fi
  fi

  # Update or append each contract ID
  _set_env_var() {
    local key="$1"
    local val="$2"
    if grep -q "^${key}=" "$backend_env"; then
      sed -i.bak "s|^${key}=.*|${key}=${val}|" "$backend_env" && rm -f "${backend_env}.bak"
    else
      echo "${key}=${val}" >> "$backend_env"
    fi
  }

  _set_env_var "MARKETPLACE_CONTRACT_ID"    "$marketplace"
  _set_env_var "MICROPAYMENTS_CONTRACT_ID"  "$micropayments"
  _set_env_var "AGENT_REGISTRY_CONTRACT_ID" "$agent_registry"

  log_ok "backend/.env updated with contract addresses"
}

# ── Main ──────────────────────────────────────────────────────────────────────

main() {
  echo -e "${BOLD}╔══════════════════════════════════════════════╗${RESET}"
  echo -e "${BOLD}║   Cortex Protocol — Deployment Script        ║${RESET}"
  echo -e "${BOLD}╚══════════════════════════════════════════════╝${RESET}"

  preflight
  build_contracts

  log_step "Deploying contracts to $NETWORK"

  MARKETPLACE_ADDR=$(deploy_contract "marketplace")
  MICROPAYMENTS_ADDR=$(deploy_contract "micropayments")
  AGENT_REGISTRY_ADDR=$(deploy_contract "agent_registry")

  log_step "Writing deployment artifacts"
  write_addresses_json "$MARKETPLACE_ADDR" "$MICROPAYMENTS_ADDR" "$AGENT_REGISTRY_ADDR"
  sync_to_backend_env  "$MARKETPLACE_ADDR" "$MICROPAYMENTS_ADDR" "$AGENT_REGISTRY_ADDR"

  echo ""
  echo -e "${GREEN}${BOLD}✔ Deployment complete!${RESET}"
  echo -e "  Marketplace:    ${CYAN}${MARKETPLACE_ADDR}${RESET}"
  echo -e "  Micropayments:  ${CYAN}${MICROPAYMENTS_ADDR}${RESET}"
  echo -e "  Agent Registry: ${CYAN}${AGENT_REGISTRY_ADDR}${RESET}"
  echo ""
  cat "$ADDRESSES_FILE"
}

main "$@"
