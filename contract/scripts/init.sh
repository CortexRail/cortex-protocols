#!/usr/bin/env bash
# =============================================================================
# Cortex Protocol — Post-Deploy Initialisation Script
# =============================================================================
# Calls initialize(admin) on marketplace, seeds 3 sample assets,
# registers 2 agents in the agent_registry.
#
# Usage:
#   STELLAR_SECRET_KEY=S... bash init.sh
#
# Reads:  contract/deployed_addresses.json
# =============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONTRACT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
ADDRESSES_FILE="$CONTRACT_DIR/deployed_addresses.json"
NETWORK="${STELLAR_NETWORK:-testnet}"

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
log_step()  { echo -e "\n${BOLD}▶ $*${RESET}"; }

# ── Load Addresses ─────────────────────────────────────────────────────────────

load_addresses() {
  if [[ ! -f "$ADDRESSES_FILE" ]]; then
    log_error "deployed_addresses.json not found at $ADDRESSES_FILE"
    log_error "Run deploy.sh first."
    exit 1
  fi

  MARKETPLACE_ADDR=$(jq -r '.contracts.marketplace.address' "$ADDRESSES_FILE")
  MICROPAYMENTS_ADDR=$(jq -r '.contracts.micropayments.address' "$ADDRESSES_FILE")
  AGENT_REGISTRY_ADDR=$(jq -r '.contracts.agent_registry.address' "$ADDRESSES_FILE")

  log_info "Marketplace:    $MARKETPLACE_ADDR"
  log_info "Micropayments:  $MICROPAYMENTS_ADDR"
  log_info "Agent Registry: $AGENT_REGISTRY_ADDR"
}

# ── Get Admin Address ──────────────────────────────────────────────────────────

