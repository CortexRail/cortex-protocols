#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FUZZ_DIR="$SCRIPT_DIR/../fuzz"

echo "Minimizing corpus for fuzz target: stateful_sequence..."
cd "$FUZZ_DIR"
cargo fuzz cmin stateful_sequence
echo "Corpus minimization complete."
