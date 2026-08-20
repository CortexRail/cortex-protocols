#!/usr/bin/env bash
# =============================================================================
# Cortex Protocol — Deploy Every Contract to the Local Network
# =============================================================================
# Builds all three contracts, deploys them in dependency order, initialises the
# ones that expose an initializer, and writes a single address file that both
# the backend and the simulation harness read.
#
# Dependency order:
#   1. agent_registry  — no dependencies
#   2. micropayments   — no dependencies; settles streams for the marketplace
#   3. marketplace     — references the other two at the application layer
#
# Usage:
#   bash deploy-all.sh [--network local] [--force]
#
# Environment:
#   LOCAL_RPC_PORT     Host port of the local network (default 8000)
#   DEPLOYER_SECRET    Secret key to deploy with; generated and funded if unset
#
# Outputs:
#   contract/deployed-addresses.local.json
#   backend/.env                              (contract ids synced in)
#
# Requires: stellar CLI, jq, curl
# =============================================================================

set -euo pipefail

NETWORK="${DEPLOY_NETWORK:-local}"
RPC_PORT="${LOCAL_RPC_PORT:-8000}"
RPC_URL="${SOROBAN_RPC_URL:-http://localhost:${RPC_PORT}/soroban/rpc}"
NETWORK_PASSPHRASE="${NETWORK_PASSPHRASE:-Standalone Network ; February 2017}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONTRACT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
# Soroban rejects WASM built with the reference-types proposal, which current
# Rust emits by default for wasm32-unknown-unknown. wasm32v1-none is the target
# that produces a loadable module, so prefer it whenever it is installed.
WASM_TARGET="wasm32-unknown-unknown"
if rustup target list --installed 2>/dev/null | grep -qx "wasm32v1-none"; then
  WASM_TARGET="wasm32v1-none"
fi
WASM_DIR="$CONTRACT_DIR/target/${WASM_TARGET}/release"
ADDRESSES_FILE="$CONTRACT_DIR/deployed-addresses.local.json"
BACKEND_ENV="$CONTRACT_DIR/../backend/.env"
FORCE_REDEPLOY="${FORCE_REDEPLOY:-false}"
MAX_RETRIES=5

# Deployment order matters: dependents come last.
CONTRACTS=(agent_registry micropayments marketplace)

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'; BOLD='\033[1m'; RESET='\033[0m'
log_info()  { echo -e "${CYAN}[INFO]${RESET}  $*"; }
log_ok()    { echo -e "${GREEN}[OK]${RESET}    $*"; }
log_warn()  { echo -e "${YELLOW}[WARN]${RESET}  $*"; }
log_error() { echo -e "${RED}[ERROR]${RESET} $*" >&2; }
log_step()  { echo -e "\n${BOLD}▶ $*${RESET}"; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --network) NETWORK="$2"; shift 2 ;;
    --force)   FORCE_REDEPLOY=true; shift ;;
    *) log_error "Unknown argument: $1"; exit 1 ;;
  esac
done

# ── Preflight ─────────────────────────────────────────────────────────────────

preflight() {
  log_step "Preflight checks"
  command -v stellar &>/dev/null || { log_error "stellar CLI not found"; exit 1; }
  command -v jq      &>/dev/null || { log_error "jq not found"; exit 1; }
  command -v curl    &>/dev/null || { log_error "curl not found"; exit 1; }

  if ! curl -s --max-time 5 "http://localhost:${RPC_PORT}/" >/dev/null; then
    log_error "local network is not reachable on port ${RPC_PORT}. Run start-local-network.sh first."
    exit 1
  fi

  stellar network add "$NETWORK" \
    --rpc-url "$RPC_URL" \
    --network-passphrase "$NETWORK_PASSPHRASE" &>/dev/null || true

  log_ok "network '$NETWORK' configured at $RPC_URL"
}

# ── Deployer identity ─────────────────────────────────────────────────────────

# Generates an identity without funding it, across CLI versions.
#   stellar  ~21: funds by default, so skipping it needs --no-fund
#   stellar >= 22: does not fund by default and dropped --no-fund entirely
keys_generate() {
  local name="$1"
  stellar keys generate --no-fund "$name" --network "$NETWORK" &>/dev/null && return 0
  stellar keys generate "$name" --network "$NETWORK" &>/dev/null && return 0
  stellar keys generate "$name" &>/dev/null
}

