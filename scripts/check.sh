#!/usr/bin/env bash
# Each leg keeps its complete output in a temporary log and prints a bounded
# status block. Failed legs print their captured diagnostics.
set -euo pipefail

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
failed=0

run_check() {
  local name="$1"
  shift
  if "$SCRIPT_DIR/run-quiet" "$name" -- "$@"; then
    :
  else
    failed=1
  fi
}

run_check "Typecheck" tsc --noEmit
run_check "Lint" biome check .
run_check "Type lint" oxlint --type-aware --tsconfig ./tsconfig.json src/ tests/ scripts/
run_check "Unit tests" bun test tests/unit
run_check "Fitness tests" bun test tests/fitness
run_check "API check" bun run api:check

if [ "$failed" -eq 0 ]; then
  exit 0
else
  exit 1
fi
