# Shared owner validation

This records the checks for named-session borrowing and the strict owner action API. The owner has two execution profiles: raw-compatible access with fenced controller ownership, and typed actions with an installed host policy. Native input in either profile does not provide renderer-atomic authorization.

## Delivered boundary

The daemon holds one browser-wide controller grant across logical session names. Socket-bound proofs include owner epoch, opaque grant and increasing request sequence. Whole logical Page operations stay admitted between their CDP messages. Handback closes admission, drains known work, verifies the page and commits the named binding with compare-and-swap. Unknown remote outcomes quarantine the owner; the private journal prevents a restart from silently admitting another controller. A fresh uncertain Page receipt also quarantines a logical operation when its thrown error lacks dispatch metadata. Batch results preserve an earlier uncertain step even if a later action succeeds; stale receipts from prior operations do not taint failed observations.

`borrowNamedSession` retains the existing Page interface inside that fenced boundary. `borrowOwnerActions` exposes a typed port without constructing a Page or releasing raw CDP. A trusted Node host installs the latter profile through `startOwnerActionDaemon`; policy callbacks and permissions are constructor inputs. Standard CLI owners remain raw-compatible. A strict owner refuses raw CLI/CDP commands explicitly.

Strict action preparation resolves exactly one element and retains its remote object. The owner issues opaque, single-use prepared and approval handles bound to the grant, page and document. Authorization and dispatch recheck the document, surrounding DOM, element, geometry and hit test. Selector fallback after approval is prohibited. The daemon counts the whole typed request as one logical operation and rechecks its deadline before every private CDP send.

Typed owner observation and evidence scripts execute in a unique isolated world. Retained objects resolve in that world. Page-world patches to query and geometry methods cannot intercept these reads. Observations recheck document identity before publishing nodes, and extraction rechecks both document and bounded DOM evidence.

## Passive trace capture

Raw-compatible owners preserve background trace while another command acts. Collector setup runs under a controller grant on a fresh, daemon-minted observer attachment. The collector then keeps only an exact-session capability for a fixed telemetry/lifecycle event set and releases controller ownership. Passive capture cannot send browser commands, forge another attachment or receive unrelated session/browser events. Strict owners refuse raw telemetry subscriptions.

Normal stop reacquires a fresh grant before removing its scripts, bindings and listeners, then detaches only its disposable observer attachment. A busy controller leaves the worker in `stopping` with `cleanup_pending`; it keeps the collector/socket and retries without dispatching cleanup out of turn. An unavailable owner fails explicitly without opening another browser. External subscription revocation marks capture incomplete. Self-detach during successful cleanup does not report false revocation.

After a hard client crash, the daemon revokes telemetry and defers detaching the known disposable observer session until the owner is idle. This does not prove page-world wrappers were removed. Inert instrumentation can remain until navigation or trusted cleanup: installation is deduplicated, sinks are capped at 64, retained recent events at 200, each retained/forwarded script event at 16,384 JavaScript string characters (at most 48 KiB UTF-8), and listener/patch cleanup entries are bounded. Normal stop removes the capture's instrumentation; disconnect alone is never reported as full script cleanup.

## Capabilities and limits

| Surface | Delivered behavior |
| --- | --- |
| Native actions | `goto`, `click`, `hover`, `fill`, `type`, and `press` bound to one exact element, including `:focus` |
| Fill verification | Exact or normalized private value comparison; failure preserves the dispatched, nonretryable receipt |
| Typed reads | State metadata, bounded interactive DOM projection and exact element state |
| Extraction | Bounded rows and scalar text/attribute/value fields; fresh data on each call |
| Policy | Trusted action allowlist, optional navigation-origin restrictions, deterministic policy or bounded trusted evaluator, shadow and enforce modes |
| Evidence | Payloads and input values withheld; text requires a trusted host redactor; credentials/query/hash removed from exposed URLs |
| Secret values | Value extraction requires host `allowValueReads` permission and an explicitly secret field |
| Unsupported | Raw scripts/CDP, arbitrary WebMCP tools, frames, popup/dialog actions, screenshots/images, semantic extraction-map learning, and unsupported native action kinds |
| Assurance | `owner-serialized-prechecked-native`; no renderer-atomic capability is advertised |

Native events remain vulnerable to page JavaScript changing the DOM after the final comparison. Requiring `renderer-same-task-dom` fails before dispatch; accepting the weaker native assurance requires explicit trusted configuration. There is no silent synthetic-click replacement.

Tenant and business-resource identity are not inferred as authorization facts from page text. Applications requiring those facts must supply trusted host policy and explicit outcome/identity conditions.

The private browser connection and any external direct CDP endpoint remain trusted-host capabilities outside this daemon boundary. Owner-policy classifier quality is not established by deterministic fixtures. No live model accuracy or image-safety result is claimed. Default evidence suppresses text; a host that enables text must supply suitable redaction for its application.

## Verification receipts

