#!/usr/bin/env bash
set -euo pipefail

if [[ "${BROWSER_PILOT_NO_DAEMON:-}" == "1" || "${BROWSER_PILOT_NO_DAEMON:-}" == "true" ]]; then
  echo 'test:daemon:local must run without BROWSER_PILOT_NO_DAEMON' >&2
  exit 2
fi

# Exercise the installed layout, not the source entrypoint. This proves that
# dist/cli.mjs locates and spawns dist/daemon.mjs with the same lifecycle.
bun run build >/dev/null
export BROWSER_PILOT_TEST_CLI_ENTRY='./dist/cli.mjs'

# This lane is intentionally local-only: it exercises the default daemon
# lifecycle and the stable hot-socket regression tests. Network throttling is
# covered by the direct-mode CI suite and is intentionally excluded here
# because host scheduling makes its latency assertion noisy.
bun test tests/cli/env-trace-regression.test.ts \
  --test-name-pattern 'default daemon path|persists granted permissions|captures websocket traffic' \
  --timeout 90000

# Browser-scoped ownership: reuse after logical close, concurrent crash
# recovery, explicit stop, endpoint discovery, and direct opt-out.
bun test tests/daemon-e2e --timeout 90000
bun test tests/integration/local-discovery.test.ts --timeout 90000

echo 'local daemon smoke passed'