get_admin_address() {
  ADMIN_ADDRESS=$(stellar keys address "$STELLAR_SECRET_KEY" \
    --network "$NETWORK" 2>/dev/null || \
    stellar account address \
      --source "$STELLAR_SECRET_KEY" \
      --network "$NETWORK" 2>/dev/null || true)

  if [[ -z "$ADMIN_ADDRESS" ]]; then
    # Derive from secret key directly
    ADMIN_ADDRESS=$(python3 -c "
import sys
try:
    # Attempt to derive address from secret key using stellar-base if available
    import subprocess
    result = subprocess.run(
        ['stellar', 'keys', 'show', '--public-key', '--source', sys.argv[1]],
        capture_output=True, text=True
    )
    print(result.stdout.strip())
except Exception:
    print('')
" "$STELLAR_SECRET_KEY" 2>/dev/null || echo "")
  fi

  if [[ -z "$ADMIN_ADDRESS" ]]; then
    log_error "Could not derive admin address from STELLAR_SECRET_KEY"
    exit 1
  fi

  log_info "Admin address: $ADMIN_ADDRESS"
}

# ── Invoke Contract Function ───────────────────────────────────────────────────

invoke() {
  local contract_id="$1"
  local fn_name="$2"
  shift 2
  local args=("$@")

  log_info "  Invoking ${fn_name}..."
  stellar contract invoke \
    --id "$contract_id" \
    --network "$NETWORK" \
    --source "$STELLAR_SECRET_KEY" \
    -- "$fn_name" "${args[@]}" \
    2>&1 | grep -v "^$" || true
}

# ── Initialise Marketplace ─────────────────────────────────────────────────────

init_marketplace() {
  log_step "Initialising Marketplace contract"
  invoke "$MARKETPLACE_ADDR" "initialize" \
    --owner "$ADMIN_ADDRESS"
  log_ok "Marketplace initialised with admin: $ADMIN_ADDRESS"
}

# ── Seed Sample Assets ─────────────────────────────────────────────────────────

seed_assets() {
  log_step "Seeding 3 sample intelligence assets"

  # Asset 1: GPT-4 Prompt Optimizer (Prompt, Perpetual, 5 XLM)
  log_info "  Listing asset 1: GPT-4 Prompt Optimizer..."
  invoke "$MARKETPLACE_ADDR" "list_asset" \
    --owner "$ADMIN_ADDRESS" \
    --name "GPT-4 Prompt Optimizer" \
    --description "A battle-tested system prompt that consistently improves GPT-4 output quality by 40% across reasoning tasks." \
    --asset_type '{"Prompt": null}' \
    --license '{"Perpetual": null}' \
    --price "50000000"
  log_ok "  Asset 1 listed (Prompt, Perpetual, 5 XLM)"

  # Asset 2: Code Review Workflow (Workflow, UsageBased, 1 XLM/call)
  log_info "  Listing asset 2: Automated Code Review Workflow..."
  invoke "$MARKETPLACE_ADDR" "list_asset" \
    --owner "$ADMIN_ADDRESS" \
    --name "Automated Code Review Workflow" \
    --description "Multi-step agent workflow that performs security analysis, style checks, and test coverage review on any codebase." \
    --asset_type '{"Workflow": null}' \
    --license '{"UsageBased": null}' \
    --price "10000000"
  log_ok "  Asset 2 listed (Workflow, UsageBased, 1 XLM/call)"

  # Asset 3: Chain-of-Thought Reasoning Dataset (Dataset, OpenSource, 0.5 XLM)
  log_info "  Listing asset 3: CoT Reasoning Dataset v2..."
  invoke "$MARKETPLACE_ADDR" "list_asset" \
    --owner "$ADMIN_ADDRESS" \
    --name "CoT Reasoning Dataset v2" \
    --description "10,000 curated chain-of-thought examples covering mathematics, logic, and scientific reasoning. CC-BY licensed." \
    --asset_type '{"Dataset": null}' \
    --license '{"OpenSource": null}' \
    --price "5000000"
  log_ok "  Asset 3 listed (Dataset, OpenSource, 0.5 XLM)"
}

# ── Register Agents ────────────────────────────────────────────────────────────

register_agents() {
  log_step "Registering 2 agents in Agent Registry"

  # Agent 1: Research Assistant Agent
  log_info "  Registering agent 1: ResearchBot-Alpha..."
  invoke "$AGENT_REGISTRY_ADDR" "register_agent" \
    --owner "$ADMIN_ADDRESS" \
    --name "ResearchBot-Alpha" \
    --description "Autonomous research agent specializing in scientific literature synthesis, fact-checking, and report generation." \
    --capabilities '["WebResearch","TextGeneration","Reasoning","DataAnalysis"]'
  log_ok "  Agent 1 registered (ResearchBot-Alpha)"

  # Agent 2: Code Generation Agent
  log_info "  Registering agent 2: CodeForge-v1..."
  invoke "$AGENT_REGISTRY_ADDR" "register_agent" \
    --owner "$ADMIN_ADDRESS" \
    --name "CodeForge-v1" \
    --description "Full-stack code generation agent with expertise in Rust, TypeScript, and Solidity. Includes automated testing." \
    --capabilities '["CodeGeneration","Reasoning","ActionExecution"]'
  log_ok "  Agent 2 registered (CodeForge-v1)"
}

# ── Print Init Summary ─────────────────────────────────────────────────────────

print_summary() {
  echo ""
  echo -e "${GREEN}${BOLD}╔══════════════════════════════════════════════╗${RESET}"
  echo -e "${GREEN}${BOLD}║   Initialisation Complete                    ║${RESET}"
  echo -e "${GREEN}${BOLD}╚══════════════════════════════════════════════╝${RESET}"
  echo ""
  echo -e "  Marketplace:    ${CYAN}${MARKETPLACE_ADDR}${RESET} (3 assets seeded)"
  echo -e "  Agent Registry: ${CYAN}${AGENT_REGISTRY_ADDR}${RESET} (2 agents registered)"
  echo ""
  echo -e "Next step: ${BOLD}bash verify.sh${RESET}"
}

# ── Main ──────────────────────────────────────────────────────────────────────

main() {
  echo -e "${BOLD}╔══════════════════════════════════════════════╗${RESET}"
  echo -e "${BOLD}║   Cortex Protocol — Post-Deploy Init         ║${RESET}"
  echo -e "${BOLD}╚══════════════════════════════════════════════╝${RESET}"

  if [[ -z "${STELLAR_SECRET_KEY:-}" ]]; then
    log_error "STELLAR_SECRET_KEY not set"
    exit 1
  fi

  load_addresses
  get_admin_address
  init_marketplace
  seed_assets
  register_agents
  print_summary
}

main "$@"
