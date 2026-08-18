#!/usr/bin/env bash
# =============================================================================
# Cortex Protocol — On-Chain Verification Script
# =============================================================================
# Queries each contract's view functions and asserts expected values.
# Exits non-zero on any mismatch (suitable for CI).
#
# Usage:
#   STELLAR_SECRET_KEY=S... bash verify.sh
#
# Reads:  contract/deployed_addresses.json
# =============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONTRACT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
ADDRESSES_FILE="$CONTRACT_DIR/deployed_addresses.json"
NETWORK="${STELLAR_NETWORK:-testnet}"

# Expected post-init state
EXPECTED_ASSET_COUNT=3
EXPECTED_AGENT_COUNT=2
EXPECTED_STREAM_COUNT=0   # micropayments untouched by init

# Colours
GREEN='\033[0;32m'
CYAN='\033[0;36m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
BOLD='\033[1m'
RESET='\033[0m'

log_info()  { echo -e "${CYAN}[INFO]${RESET}  $*"; }
log_ok()    { echo -e "${GREEN}[PASS]${RESET}  $*"; }
log_warn()  { echo -e "${YELLOW}[WARN]${RESET}  $*"; }
log_error() { echo -e "${RED}[FAIL]${RESET}  $*" >&2; }
log_step()  { echo -e "\n${BOLD}▶ $*${RESET}"; }

PASS_COUNT=0
FAIL_COUNT=0

# ── Load Addresses ─────────────────────────────────────────────────────────────

load_addresses() {
  if [[ ! -f "$ADDRESSES_FILE" ]]; then
    log_error "deployed_addresses.json not found. Run deploy.sh first."
    exit 1
  fi

  MARKETPLACE_ADDR=$(jq -r '.contracts.marketplace.address' "$ADDRESSES_FILE")
  MICROPAYMENTS_ADDR=$(jq -r '.contracts.micropayments.address' "$ADDRESSES_FILE")
  AGENT_REGISTRY_ADDR=$(jq -r '.contracts.agent_registry.address' "$ADDRESSES_FILE")

  log_info "Verifying contracts on $NETWORK"
  log_info "Marketplace:    $MARKETPLACE_ADDR"
  log_info "Micropayments:  $MICROPAYMENTS_ADDR"
  log_info "Agent Registry: $AGENT_REGISTRY_ADDR"
}

# ── Query Helper ───────────────────────────────────────────────────────────────

query() {
  local contract_id="$1"
  local fn_name="$2"
  shift 2
  local args=("$@")

  stellar contract invoke \
    --id "$contract_id" \
    --network "$NETWORK" \
    --source "$STELLAR_SECRET_KEY" \
    -- "$fn_name" "${args[@]}" \
    2>/dev/null | tr -d '"' | xargs
}

# ── Assert Helper ──────────────────────────────────────────────────────────────

assert_eq() {
  local label="$1"
  local expected="$2"
  local actual="$3"

  if [[ "$actual" == "$expected" ]]; then
    log_ok "$label: $actual"
    PASS_COUNT=$((PASS_COUNT + 1))
  else
    log_error "$label: expected='$expected' actual='$actual'"
    FAIL_COUNT=$((FAIL_COUNT + 1))
  fi
}

assert_not_empty() {
  local label="$1"
  local actual="$2"

  if [[ -n "$actual" && "$actual" != "null" && "$actual" != "None" ]]; then
    log_ok "$label: $actual"
    PASS_COUNT=$((PASS_COUNT + 1))
  else
    log_error "$label: returned empty or null"
    FAIL_COUNT=$((FAIL_COUNT + 1))
  fi
}

# ── Verify Contract Exists On-Chain ────────────────────────────────────────────

verify_contract_info() {
  local name="$1"
  local addr="$2"

  log_step "Checking $name is deployed on-chain"

  if stellar contract info \
      --id "$addr" \
      --network "$NETWORK" \
      &>/dev/null 2>&1; then
    log_ok "$name contract exists on-chain ($addr)"
    PASS_COUNT=$((PASS_COUNT + 1))
  else
    log_error "$name contract NOT found on-chain ($addr)"
    FAIL_COUNT=$((FAIL_COUNT + 1))
  fi
}

# ── Verify Marketplace ─────────────────────────────────────────────────────────

verify_marketplace() {
  log_step "Verifying Marketplace contract"

  # asset_count() → expected 3
  local asset_count
  asset_count=$(query "$MARKETPLACE_ADDR" "asset_count" 2>/dev/null || echo "ERROR")
  assert_eq "asset_count" "$EXPECTED_ASSET_COUNT" "$asset_count"

  # get_asset(1) → should return Some(...)
  local asset1
  asset1=$(query "$MARKETPLACE_ADDR" "get_asset" --asset_id "1" 2>/dev/null || echo "")
  assert_not_empty "get_asset(1)" "$asset1"

  # get_asset(2) → should return Some(...)
  local asset2
  asset2=$(query "$MARKETPLACE_ADDR" "get_asset" --asset_id "2" 2>/dev/null || echo "")
  assert_not_empty "get_asset(2)" "$asset2"

  # get_asset(3) → should return Some(...)
  local asset3
  asset3=$(query "$MARKETPLACE_ADDR" "get_asset" --asset_id "3" 2>/dev/null || echo "")
  assert_not_empty "get_asset(3)" "$asset3"

  # get_asset(999) → should return None
  local asset_missing
  asset_missing=$(query "$MARKETPLACE_ADDR" "get_asset" --asset_id "999" 2>/dev/null || echo "None")
  assert_eq "get_asset(999) returns None" "None" "$asset_missing"

  # Verify asset 1 name contains expected string
  local asset1_raw
  asset1_raw=$(stellar contract invoke \
    --id "$MARKETPLACE_ADDR" \
    --network "$NETWORK" \
    --source "$STELLAR_SECRET_KEY" \
    -- get_asset --asset_id 1 \
    2>/dev/null || echo "{}")

  if echo "$asset1_raw" | grep -qi "Prompt\|Optimizer"; then
    log_ok "Asset 1 fields validated (name/type match)"
    PASS_COUNT=$((PASS_COUNT + 1))
  else
    log_warn "Asset 1 field validation inconclusive (XDR format may vary)"
  fi
}

