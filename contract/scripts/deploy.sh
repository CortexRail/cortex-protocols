#!/usr/bin/env bash
# Deploy all Cortex Protocol contracts to Stellar testnet.
# Usage: STELLAR_SECRET_KEY=S... bash deploy.sh

set -euo pipefail

NETWORK="${STELLAR_NETWORK:-testnet}"
WASM_DIR="target/wasm32-unknown-unknown/release"

echo "Building contracts..."
cargo build --target wasm32-unknown-unknown --release --quiet

echo ""
echo "Deploying to $NETWORK..."

deploy_contract() {
  local name="$1"
  local wasm="$WASM_DIR/${name//-/_}.wasm"

  echo -n "  deploying $name... "
  local addr
  addr=$(stellar contract deploy \
    --wasm "$wasm" \
    --network "$NETWORK" \
    --source "$STELLAR_SECRET_KEY" \
    2>/dev/null)
  echo "$addr"
  echo "  $name=$addr" >> deployed_addresses.env
}

rm -f deployed_addresses.env

deploy_contract "marketplace"
deploy_contract "micropayments"
deploy_contract "agent_registry"

echo ""
echo "Contract addresses written to deployed_addresses.env"
cat deployed_addresses.env