# Prints an identity's secret key, across CLI versions.
#   stellar >= 22: `keys secret`
#   stellar  ~21:  `keys show`
key_secret() {
  stellar keys secret "$1" 2>/dev/null || stellar keys show "$1" 2>/dev/null || true
}

ensure_deployer() {
  log_step "Preparing deployer identity"

  if [[ -n "${DEPLOYER_SECRET:-}" ]]; then
    log_ok "using DEPLOYER_SECRET from the environment"
    return 0
  fi

  if ! stellar keys address cortex-deployer &>/dev/null; then
    if ! keys_generate cortex-deployer; then
      log_error "could not generate the 'cortex-deployer' identity"
      exit 1
    fi
    log_info "generated identity 'cortex-deployer'"
  fi

  local address
  address=$(stellar keys address cortex-deployer)
  curl -s --max-time 30 "http://localhost:${RPC_PORT}/friendbot?addr=${address}" >/dev/null || true
  DEPLOYER_SECRET=$(key_secret cortex-deployer)

  if [[ -z "$DEPLOYER_SECRET" ]]; then
    log_error "could not read the deployer secret key"
    exit 1
  fi

  log_ok "deployer funded: $address"
}

# ── Build ─────────────────────────────────────────────────────────────────────

build_contracts() {
  log_step "Building contracts (${WASM_TARGET}, release)"
  cd "$CONTRACT_DIR"
  cargo build --target "$WASM_TARGET" --release --quiet
  log_ok "build complete"
}

# ── Deploy ────────────────────────────────────────────────────────────────────

deploy_with_retry() {
  local name="$1" wasm="$2"
  local attempt=0 output="" addr="" wait_secs=2

  while (( attempt < MAX_RETRIES )); do
    attempt=$(( attempt + 1 ))
    log_info "  attempt $attempt/$MAX_RETRIES deploying $name..." >&2
    if output=$(stellar contract deploy \
          --wasm "$wasm" \
          --network "$NETWORK" \
          --source "$DEPLOYER_SECRET" 2>&1); then
      addr=$(echo "$output" | grep -E '^C[A-Z0-9]{55}$' | head -1)
      if [[ -n "$addr" ]]; then
        echo "$addr"
        return 0
      fi
    fi
    # Print what actually went wrong; retrying blind on a build-level problem
    # just burns two minutes before failing with no explanation.
    log_warn "  attempt $attempt failed: $(echo "$output" | grep -aiE '^.?.?error|HostError' | head -2 | tr '\n' ' ')" >&2
    if (( attempt < MAX_RETRIES )); then
      log_warn "  retrying in ${wait_secs}s..." >&2
      sleep "$wait_secs"
      wait_secs=$(( wait_secs * 2 ))
    fi
  done

  log_error "all $MAX_RETRIES attempts failed for $name"
  log_error "last output: $output"
  return 1
}

deploy_contract() {
  local name="$1"
  local wasm="$WASM_DIR/${name}.wasm"

  [[ -f "$wasm" ]] || { log_error "WASM not found: $wasm"; return 1; }

  if [[ "$FORCE_REDEPLOY" != "true" && -f "$ADDRESSES_FILE" ]]; then
    local existing
    existing=$(jq -r --arg k "$name" '.contracts[$k].address // empty' "$ADDRESSES_FILE" 2>/dev/null || true)
    if [[ -n "$existing" ]] && stellar contract info interface --id "$existing" --network "$NETWORK" &>/dev/null; then
      log_ok "  $name already live at $existing (use --force to redeploy)" >&2
      echo "$existing"
      return 0
    fi
  fi

  deploy_with_retry "$name" "$wasm"
}

# ── Cross-contract wiring ─────────────────────────────────────────────────────
#
# Only the marketplace exposes an initializer today; agent_registry and
# micropayments take their counterpart addresses per-call rather than storing
# them, so "wiring" for those two means publishing the addresses through the
# file and backend/.env below rather than an on-chain call.

