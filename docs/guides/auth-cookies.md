# Cookie snapshot auth

Save the cookies from a page you already logged into by hand, and reuse them in later
sessions without repeating the login. This is a **cookie jar snapshot**, not a general auth
system: it captures and restores browser cookies, nothing else.

## Quick start

```bash
# One-time: log in like a human, in a visible tab
bp connect --name shopify-login --new-tab --foreground \
  --page-url https://dev.shopify.com/dashboard
# ... complete login + MFA in the visible tab; wait for the dashboard ...
bp snapshot -i -s shopify-login              # confirm you are on the authenticated page

# Save the cookies to a private snapshot file
bp env auth save shopify -s shopify-login
bp env auth inspect shopify                  # offline sanity check, no values shown

# Every later session: restore the snapshot into a fresh tab
bp connect --name shopify-work --auth shopify
bp snapshot -i -s shopify-work               # verify logged-in state via the page itself
```

Renewal, once cookies expire or rotate: repeat the login, then overwrite the file.

```bash
bp env auth save shopify -s shopify-login --force
```

Explicit file paths work the same way as names — useful for CI or when you want the file
under version-control-ignored project storage instead of `~/.browser-pilot/auth/`:

```bash
bp env auth save ./.browser-pilot-auth/shopify.json -s shopify-login
bp connect --name ci --auth /run/secrets/shopify.json
```

The same shape applies to any cookie-auth site — swap `shopify-login`/`shopify-work` for
whatever names make sense (`app-login` / `app-work`, etc.).

## Commands

### `bp env auth save <name-or-path> -s <session> [--include-url <url>]... [--force]`

Captures the domain-matched cookies visible on the given session's current page and writes
them to a snapshot file.

- **Requires an explicit session** (`-s <id>`, or bare `-s` for the latest session). It never
  auto-connects — you must point it at a page you deliberately logged into.
- The page must be on an `http://` or `https://` URL. `about:blank`, `file:`, internal pages,
  and URLs with embedded credentials are rejected.
- Fails (and does not write) if the page navigated away between reading the URL and finishing
  the capture (a TOCTOU guard against a mid-capture redirect).
- Fails with no cookies matched (nothing was in scope for the domain) rather than writing an
  empty file.
- Fails if the target file already exists — pass `--force` to overwrite (used for renewal).
- `--include-url <url>` (repeatable) adds another origin's domain-matched cookies to the same
  snapshot — the motivating case is cross-origin SSO (e.g. capturing both `app.example.com`
  and `accounts.example.com` cookies from one `app.example.com` login page).
- Never prints cookie values, in either human or `--json` output.

### `bp env auth inspect <name-or-path>`

Validates a snapshot **fully offline**: no browser connection, no session file created. Prints
metadata only — resolved file path, source URL, saved-at timestamp, cookie count, and the set
of cookie domains. Never prints cookie values.

### `bp connect --auth <name-or-path>`

Restores a saved snapshot into a **fresh tab** before any navigation happens, then goes to the
snapshot's saved `sourceUrl` (or `--page-url`, if given).

- Implies `--new-tab` (stays in the background unless `--foreground` is also passed).
- Conflicts with `--resume`/`-r`, the global `-s`/`--session` (resume alias), and
  `--target-url` — a snapshot always initializes a new session, never attaches to an existing
  one.
- Compatible with `--page-url` (overrides the snapshot's saved source URL — see the scope-rules
  warning below) and with `--cf-access` (restore the snapshot, then mint/apply the Cloudflare
  Access cookie, then navigate once).
- The file is loaded and fully validated *before* any browser/provider session is created, so a
  bad or missing snapshot fails fast without spending a browser session.
