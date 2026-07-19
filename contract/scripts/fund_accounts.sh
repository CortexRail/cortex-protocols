#!/usr/bin/env bash
# =============================================================================
# Cortex Protocol — Fund Accounts via Friendbot
# =============================================================================
# Creates and funds deployer + test buyer accounts on Stellar testnet.
# Saves keypairs to contract/.stellar/ (gitignored).
#
# Usage:
#   bash fund_accounts.sh [--accounts deployer,buyer1,buyer2]
#
# Outputs:
#   .stellar/deployer.json
#   .stellar/buyer1.json
#   .stellar/buyer2.json
# =============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONTRACT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
STELLAR_DIR="$CONTRACT_DIR/.stellar"
NETWORK="${STELLAR_NETWORK:-testnet}"
FRIENDBOT_URL="https://friendbot.stellar.org"
HORIZON_URL="${STELLAR_HORIZON_URL:-https://horizon-testnet.stellar.org}"

# Colours
GREEN='\033[0;32m'
CYAN='\033[0;36m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
BOLD='\033[1m'
RESET='\033[0m'

log_info()  { echo -e "${CYAN}[INFO]${RESET}  $*"; }
log_ok()    { echo -e "${GREEN}[OK]${RESET}    $*"; }
log_warn()  { echo -e "${YELLOW}[WARN]${RESET}  $*"; }
log_error() { echo -e "${RED}[ERROR]${RESET} $*" >&2; }

# Accounts to fund (can be overridden via ACCOUNTS env var)
ACCOUNTS="${ACCOUNTS:-deployer buyer1 buyer2}"

# ── Preflight ─────────────────────────────────────────────────────────────────

preflight() {
  if ! command -v stellar &>/dev/null; then
    log_error "stellar CLI not found."
    exit 1
  fi
  if ! command -v curl &>/dev/null; then
    log_error "curl not found."
    exit 1
  fi
  if ! command -v jq &>/dev/null; then
    log_error "jq not found."
    exit 1
  fi
  mkdir -p "$STELLAR_DIR"
  # Ensure .stellar directory is gitignored
  local gitignore="$CONTRACT_DIR/.gitignore"
  if [[ -f "$gitignore" ]] && ! grep -q "^\.stellar" "$gitignore"; then
    echo ".stellar/" >> "$gitignore"
    log_info "Added .stellar/ to .gitignore"
  fi
}

# ── Generate Keypair ──────────────────────────────────────────────────────────

generate_keypair() {
  local account_name="$1"
  local keypair_file="$STELLAR_DIR/${account_name}.json"

  if [[ -f "$keypair_file" ]]; then
    log_warn "Keypair for '$account_name' already exists at $keypair_file — skipping generation"
    cat "$keypair_file"
    return 0
  fi

  log_info "Generating keypair for '$account_name'..."
  # stellar keys generate outputs JSON with publicKey and secretKey
  local output
  output=$(stellar keys generate --no-fund 2>/dev/null || true)

  # Fallback: use Python to generate a random Ed25519 keypair via stellar-base logic
  # We derive via `stellar keys generate` and parse:
  local secret_key
  local public_key
  secret_key=$(stellar keys generate --no-fund --format secret 2>/dev/null || \
    python3 -c "
import os, base64
seed = os.urandom(32)
# Use stellar CLI generate to avoid Python dep on stellar-base
print('PENDING')
" 2>/dev/null || true)

  # Most reliable: use stellar keys subcommand
  if stellar keys generate "${account_name}" --network "$NETWORK" &>/dev/null 2>&1; then
    public_key=$(stellar keys address "${account_name}" 2>/dev/null)
    secret_key=$(stellar keys show "${account_name}" 2>/dev/null || echo "LOCKED")
  else
    # Inline keypair generation via stellar CLI one-shot
    local raw
    raw=$(stellar keys generate --network "$NETWORK" 2>/dev/null | head -1 || echo "")
    public_key=$(echo "$raw" | jq -r '.publicKey // empty' 2>/dev/null || echo "")
    secret_key=$(echo "$raw" | jq -r '.secretKey // empty' 2>/dev/null || echo "")
  fi

  if [[ -z "$public_key" ]]; then
    log_error "Failed to generate keypair for $account_name"
    return 1
  fi

  jq -n \
    --arg name "$account_name" \
    --arg pk "$public_key" \
    --arg sk "$secret_key" \
    --arg net "$NETWORK" \
    '{
      "account": $name,
      "network": $net,
      "public_key": $pk,
      "secret_key": $sk
    }' > "$keypair_file"

  chmod 600 "$keypair_file"
  log_ok "Keypair saved to $keypair_file (chmod 600)"
  echo "$public_key"
}

