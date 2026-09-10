# Architecture

browser-pilot provides Browser, Page, CDP, and action APIs for applications,
Flightplan, the native CLI, and optional shell integrations. Browser behavior
and action receipts are shared; each consumer supplies its own orchestration.

## Connections

```ts
// Node/Bun: environment credentials and local discovery are available.
import { connect } from 'browser-pilot';

const browser = await connect({ provider: 'browserbase' });
```

```ts
// Portable: explicit provider credentials, wsUrl, or providerSession.
import { connectCore } from 'browser-pilot/core';

const browser = await connectCore({ provider: 'browserbase', apiKey, projectId });
```

Both connections expose the same Page operations. `disconnect()` drops the CDP
connection; `close()` also releases the owned provider session. A
`cleanup_pending` release result means cleanup needs another attempt.

## Consumer boundaries

| Consumer | Responsibilities |
|---|---|
| Browser/Page library | CDP connection, page operations, action receipts, provider lifecycle |
| Flightplan | Workflow parsing, orchestration, assertions, retries, and workflow evidence |
| Native CLI | Arguments, daemon/session registry, local discovery, filesystem output |
| Shell core (`browser-pilot/shell`) | Arguments, host session resolution, capability checks, output formatting |
| just-bash adapter (`browser-pilot/just-bash`) | Thin `just-bash` command binding over the shell core |
| Embedding application | Credentials, session scope, storage, and any additional commands |

The shell core covers common interactive operations and has no `just-bash`
dependency; the just-bash adapter is a thin binding over it for hosts using
`just-bash`. Consumers can register additional commands backed by the public
Browser/Page APIs. There is no separate shell browser engine or requirement to
reproduce every native CLI command.

## Optional host contracts

Browser connections do not require a ports bundle. Hosts that need opaque session
handles can use `SessionOwner`; ordinary in-process callers can pass a
`ProviderSession` directly.

- `SessionOwner` holds provider sessions and validates handle generations and leases.
  Credentials and connection URLs stay in the trusted host. Pending cleanup retains
  the session for retry; lease expiry must not prevent release.
- `OperationContext` supplies a signal, deadline, and clock. `ExecutionContext`
  adds the generation used by session hosts. Artifact writes do not need a generation.
- `ArtifactSink` accepts bytes and returns a storage receipt. The optional filesystem
  and memory sinks reject overwrites by default. A pending write receipt means
  completion was not observed before cancellation or deadline.
- `SecretsPort` is optional credential lookup for provider factories. Explicit
  connection credentials remain supported.

`adapters/node` contains the in-process owner and filesystem sink.
`adapters/memory` contains test doubles and memory storage. Hosts may supply their
own implementations. Durable recovery and distributed session ownership belong
to the embedding application.

## Runtime support

`browser-pilot/core` supports explicit cloud/CDP connections without loading local
browser discovery. Node-only operations, including filesystem recording, still
require Node/Bun. Supplying an artifact sink does not redirect batch recording.
The native CLI and daemon remain Node/Bun entrypoints.

Cancellation stops admission of new shell operations and bounds supported waits.
An already-dispatched browser action may have happened; consumers must use its
receipt and must not automatically retry an uncertain mutation.

## Verification

Package tests exercise published exports and shared error identity. Connection
smokes cover Node ESM/CJS and bundled consumers. Focused session tests cover stale
handles and cleanup retries; artifact tests cover concurrent writes. Portable
import tests cover the supported connection graph, not every optional Node feature.
