#!/usr/bin/env bash
# =============================================================================
# Cortex Protocol — Contract Upgrade Script
# =============================================================================
# Uploads freshly built WASM and invokes the contract's `upgrade` function,
# swapping the code in place while preserving all storage and the contract
# address. The target address is read from deployed_addresses.json (written
# by deploy.sh).
#
# Usage:
#   STELLAR_SECRET_KEY=S... bash upgrade.sh [contract-name]
#
#   contract-name  defaults to "marketplace" (currently the only contract
#                  exposing an `upgrade` function).
#
# Requires: stellar CLI, jq. The signing key must be the contract owner.
# =============================================================================

set -euo pipefail

NETWORK="${STELLAR_NETWORK:-testnet}"
WASM_DIR="target/wasm32-unknown-unknown/release"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONTRACT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
ADDRESSES_FILE="$CONTRACT_DIR/deployed_addresses.json"

CONTRACT_NAME="${1:-marketplace}"

RED='\033[0;31m'
GREEN='\033[0;32m'
CYAN='\033[0;36m'
BOLD='\033[1m'
RESET='\033[0m'

log_info()  { echo -e "${CYAN}[INFO]${RESET}  $*"; }
log_ok()    { echo -e "${GREEN}[OK]${RESET}    $*"; }
log_error() { echo -e "${RED}[ERROR]${RESET} $*" >&2; }
log_step()  { echo -e "\n${BOLD}▶ $*${RESET}"; }

# ── Preflight ─────────────────────────────────────────────────────────────────

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
if [[ ! -f "$ADDRESSES_FILE" ]]; then
  log_error "No $ADDRESSES_FILE — run deploy.sh first."
  exit 1
fi

CONTRACT_ADDR=$(jq -r --arg k "$CONTRACT_NAME" '.contracts[$k].address // empty' "$ADDRESSES_FILE")
if [[ -z "$CONTRACT_ADDR" ]]; then
  log_error "No deployed address for '$CONTRACT_NAME' in $ADDRESSES_FILE"
  exit 1
fi
log_ok "Upgrading $CONTRACT_NAME at $CONTRACT_ADDR (network=$NETWORK)"

# ── Build ─────────────────────────────────────────────────────────────────────

log_step "Building contracts (wasm32)"
cd "$CONTRACT_DIR"
cargo build --target wasm32-unknown-unknown --release --quiet

WASM_NAME="${CONTRACT_NAME//-/_}"
WASM="$WASM_DIR/${WASM_NAME}.wasm"
if [[ ! -f "$WASM" ]]; then
  log_error "WASM not found: $WASM"
  exit 1
fi
log_ok "Build complete"

# ── Upload new WASM ───────────────────────────────────────────────────────────

log_step "Uploading new WASM"
WASM_HASH=$(stellar contract upload \
  --wasm "$WASM" \
  --network "$NETWORK" \
  --source "$STELLAR_SECRET_KEY" \
  | grep -E '^[a-f0-9]{64}$' | head -1)

if [[ -z "$WASM_HASH" ]]; then
  log_error "Upload did not return a WASM hash"
  exit 1
fi
log_ok "New WASM hash: $WASM_HASH"

# ── Invoke upgrade ────────────────────────────────────────────────────────────

log_step "Invoking upgrade on $CONTRACT_NAME"
stellar contract invoke \
  --id "$CONTRACT_ADDR" \
  --network "$NETWORK" \
  --source "$STELLAR_SECRET_KEY" \
  -- upgrade \
  --new_wasm_hash "$WASM_HASH"

log_ok "Upgrade complete"

VERSION=$(stellar contract invoke \
  --id "$CONTRACT_ADDR" \
  --network "$NETWORK" \
  --source "$STELLAR_SECRET_KEY" \
  -- version 2>/dev/null || true)

echo ""
echo -e "${GREEN}${BOLD}✔ $CONTRACT_NAME upgraded!${RESET}"
echo -e "  Address:   ${CYAN}${CONTRACT_ADDR}${RESET}"
echo -e "  WASM hash: ${CYAN}${WASM_HASH}${RESET}"
[[ -n "$VERSION" ]] && echo -e "  Version:   ${CYAN}${VERSION}${RESET}"
