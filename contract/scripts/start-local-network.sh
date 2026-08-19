#!/usr/bin/env bash
# =============================================================================
# Cortex Protocol — Local Soroban Network
# =============================================================================
# Launches a Soroban standalone network in Docker, waits for it to become
# healthy, and funds a set of test accounts through friendbot.
#
# Usage:
#   bash start-local-network.sh [--accounts N] [--stop] [--reset]
#
# Environment:
#   LOCAL_RPC_PORT      Host port for the quickstart container (default 8000)
#   LOCAL_ACCOUNTS      Number of accounts to fund (default 10)
#   SIMULATION_SEED     Seed the funded account list is derived from (default 1)
#   CONTAINER_NAME      Container name (default cortex-soroban-rpc)
#
# Requires: docker, curl. `stellar` CLI is used for key generation when present.
# =============================================================================

set -euo pipefail

RPC_PORT="${LOCAL_RPC_PORT:-8000}"
ACCOUNTS="${LOCAL_ACCOUNTS:-10}"
CONTAINER_NAME="${CONTAINER_NAME:-cortex-soroban-rpc}"
QUICKSTART_IMAGE="${QUICKSTART_IMAGE:-stellar/quickstart:testing}"
HEALTH_TIMEOUT_SECS="${HEALTH_TIMEOUT_SECS:-300}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONTRACT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
ACCOUNTS_FILE="$CONTRACT_DIR/local-accounts.json"

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'; BOLD='\033[1m'; RESET='\033[0m'
log_info()  { echo -e "${CYAN}[INFO]${RESET}  $*"; }
log_ok()    { echo -e "${GREEN}[OK]${RESET}    $*"; }
log_warn()  { echo -e "${YELLOW}[WARN]${RESET}  $*"; }
log_error() { echo -e "${RED}[ERROR]${RESET} $*" >&2; }
log_step()  { echo -e "\n${BOLD}▶ $*${RESET}"; }

# ── Argument parsing ──────────────────────────────────────────────────────────

DO_STOP=false
DO_RESET=false
while [[ $# -gt 0 ]]; do
  case "$1" in
    --accounts) ACCOUNTS="$2"; shift 2 ;;
    --stop)     DO_STOP=true; shift ;;
    --reset)    DO_RESET=true; shift ;;
    *) log_error "Unknown argument: $1"; exit 1 ;;
  esac
done

# ── Preflight ─────────────────────────────────────────────────────────────────

preflight() {
  log_step "Preflight checks"
  command -v docker &>/dev/null || { log_error "docker not found"; exit 1; }
  command -v curl   &>/dev/null || { log_error "curl not found";   exit 1; }
  docker info &>/dev/null || { log_error "docker daemon is not running"; exit 1; }
  log_ok "docker and curl available"
}

# ── Container lifecycle ───────────────────────────────────────────────────────

stop_network() {
  log_step "Stopping local network"
  if docker ps -a --format '{{.Names}}' | grep -qx "$CONTAINER_NAME"; then
    docker rm -f "$CONTAINER_NAME" >/dev/null
    log_ok "removed container $CONTAINER_NAME"
  else
    log_info "no container named $CONTAINER_NAME"
  fi
  rm -f "$ACCOUNTS_FILE"
}

start_network() {
  log_step "Starting Soroban standalone network"

  if docker ps --format '{{.Names}}' | grep -qx "$CONTAINER_NAME"; then
    if [[ "$DO_RESET" == "true" ]]; then
      log_info "container already running, resetting"
      docker rm -f "$CONTAINER_NAME" >/dev/null
    else
      log_ok "container $CONTAINER_NAME already running (use --reset to recreate)"
      return 0
    fi
  elif docker ps -a --format '{{.Names}}' | grep -qx "$CONTAINER_NAME"; then
    docker rm -f "$CONTAINER_NAME" >/dev/null
  fi

  docker run -d \
    --name "$CONTAINER_NAME" \
    -p "${RPC_PORT}:8000" \
    "$QUICKSTART_IMAGE" \
    --local --enable-soroban-rpc >/dev/null

  log_ok "container started on port $RPC_PORT"
}

# ── Health ────────────────────────────────────────────────────────────────────

wait_for_health() {
  log_step "Waiting for the network to become healthy"

  local deadline=$(( SECONDS + HEALTH_TIMEOUT_SECS ))
  local attempt=0

  while (( SECONDS < deadline )); do
    attempt=$(( attempt + 1 ))

    # Horizon reports a core latest_ledger once the network has closed a ledger.
    local ledger
    ledger=$(curl -s --max-time 5 "http://localhost:${RPC_PORT}/" \
      | grep -o '"core_latest_ledger":[0-9]*' | head -1 | cut -d: -f2 || true)

    if [[ -n "${ledger:-}" && "$ledger" -gt 1 ]]; then
      log_ok "network healthy at ledger $ledger (after ${attempt} checks)"
      return 0
    fi

    if (( attempt % 10 == 0 )); then
      log_info "  still waiting... ($(( deadline - SECONDS ))s left)"
    fi
    sleep 3
  done

  log_error "network did not become healthy within ${HEALTH_TIMEOUT_SECS}s"
  docker logs --tail 40 "$CONTAINER_NAME" >&2 || true
  return 1
}

# ── Account funding ───────────────────────────────────────────────────────────

fund_accounts() {
  log_step "Funding $ACCOUNTS test accounts via friendbot"

  local entries=()
  local funded=0

  for (( i = 0; i < ACCOUNTS; i++ )); do
    local secret public
    if command -v stellar &>/dev/null; then
      secret=$(stellar keys generate --no-fund "sim-$i" --network local >/dev/null 2>&1 \
        && stellar keys show "sim-$i" 2>/dev/null || true)
    fi

    if [[ -z "${secret:-}" ]]; then
      log_warn "  stellar CLI unavailable; skipping key generation for account $i"
      continue
    fi

    public=$(stellar keys address "sim-$i" 2>/dev/null || true)
    [[ -z "$public" ]] && continue

    if curl -s --max-time 20 "http://localhost:${RPC_PORT}/friendbot?addr=${public}" >/dev/null; then
      entries+=("{\"index\":$i,\"public\":\"$public\",\"secret\":\"$secret\"}")
      funded=$(( funded + 1 ))
    else
      log_warn "  friendbot failed for $public"
    fi
  done

  printf '{"network":"standalone","rpcPort":%s,"accounts":[%s]}\n' \
    "$RPC_PORT" "$(IFS=,; echo "${entries[*]:-}")" > "$ACCOUNTS_FILE"

  log_ok "$funded/$ACCOUNTS accounts funded → $ACCOUNTS_FILE"
}

# ── Main ──────────────────────────────────────────────────────────────────────

main() {
  echo -e "${BOLD}╔══════════════════════════════════════════════╗${RESET}"
  echo -e "${BOLD}║   Cortex Protocol — Local Soroban Network   ║${RESET}"
  echo -e "${BOLD}╚══════════════════════════════════════════════╝${RESET}"

  preflight

  if [[ "$DO_STOP" == "true" ]]; then
    stop_network
    exit 0
  fi

  start_network
  wait_for_health
  fund_accounts

  echo ""
  echo -e "${GREEN}${BOLD}✔ Local network ready${RESET}"
  echo -e "  Horizon / RPC:  ${CYAN}http://localhost:${RPC_PORT}${RESET}"
  echo -e "  Passphrase:     ${CYAN}Standalone Network ; February 2017${RESET}"
  echo -e "  Accounts:       ${CYAN}${ACCOUNTS_FILE}${RESET}"
  echo ""
}

main
