#!/usr/bin/env bash
# Tip: this will show errors only if there are any.
set -euo pipefail

failed=0

run_check() {
  local name="$1"
  shift
  printf "  running: %s" "$name"
  if output=$("$@" 2>&1); then
    printf "\r\033[K"
  else
    printf "\r\033[K\033[31m  FAIL: %s\033[0m\n" "$name"
    echo "$output"
    echo
    failed=1
  fi
}

run_check "typecheck (tsc)" bun run typecheck
run_check "lint (biome)" bun run lint
run_check "lint:type (oxlint)" bun run lint:type
run_check "test (unit)" bun test tests/unit

if [ "$failed" -eq 0 ]; then
  printf "\033[32m  all checks passed\033[0m\n"
else
  exit 1
fi
