#!/usr/bin/env bash
set -euo pipefail

# Validate the exact packaged daemon entry without starting a browser session.
bun run build >/dev/null
test -f dist/daemon.mjs
test -x dist/daemon.mjs
test "$(node dist/daemon.mjs --help | head -1)" = 'Usage: daemon <sessionId> [--idle-timeout <ms>]'
test "$(node dist/daemon.mjs --version)" = "$(node -p "require('./package.json').version")"

# Repeat the checks from an extracted npm tarball. This catches packaging
# omissions that a workspace build cannot see while remaining side-effect free.
smoke_dir=$(mktemp -d "${TMPDIR:-/tmp}/browser-pilot-package-smoke.XXXXXX")
trap 'rm -rf "$smoke_dir"' EXIT
package_name=$(npm pack --silent --ignore-scripts --pack-destination "$smoke_dir")
package_file="$smoke_dir/$package_name"
tar -xzf "$package_file" -C "$smoke_dir"
test -f "$smoke_dir/package/dist/daemon.mjs"
test "$(node "$smoke_dir/package/dist/daemon.mjs" --help | head -1)" = 'Usage: daemon <sessionId> [--idle-timeout <ms>]'
test "$(node "$smoke_dir/package/dist/daemon.mjs" --version)" = "$(node -p "require('./package.json').version")"
test "$(node "$smoke_dir/package/dist/cli.mjs" --version)" = "$(node -p "require('./package.json').version")"

echo 'package smoke passed: workspace and npm tarball daemon entries are side-effect-free'