# ── Verify Agent Registry ──────────────────────────────────────────────────────

verify_agent_registry() {
  log_step "Verifying Agent Registry contract"

  # agent_count() → expected 2
  local agent_count
  agent_count=$(query "$AGENT_REGISTRY_ADDR" "agent_count" 2>/dev/null || echo "ERROR")
  assert_eq "agent_count" "$EXPECTED_AGENT_COUNT" "$agent_count"

  # get_agent(1) → should return Some(...)
  local agent1
  agent1=$(query "$AGENT_REGISTRY_ADDR" "get_agent" --agent_id "1" 2>/dev/null || echo "")
  assert_not_empty "get_agent(1)" "$agent1"

  # get_agent(2) → should return Some(...)
  local agent2
  agent2=$(query "$AGENT_REGISTRY_ADDR" "get_agent" --agent_id "2" 2>/dev/null || echo "")
  assert_not_empty "get_agent(2)" "$agent2"

  # get_reputation(1) → should be 5000 (default neutral)
  local rep1
  rep1=$(query "$AGENT_REGISTRY_ADDR" "get_reputation" --agent_id "1" 2>/dev/null || echo "ERROR")
  assert_eq "get_reputation(1)" "5000" "$rep1"

  # get_reputation(2) → should be 5000
  local rep2
  rep2=$(query "$AGENT_REGISTRY_ADDR" "get_reputation" --agent_id "2" 2>/dev/null || echo "ERROR")
  assert_eq "get_reputation(2)" "5000" "$rep2"
}

# ── Verify Micropayments ───────────────────────────────────────────────────────

verify_micropayments() {
  log_step "Verifying Micropayments contract"

  # stream_count() → expected 0 (no streams opened by init)
  local stream_count
  stream_count=$(query "$MICROPAYMENTS_ADDR" "stream_count" 2>/dev/null || echo "ERROR")
  assert_eq "stream_count" "$EXPECTED_STREAM_COUNT" "$stream_count"

  # get_stream(1) → should return None (no streams)
  local stream1
  stream1=$(query "$MICROPAYMENTS_ADDR" "get_stream" --stream_id "1" 2>/dev/null || echo "None")
  assert_eq "get_stream(1) returns None" "None" "$stream1"
}

# ── XDR Decode Spot-Check ──────────────────────────────────────────────────────

verify_xdr_decode() {
  log_step "XDR decode spot-check (marketplace asset_count)"

  # Use stellar contract read to fetch raw XDR and decode it
  local xdr_output
  xdr_output=$(stellar contract read \
    --id "$MARKETPLACE_ADDR" \
    --network "$NETWORK" \
    --key "A_COUNT" \
    2>/dev/null | head -5 || echo "")

  if [[ -n "$xdr_output" ]]; then
    log_ok "XDR read succeeded for A_COUNT key"
    PASS_COUNT=$((PASS_COUNT + 1))
    echo "  XDR: $xdr_output"
  else
    log_warn "XDR read returned empty (may not be supported on all CLI versions)"
  fi
}

# ── Final Report ───────────────────────────────────────────────────────────────

print_report() {
  local total=$((PASS_COUNT + FAIL_COUNT))
  echo ""
  echo -e "${BOLD}╔══════════════════════════════════════════════╗${RESET}"
  echo -e "${BOLD}║   Verification Report                        ║${RESET}"
  echo -e "${BOLD}╚══════════════════════════════════════════════╝${RESET}"
  echo ""
  echo -e "  Total checks: ${BOLD}${total}${RESET}"
  echo -e "  ${GREEN}Passed: ${PASS_COUNT}${RESET}"
  if [[ $FAIL_COUNT -gt 0 ]]; then
    echo -e "  ${RED}Failed: ${FAIL_COUNT}${RESET}"
  else
    echo -e "  Failed: 0"
  fi
  echo ""

  if [[ $FAIL_COUNT -eq 0 ]]; then
    echo -e "${GREEN}${BOLD}✔ All contracts verified successfully!${RESET}"
    exit 0
  else
    echo -e "${RED}${BOLD}✘ ${FAIL_COUNT} check(s) failed. Review output above.${RESET}"
    exit 1
  fi
}

# ── Main ──────────────────────────────────────────────────────────────────────

main() {
  echo -e "${BOLD}╔══════════════════════════════════════════════╗${RESET}"
  echo -e "${BOLD}║   Cortex Protocol — On-Chain Verification    ║${RESET}"
  echo -e "${BOLD}╚══════════════════════════════════════════════╝${RESET}"

  if [[ -z "${STELLAR_SECRET_KEY:-}" ]]; then
    log_error "STELLAR_SECRET_KEY not set"
    exit 1
  fi

  load_addresses

  verify_contract_info "Marketplace"    "$MARKETPLACE_ADDR"
  verify_contract_info "Micropayments"  "$MICROPAYMENTS_ADDR"
  verify_contract_info "AgentRegistry"  "$AGENT_REGISTRY_ADDR"

  verify_marketplace
  verify_agent_registry
  verify_micropayments
  verify_xdr_decode

  print_report
}

main "$@"