initialize_contracts() {
  local marketplace="$1"
  log_step "Initialising contracts"

  local owner
  owner=$(stellar keys address cortex-deployer 2>/dev/null || echo "")
  if [[ -z "$owner" ]]; then
    log_warn "  deployer address unavailable; skipping marketplace initialize"
    return 0
  fi

  if stellar contract invoke \
      --id "$marketplace" \
      --network "$NETWORK" \
      --source "$DEPLOYER_SECRET" \
      -- initialize --owner "$owner" &>/dev/null; then
    log_ok "  marketplace initialised with owner $owner"
  else
    # Re-running deploy-all against a live network is normal and must not fail.
    log_warn "  marketplace initialize failed or was already initialised (continuing)"
  fi
}

# ── Artifacts ─────────────────────────────────────────────────────────────────

write_addresses_json() {
  local registry="$1" micropayments="$2" marketplace="$3"
  local timestamp
  timestamp=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

  jq -n \
    --arg network "$NETWORK" \
    --arg passphrase "$NETWORK_PASSPHRASE" \
    --arg rpc "$RPC_URL" \
    --arg ts "$timestamp" \
    --arg ar "$registry" \
    --arg mc "$micropayments" \
    --arg mp "$marketplace" \
    '{
      network: $network,
      networkPassphrase: $passphrase,
      rpcUrl: $rpc,
      deployedAt: $ts,
      contracts: {
        agent_registry: { address: $ar, name: "AgentRegistryContract" },
        micropayments:  { address: $mc, name: "MicropaymentsContract" },
        marketplace:    { address: $mp, name: "MarketplaceContract" }
      }
    }' > "$ADDRESSES_FILE"

  log_ok "addresses written to $ADDRESSES_FILE"
}

sync_backend_env() {
  local registry="$1" micropayments="$2" marketplace="$3"

  if [[ ! -f "$BACKEND_ENV" ]]; then
    if [[ -f "${BACKEND_ENV}.example" ]]; then
      cp "${BACKEND_ENV}.example" "$BACKEND_ENV"
      log_info "created backend/.env from .env.example"
    else
      log_warn "backend/.env not found and no example to copy; skipping sync"
      return 0
    fi
  fi

  _set_env_var() {
    local key="$1" val="$2"
    if grep -q "^${key}=" "$BACKEND_ENV"; then
      sed -i.bak "s|^${key}=.*|${key}=${val}|" "$BACKEND_ENV" && rm -f "${BACKEND_ENV}.bak"
    else
      echo "${key}=${val}" >> "$BACKEND_ENV"
    fi
  }

  _set_env_var "AGENT_REGISTRY_CONTRACT_ID" "$registry"
  _set_env_var "MICROPAYMENTS_CONTRACT_ID"  "$micropayments"
  _set_env_var "MARKETPLACE_CONTRACT_ID"    "$marketplace"
  _set_env_var "SOROBAN_RPC_URL"            "$RPC_URL"
  _set_env_var "NETWORK_PASSPHRASE"         "$NETWORK_PASSPHRASE"

  log_ok "backend/.env synced"
}

# ── Main ──────────────────────────────────────────────────────────────────────

main() {
  echo -e "${BOLD}╔══════════════════════════════════════════════╗${RESET}"
  echo -e "${BOLD}║   Cortex Protocol — Deploy All Contracts    ║${RESET}"
  echo -e "${BOLD}╚══════════════════════════════════════════════╝${RESET}"

  preflight
  ensure_deployer
  build_contracts

  log_step "Deploying ${#CONTRACTS[@]} contracts in dependency order"
  AGENT_REGISTRY_ADDR=$(deploy_contract "agent_registry")
  log_ok "  agent_registry  → $AGENT_REGISTRY_ADDR"
  MICROPAYMENTS_ADDR=$(deploy_contract "micropayments")
  log_ok "  micropayments   → $MICROPAYMENTS_ADDR"
  MARKETPLACE_ADDR=$(deploy_contract "marketplace")
  log_ok "  marketplace     → $MARKETPLACE_ADDR"

  initialize_contracts "$MARKETPLACE_ADDR"

  log_step "Writing deployment artifacts"
  write_addresses_json "$AGENT_REGISTRY_ADDR" "$MICROPAYMENTS_ADDR" "$MARKETPLACE_ADDR"
  sync_backend_env     "$AGENT_REGISTRY_ADDR" "$MICROPAYMENTS_ADDR" "$MARKETPLACE_ADDR"

  echo ""
  echo -e "${GREEN}${BOLD}✔ All contracts deployed${RESET}"
  jq . "$ADDRESSES_FILE"
  echo ""
}

main