# ── Fund via Friendbot ────────────────────────────────────────────────────────

fund_via_friendbot() {
  local public_key="$1"
  local account_name="$2"

  log_info "Funding '$account_name' ($public_key) via Friendbot..."

  local response
  response=$(curl -sf "${FRIENDBOT_URL}?addr=${public_key}" 2>&1) || {
    log_warn "Friendbot request failed for $account_name — may already be funded"
    return 0
  }

  local result_type
  result_type=$(echo "$response" | jq -r '.type // empty' 2>/dev/null || echo "")

  if echo "$response" | jq -e '.hash' &>/dev/null; then
    local tx_hash
    tx_hash=$(echo "$response" | jq -r '.hash')
    log_ok "Funded '$account_name' — tx: $tx_hash"
  else
    log_warn "Friendbot response for '$account_name': $response"
  fi
}

# ── Verify Balance ────────────────────────────────────────────────────────────

check_balance() {
  local public_key="$1"
  local account_name="$2"

  local response
  response=$(curl -sf "${HORIZON_URL}/accounts/${public_key}" 2>/dev/null || echo "{}")

  local balance
  balance=$(echo "$response" | jq -r '[.balances[]? | select(.asset_type=="native") | .balance][0] // "0"' 2>/dev/null || echo "0")

  log_ok "'$account_name' balance: ${balance} XLM"
}

# ── Process All Accounts ──────────────────────────────────────────────────────

process_account() {
  local name="$1"
  local keypair_file="$STELLAR_DIR/${name}.json"

  echo ""
  echo -e "${BOLD}── Account: $name ──────────────────────────${RESET}"

  local public_key=""

  # If keypair file exists, read from it
  if [[ -f "$keypair_file" ]]; then
    public_key=$(jq -r '.public_key' "$keypair_file" 2>/dev/null || echo "")
    log_info "Loaded existing keypair for '$name': $public_key"
  fi

  # Generate if not found
  if [[ -z "$public_key" ]]; then
    public_key=$(generate_keypair "$name" || echo "")
  fi

  if [[ -z "$public_key" ]]; then
    log_error "Could not obtain public key for '$name'"
    return 1
  fi

  fund_via_friendbot "$public_key" "$name"
  sleep 3
  check_balance "$public_key" "$name"
}

# ── Export deployer key to STELLAR_SECRET_KEY ─────────────────────────────────

export_deployer_key() {
  local deployer_file="$STELLAR_DIR/deployer.json"
  if [[ -f "$deployer_file" ]]; then
    local sk
    sk=$(jq -r '.secret_key' "$deployer_file" 2>/dev/null || echo "")
    if [[ -n "$sk" && "$sk" != "LOCKED" ]]; then
      echo ""
      echo -e "${BOLD}Export for use in deploy.sh:${RESET}"
      echo -e "  ${CYAN}export STELLAR_SECRET_KEY=${sk}${RESET}"
      # Write a sourceable env file
      echo "export STELLAR_SECRET_KEY=${sk}" > "$STELLAR_DIR/deployer.env"
      log_ok "Deployer env written to $STELLAR_DIR/deployer.env"
    fi
  fi
}

# ── Summary ───────────────────────────────────────────────────────────────────

print_summary() {
  echo ""
  echo -e "${GREEN}${BOLD}╔══════════════════════════════════════════════╗${RESET}"
  echo -e "${GREEN}${BOLD}║   Account Funding Complete                   ║${RESET}"
  echo -e "${GREEN}${BOLD}╚══════════════════════════════════════════════╝${RESET}"
  echo ""
  echo "Keypairs saved to: $STELLAR_DIR"
  echo ""
  for name in $ACCOUNTS; do
    local f="$STELLAR_DIR/${name}.json"
    if [[ -f "$f" ]]; then
      local pk
      pk=$(jq -r '.public_key' "$f" 2>/dev/null || echo "unknown")
      echo -e "  ${BOLD}$name${RESET}: ${CYAN}$pk${RESET}"
    fi
  done
}

# ── Main ──────────────────────────────────────────────────────────────────────

main() {
  echo -e "${BOLD}╔══════════════════════════════════════════════╗${RESET}"
  echo -e "${BOLD}║   Cortex Protocol — Fund Accounts            ║${RESET}"
  echo -e "${BOLD}╚══════════════════════════════════════════════╝${RESET}"

  preflight

  for account in $ACCOUNTS; do
    process_account "$account"
  done

  export_deployer_key
  print_summary
}

main "$@"
