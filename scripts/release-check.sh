#!/usr/bin/env bash
set -euo pipefail

# The release gate deliberately exercises both transport policies. CI-style
# browser suites are direct-only; the detached packaged daemon runs locally.
bun run test:package
CI=true BROWSER_PILOT_NO_DAEMON=1 BROWSER_PILOT_NATIVE_WEBMCP=1 \
  bun test tests/integration --timeout 60000
CI=true BROWSER_PILOT_NO_DAEMON=1 BROWSER_PILOT_NATIVE_WEBMCP=1 \
  bun test tests/cli --timeout 60000
unset BROWSER_PILOT_NO_DAEMON
bun run test:daemon:local

echo 'release transport gate passed'