| Lane | Result | Receipt |
| --- | --- | --- |
| Typed action unit and real Chrome fixtures | 23 passed, 0 failed, 78 assertions across three files | `/tmp/bp-owner-actions-tests.log` |
| Scoped action formatting | Passed | `/tmp/bp-owner-actions-biome.log` |
| Action-stage typecheck | Passed | `/tmp/bp-action-typecheck.log` |
| Full repository check | Passed: typecheck, Biome, type-aware lint, 1,606 unit tests, 29 fitness tests and API check | `/tmp/browser-pilot-owner-final7-check.log` |
| Unit test detail | 1,606 passed, 0 failed, 13,441 assertions across 122 files | `/var/folders/40/8qd7189j3bv2yj9z8rcfq9h40000gq/T/browser-pilot-Unit_tests.dOOfyr` |
| Fitness detail | 29 passed, 0 failed, 282 assertions across 12 files | `/var/folders/40/8qd7189j3bv2yj9z8rcfq9h40000gq/T/browser-pilot-Fitness_tests.TkI1Tr` |
| Final production build | Passed | `/tmp/browser-pilot-owner-final7-build.log` |
| Post-build API extraction | Passed; existing unresolved documentation-link warnings remain | `/tmp/browser-pilot-owner-final7-api.log` |
| Final serialized real Chrome integration suite | 250 passed, 4 skipped, 0 failed, 674 assertions across 40 files | `/tmp/browser-pilot-owner-final7-integration.log` |
| Flightplan full check/build | Passed: 1,440 tests, 39 opt-in skips, 4,408 assertions across 107 files; lint/typecheck/build passed | `/tmp/fp-owner-final-check.log`, `/tmp/fp-owner-final-build.log` |
| Flightplan source bridge review | 47 passed, 0 failed, 168 assertions across four files | `/tmp/flightplan-owner-independent-review.log` |
| Restored source target/trace lifecycle fixture | 1 passed, 0 failed, 17 assertions | `/tmp/bp-passive-trace-e2e.log` |
| Passive trace focused unit/Chrome fixtures | 24 passed, 0 failed, 85 assertions across four files | `/tmp/bp-passive-trace-tests.log` |
| Owner receipt repair, independent Unix-daemon fixtures | 11 passed, 0 failed, 28 assertions | `/tmp/browser-pilot-owner-receipt-independent.log` |
| Packaged daemon lifecycle fixtures | 3 passed, 0 failed, 46 assertions; includes trace-time command success and completed HTTP capture | `/tmp/browser-pilot-owner-final7-daemon-e2e.log` |
| Packed BP and built Flightplan real Chrome consumers | 2 passed, 0 failed, 57 assertions against the final candidate | `/tmp/fp-owner-final-native-strict.log` |
| Packed public type compatibility | Passed | `/tmp/fp-owner-final-types.log` |
| Flightplan package consumer smoke | Passed: runtime exports, root declarations, relative imports, VFS, cancellation and optional entry points | `/tmp/fp-owner-final-package-smoke.log` |

The action lane includes real Chrome tests for an approved exact-node click, same-document business-context changes during guard latency, target replacement after approval, occluded targets, fresh structured extraction, private-value refusal, fill plus focused Enter, failed fill verification and hostile page-world DOM patches. Real Unix-socket daemon tests use the public Node host launcher and verify raw Runtime/Input refusal, competing controllers, forged/replayed approvals, release/reacquisition and stale guard evidence. Unit fixtures additionally cover grant changes, classifier timeout/unavailability, nonblocking shadow evaluation, sanitized navigation destinations, deterministic origin restrictions, predispatch deadline rejection and navigation during an observation.

The implementation lives in `src/owner/`, `src/daemon/`, `src/core/owner-actions/` and `src/adapters/node/`. See [the shared-owner guide](shared-owner.md) for the public API and host responsibilities.

The final packed candidate is `/tmp/browser-pilot-owner-final7.tgz`, SHA-256 `5ac844c38da9837d90f3d0eaa8d7ad6352bae2a857862100c2bde0452446e014`. The trusted launcher computes its endpoint identity from host-provided `wsUrl` and rejects conflicting fingerprints before starting a listener. The validation reviewer read the retained full-check leg logs, build/API receipts and artifact digest independently after the action source freeze. The unit count includes owner unit fixtures; focused and broader lanes overlap and must not be added together as independent coverage.

The changes stay within owner admission, action/evidence modules, transport and narrow adapters. `LeaseController` owns grant admission without socket/CDP dependencies; the action service owns handles and policy; the backend owns browser projections and native dispatch. Existing broad Page actions were not reorganized. This keeps the raw-compatible profile and typed policy boundary distinct while reusing the daemon's admission and lifecycle authority.

The broader browser suite uses disposable local Chrome and local HTTP fixtures. Its four skips are two Browser Use cloud-provider checks without configured live credentials and two opt-in native WebSocket review scenarios. It includes the ten new real-browser owner backend/daemon fixtures, so these results overlap the focused owner-action lane.

The final-candidate consumer lane invokes built Flightplan public exports through `FLIGHTPLAN_FP_MODULE` against the packed BP artifact above. It proves BP to cold/warm Flightplan to BP connection/state preservation, and strict owner execution through the public host launcher and typed borrower. The strict recipe covers navigation and a return assertion, click, verified fill, focused Enter, numeric extraction/assertion, secret captures excluded from summary/trace, installed-policy denial, local-policy denial and both owner-guard and local-guard latency mutations rejected before input. A local allow cannot widen the installed root policy. These are live local-browser fixtures with deterministic trusted evaluators; they do not measure classifier accuracy.

The earlier concurrent browser run is retained in `/tmp/browser-pilot-owner-final6-integration.log`: an OOPIF review case timed out, then its shared-browser teardown caused two following failures. That file passed alone (6 passed, 2 opt-in skips), and the full final-source integration suite passed when run serially. No OOPIF source or timeout change was used to obtain the clean rerun.

Final consumer restoration was verified in `/tmp/fp-owner-final-restore.json`: the packed BP candidate digest matches the artifact above, all consumer legs exited successfully, and Flightplan's original dependency tree, package manifest and lockfile hashes are unchanged. Final privacy checks inspected 14 report/log files against the configured environment keys and API-key markers with zero matches. No listeners remained on the 81 disposable fixture/browser ports observed in the final integration, packaged daemon and consumer logs. No Git write operations were performed.