- After restoring, prints a summary: `Restored N cookies (M expired skipped) from <path>.
  Authentication has not been verified.` — see [Restored ≠ logged in](#restored--logged-in)
  below.

`BROWSER_PILOT_AUTH=<name-or-path>` is an environment fallback for `--auth`, useful in CI so
every `bp connect` in a job is authenticated without touching each invocation:

- Resolved with the exact same name-or-path rules as `--auth`.
- `--auth` wins when both are set.
- Honored only by `bp connect`, only when `--auth` is absent, and never on `--resume`/attach.
- When used, `bp connect` prints exactly one line: `auth: using BROWSER_PILOT_AUTH → <resolved
  path>`.

## Name-vs-path resolution

`save`, `inspect`, and `connect --auth` all resolve their argument with the same rules — no
fallback search, so a typo fails loudly instead of silently reading the wrong file.

| Argument | Kind | Resolves to |
|---|---|---|
| `shopify` | name (`^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$`, no dots) | `~/.browser-pilot/auth/shopify.json` |
| `shopify.json` | path (contains a dot) | `$CWD/shopify.json` |
| `./x/y.json`, `../y.json` | path | relative to CWD |
| `/run/secrets/a.json` | path | absolute |
| `~/private/a.json` | path | home-expanded |
| `.`, `..`, empty/whitespace, spaces, `scheme://...` URLs | error | `invalid_format` |

A missing path or name always errors (`not_found`) — it never falls back to searching the auth
directory. Symlinks and directories are rejected as targets (never treated as regular files).
The resolved absolute path is always echoed in command output.

## Scope rules

Cookies are captured from the browser context's full jar (`Storage.getCookies`), then filtered
in memory against the page's host `H` (lowercased). A cookie `c` is included iff:

- `c` is **host-only** and `c.domain === H` (exact match), or
- `c` is a **domain cookie** with attribute `d` (leading dot stripped) and `H === d` or `H`
  ends with `"." + d` — a suffix match at a **label boundary only**, never a raw substring
  match. (`app.example.com` matches a `.example.com` domain cookie; `pple.example.com` does
  not, even though it ends with the same characters.)

All paths on the matching domain(s) are included — capture does not filter by cookie `Path`.
Each `--include-url` host is added using the same rule, unioned with the primary page's scope.

**No public-suffix list is used** (zero-dependency constraint). Consequence: capturing on a
site like `foo.co.uk` would, in principle, include a hypothetical `.co.uk` domain cookie if one
existed. In practice browsers refuse to *set* such overly-broad cookies, so real jars never
contain them, and a restoring Chromium would reject them on `Storage.setCookies` too — this is a
documented, accepted limitation, not a bug you need to work around.

## File format and privacy

Snapshot files are plain JSON (schema `browser-pilot-cookie-auth`, `schemaVersion: 1`):

```jsonc
{
  "format": "browser-pilot-cookie-auth",
  "schemaVersion": 1,
  "savedAt": "2026-09-15T09:00:00.000Z",
  "sourceUrl": "https://app.example.com/dashboard",   // query/fragment stripped
  "cookies": [ /* name, value, domain, hostOnly, path, secure, httpOnly, sameSite,
                  expires, priority, sourceScheme, sourcePort, partitionKey? */ ]
}
```

**These files contain live session cookies in plaintext — treat them like any other
credential.**

- Written atomically (temp file + `rename`/hard-link), with file mode `0o600` and the
  containing `~/.browser-pilot/auth/` directory created at `0o700` (existing parent
  directories are never re-chmod'ed). POSIX modes are best-effort on Windows.
- Never commit a snapshot file to version control. `.gitignore` in this repo (and any project
  using this pattern) should exclude `*.cookies.json` and `.browser-pilot-auth/`.
- `save` is create-only by default (fails with `already_exists` if the target exists);
  `--force` is the explicit overwrite gate, used for renewal.
- No cookie value ever appears in CLI output (human or `--json`), error messages, `--debug`/
  `--trace` CDP logs, `trace.jsonl`, or session JSON (`bp session` only records
  `metadata.cookieAuth: { source, restoredAt, cookieCount }` — the `~`-shortened file path and
  counts, never names or values).

## Expiry and rotation

- `save` captures each cookie's expiry as-is; session cookies (no expiry) are stored as
  `expires: null`.
- `connect --auth` skips cookies that have already expired at restore time and reports the
  count (`M expired skipped`); it does not fail just because some cookies expired, only when
  *nothing* usable remains (see below).
- There is no automatic renewal. When a site rotates or expires its session cookies, repeat the
  one-time login and re-run `bp env auth save <ref> -s <login-session> --force`.
- There is no `bp env auth remove`/delete command for snapshot files — the file is a portable
  object you own; use `rm` to delete it. (`bp env auth clear` is a separate, unrelated command
  for the persisted Cloudflare-Access-style header/cookie auth — it never touches snapshot
  files.)

## Restored ≠ logged in

`bp connect --auth` restores cookies into the browser; it does not verify that the target site
still considers you authenticated. After restoring, the CLI does an internal read-back check
(comparing cookie *identities* — name/domain/path — never values) and reports counts, but:

- A **partial** restore (at least one cookie verified) is treated as a working best-effort
  attempt: it prints the `restored`/`unverified`/`skippedExpired` counts and the *names and
  domains* of any unverified cookies (never values), and exits `0`. A single unset preference
  cookie failing to restore does not mean you are logged out.
- Only a **totally useless** result — zero cookies verified, or nothing eligible remained after
  expiry filtering — fails before navigation, with `CookieStateError('nothing_restored')` and a
  non-zero exit.

Either way, **the cookies being present does not guarantee the site treats the session as
valid** — sites can invalidate sessions server-side, require step-up auth, or reject cookies
tied to a different IP/user agent. Always verify the actual page state after connecting:

```bash
bp connect --name shopify-work --auth shopify
bp snapshot -i -s shopify-work    # look for a login form vs. an authenticated dashboard
```

## A fresh tab is not an isolated cookie jar

`--auth` opens a **new tab**, but that tab shares the same browser context (and therefore the
same cookie jar) as every other tab in that browser/profile. Restoring a snapshot **replaces
cookies for the matching domains browser-wide within that context** — it does not sandbox the
imported identity to just the new tab.

If you need to keep an imported identity isolated from other work happening in the same
browser (for example, running two different accounts side by side, or not wanting the imported
session's cookies to leak into your own logged-in tabs), use a **dedicated profile** or
`--user-data-dir` / a separate remote session for the restored identity, rather than relying on
"it's a new tab" for isolation.

## Cookie-only limits (localStorage is future work)

Cookie snapshots capture only cookies. Sites that keep authentication state in `localStorage`
or `sessionStorage` (common for some SPA auth flows and token-based session managers) are not
covered — the saved snapshot will restore cookies correctly, but the app may still redirect to
a login screen if it also expects storage-backed state. `sessionStorage` is explicitly out of
scope (it's tab-local and CDP does not have a stable, portable way to transplant it across
contexts). `localStorage` capture/restore is a possible **future addition** (v2); do not assume
it is supported today. Playwright's `storageState` format and Netscape cookie-jar imports are
also not supported — v1 only reads its own `browser-pilot-cookie-auth` format.

## CI / explicit files

The canonical CI pattern transfers the snapshot as a secret, writes it to a private temp file,
and points `bp connect` at it directly:

```yaml
- name: Authenticated smoke
  shell: bash
  env:
    BP_AUTH_JSON: ${{ secrets.BROWSER_AUTH_STATE }}
    BROWSER_PILOT_NO_DAEMON: "1"
  run: |
    set -euo pipefail
    : "${CDP_WS_URL:?Provision Chrome/CDP first}"
    auth_file="$RUNNER_TEMP/bp-auth.json"
    umask 077
    trap 'bp close -s ci >/dev/null 2>&1 || true; rm -f "$auth_file"' EXIT
    printf '%s' "$BP_AUTH_JSON" > "$auth_file"; unset BP_AUTH_JSON
    bp connect --name ci --browser-url "$CDP_WS_URL" --auth "$auth_file"
    bp run ./workflows/dashboard-smoke.json -s ci
```

Notes:

- Browser/CDP provisioning stays external to this pattern — `bp connect` only needs
  `CDP_WS_URL` and the snapshot file.
- The secret is written to `$RUNNER_TEMP` (not the checkout, not `$HOME`), under a restrictive
  `umask`, and removed in a `trap` regardless of job outcome.
- `BROWSER_PILOT_NO_DAEMON=1` keeps the run hermetic; daemons are not available in most CI
  sandboxes.
- `save` warns when a snapshot exceeds 48 KB (GitHub Actions secret size guidance); files over
  1 MiB are rejected outright by `parseCookieState` as a fail-fast against wrong files.

For `BROWSER_PILOT_AUTH=<name-or-path>` as an alternative to `--auth` in CI, see
[Commands](#commands) above.

## Library API

Portable functions and types — usable from any Web-Standard runtime (Node, Bun, Cloudflare
Workers) — are exported from both the package root and `browser-pilot/core`:

```typescript
import {
  parseCookieState,
  serializeCookieState,
  captureCookieState,
  restoreCookieState,
  CookieStateError,
  type CookieState,
  type SerializedCookie,
  type CookieRestoreResult,
  type CookieCaptureOptions,
  type CookieStateErrorCode,
} from 'browser-pilot'; // or 'browser-pilot/core'
```

- `captureCookieState(page, opts?)` — capture domain-matched cookies from a page's current URL
  into a `CookieState`. Accepts `{ includeUrls?: string[] }`.
- `restoreCookieState(page, state)` — restore a `CookieState` into a page's browser context,
  including the read-back identity verification described above. Resolves
  `{ restored, skippedExpired, unverified, domains }`; throws `CookieStateError('nothing_restored')`
  only when the restore is provably useless (see [Restored ≠ logged in](#restored--logged-in)).
- `parseCookieState(input)` / `serializeCookieState(state)` — parse/validate or serialize the
  JSON file format without touching a browser at all.
- `CookieStateError` carries a typed `code`: `not_found | invalid_format | unsupported_version |
  expired | empty | invalid_cookie | unsupported_partition | already_exists | io_error |
  nothing_restored`.

File I/O helpers are **Node-only** and exported from `browser-pilot/adapters/node` (never from
the root or `/core`, to keep those entry points portable to Workers):

```typescript
import {
  loadCookieStateFile,
  saveCookieStateFile,
  resolveCookieStateRef,
} from 'browser-pilot/adapters/node';
```

- `resolveCookieStateRef(ref)` — the name-or-path resolver described above, as a pure string →
  path function.
- `loadCookieStateFile(ref)` / `saveCookieStateFile(ref, state, { overwrite? })` — read/write a
  snapshot file with the same perms/atomicity/symlink-rejection guarantees the CLI uses.

Hosts that embed browser-pilot without shelling out to `bp` (for example, a `just-bash`
integration or the flightplan driver) load the JSON from their own secret store and call
`restoreCookieState(page, state)` directly during session setup — see
[Shell / just-bash adapter](./just-bash.md).
