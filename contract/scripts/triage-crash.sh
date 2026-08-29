#!/bin/bash
set -e

if [ -z "$1" ]; then
    echo "Error: Missing crash artifact path."
    echo "Usage: $0 <path-to-crash-artifact>"
    exit 1
fi

CRASH_FILE="$1"
if [ ! -f "$CRASH_FILE" ]; then
    echo "Error: Crash artifact '$CRASH_FILE' does not exist."
    exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FUZZ_DIR="$SCRIPT_DIR/../fuzz"

# Convert to absolute path if relative
CRASH_PATH="$(cd "$(dirname "$CRASH_FILE")" && pwd)/$(basename "$CRASH_FILE")"

echo "Triaging crash artifact: $CRASH_PATH"
cd "$FUZZ_DIR"
cargo fuzz run stateful_sequence "$CRASH_PATH"
