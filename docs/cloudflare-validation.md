# Cloudflare support and validation

Browser Run supports `cloudflare` (Chromium), `cloudflare:chromium`, and
experimental `cloudflare:kitesurf`. Configure `CLOUDFLARE_ACCOUNT_ID` and
`CLOUDFLARE_API_TOKEN` using an API token with `Browser Rendering - Edit`
permission. The paired aliases `CF_ACCOUNT_ID` / `CF_API_KEY` are also supported.
Cloudflare Access service tokens are separate: `CF_ACCESS_CLIENT_ID` and
`CF_ACCESS_CLIENT_SECRET` are only needed for a protected target site.

Account tokens are supported. Verify them through
`/accounts/{account_id}/tokens/verify`; `/user/tokens/verify` does not verify
account tokens. See [Cloudflare account token documentation](https://developers.cloudflare.com/fundamentals/api/get-started/account-owned-tokens/).

## Verified behavior

Validation on 2026-10-04 distinguishes real browser behavior from simulated
provider responses. No payment or order-confirmation journey was executed.

| Lane | Result | Scope |
| --- | --- | --- |
| Local checks and release transport gate | Pass | Typecheck, lint, unit/fitness tests, packed package, integration, direct CLI and daemon tests; real-browser tests use Bun 1.3.10 |
| Packed Node 18, 22 and 24, ESM/CJS | Pass | Real authenticated local WebSocket; simulated provider/browser responses; optional `ws` admission checked before allocation |
| Packed local workerd | Pass | Portable declarations without Node ambient types; simulated binding acquisition, upgrade, owner leases, PNG and cleanup |
| Local cross-consumer journey | Pass | Real Chromium through direct Node, built CLI, just-bash and sibling Flightplan; parent/child isolation and PNG capture |
| Live Node Chromium | Pass | Three fresh navigation/input/SPA/cross-origin child/PNG journeys; provider release confirmed for every allocation |
| Live Chromium CLI | Pass | Commands reuse one daemon/allocation; abrupt daemon loss recovers the same allocation, target and DOM state; final release confirmed |
| Live native Bun 1.3.10 | Pass for basic journey | Both engines verify input, click, PNG and cleanup |
| Live Kitesurf frames | Unsupported in tested workflow | Parent navigation/input/SPA pass; all three child-frame journeys fail; connection termination confirmed |

The live Chromium fixture HTML was delivered through HTTP echo endpoints on
`httpbin.org` and `eu.httpbin.org`, with only the child delivery URL changed.
Browser Run blocked temporary tunnel domains. These results verify real remote
browser execution and HTTP delivery, but not unrestricted tunnel navigation or
the full cross-site/nested/delayed frame matrix.

Chromium allocation responses currently include the legacy `browser-rendering`
WebSocket path. The provider accepts either exact path while validating the host,
account and allocation, and rejects embedded credentials or query parameters.

Kitesurf omits frame identity from `DOM.describeNode` and does not auto-attach the
selected child in the tested workflow. An exact frame-owner diagnostic still
could not read or fill the selected content. Kitesurf remains experimental;
use Chromium for iframe workflows. This weaker support is an accepted limitation,
not a merge blocker or a claim of feature parity.

Native Bun also has an unresolved compressed-socket failure in the opt-in
`BP_REVIEW_NATIVE_WS=1` regression probes. Maintained Node transport passes those
stale-ref and deadline scenarios. The baseline real-browser suite is validated
with Bun 1.3.10; installed Bun 1.2.16 has known disconnect failures. No speculative
compression workaround is enabled.

## Reusable validation commands

```sh
bun run check
npx --yes bun@1.3.10 run test:release
bun run test:runtime:node
bun run test:runtime:workers
npx --yes bun@1.3.10 run test:conformance:local
```

Runtime smoke runners build and pack the candidate. The local cross-consumer
runner requires a built sibling Flightplan checkout; optional companion workerd
validation is available through `bun run test:runtime:flightplan`.

For live fixture validation, build the package, expose
`tests/fixtures/pages/cloudflare-conformance.html` and its child page on two
reachable origins, then run:

```sh
BP_LIVE_CLOUDFLARE=1 \
CF_TEST_ORIGIN=https://parent.example \
CF_TEST_CROSS_ORIGIN=https://child.example \
bun run test:cloudflare:live
```

Bun loads `.env` before starting the runner. Standalone Node callers must provide
credentials in the environment (or use `--env-file=.env` on a supporting Node
version). The runner creates three fresh sessions per engine, records navigation,
input, SPA, exact child isolation and PNG evidence, and reports pass/fail/blocked.
Use `BP_CONFORMANCE_OUTPUT` to choose the report directory; otherwise it uses a
temporary directory. Only fixture pages are visited; no deployment or payment is
performed.

Chromium uses a 60-second idle keep-alive and explicit release. Pending or unknown
cleanup fails the run and prevents subsequent allocation attempts. A `closing`
receipt is not treated as confirmed release. Kitesurf is connection-bound: losing
its owner reports `SESSION_LOST` instead of silently launching a replacement.
Credentials and arbitrary provider error text are excluded from live reports.

The broader provider, Workers live binding, companion hosted lifecycle and payment
matrices remain separate release-validation work. Local workerd and simulated
provider passes do not establish those live guarantees.
