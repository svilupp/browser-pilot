# browser-pilot in just-bash

Register common browser operations as `bp` commands in a just-bash shell. The
underlying `bp` command logic lives in the shell-agnostic `browser-pilot/shell`
core, which parses arguments, resolves host-owned sessions, calls the shared
browser APIs, and formats results; `browser-pilot/just-bash` is a thin adapter
that binds that core to a `just-bash` `Command`. Applications can register
additional commands using Browser/Page; the adapter does not aim to reproduce
the full native CLI. Hosts embedding a different shell can depend on
`browser-pilot/shell` directly and skip the `just-bash` binding.

## Quick start: Node host

```ts
import { Bash } from 'just-bash';
import { InProcessSessionOwner, nodeClock } from 'browser-pilot/adapters/node';
import { MemoryArtifactSink } from 'browser-pilot/adapters/memory';
import { registerBrowserPilotCommands } from 'browser-pilot/just-bash';

const controller = new AbortController();
const artifacts = MemoryArtifactSink();
const sessionOwner = new InProcessSessionOwner({ leaseMs: 300_000 });
const ports = {
  sessionOwner,
  artifacts,
  clock: nodeClock,
  createContext: () => ({
    signal: controller.signal,
    deadline: nodeClock.now() + 60_000,
    generation: 'host-run-1',
    clock: nodeClock,
  }),
  capabilities: { read: true, evaluate: false, action: false, webmcp: false },
};

const bash = new Bash({ customCommands: registerBrowserPilotCommands(ports) });
// The owner reads BROWSERBASE_API_KEY from the trusted Node environment.
await bash.exec('bp session open --provider browserbase > /session.json');
await bash.exec('bp goto --handle-file /session.json https://example.com');
await bash.exec('bp text --handle-file /session.json --format text');
await bash.exec('bp session close --handle-file /session.json');
```

For a portable host, supply your own `SessionOwner` and clock. Keep provider
credentials and resolved WebSocket URLs inside that host. Session handles are
JSON references; the owner must validate stored generation and lease state,
including when a caller edits the handle JSON. Expired sessions can still be
released. A `cleanup_pending` result requires another release attempt.

`InProcessSessionOwner` keeps state in memory; it does not survive process restart.
Durable session recovery is the embedding application's responsibility.

The built-in owner creates Browserbase sessions with `keepAlive: true` so they
survive command disconnects; disabling it is rejected. Browserbase requires a
[paid plan for keep-alive](https://docs.browserbase.com/platform/browser/long-sessions/overview).
Run `bp session close` when finished; a handle lease does not stop the remote browser.

The built-in owner rejects Browserless launch URLs because each connection starts
a new browser. Browserless requires a custom `SessionOwner` that manages its
[reconnection endpoint and lifetime](https://docs.browserless.io/examples/reconnect).

For an existing CDP endpoint, configure
`new InProcessSessionOwner({ genericWsUrl: trustedWsUrl })` in the host, then use
`bp session open --provider generic`. The endpoint stays in the host; shell
commands receive only the handle. Custom owners may resolve their own endpoints.

## Operations

| Operation | Command |
|---|---|
| Lifecycle | `session open`, `session close`, `session touch` |
| Navigation and pages | `goto`, `tabs`; select a page with `--target ID` |
| Inspection | `inspect`, `text`, `screenshot` |
| Input | `click`, `type`, `press` |
| Evaluation | `eval` |
| Page tools | `webmcp list`, `webmcp call` |

Pass handles inline or with `--handle-file FILE`; `--handle-file -` reads stdin.
List targets with `bp tabs`, then pass the same `--target ID` to successive page
operations. Explicit targets avoid choosing another page after navigation or a
popup. Commands disconnect their CDP connection after use; they release the
provider session only through `session close`.

Use CSS, role, or text selectors across shell commands. Snapshot `ref:eN` values
belong to a Page instance; the default adapter reconnects for each command and
does not retain its ref map. Hosts that need cross-command refs can supply a
connection factory that restores `Page.exportRefMap()` / `Page.importRefMap()`,
scoped to the session, target, and document. The native CLI already manages its
own ref persistence.

```bash
bp tabs --handle-file /session.json
bp inspect --handle-file /session.json --target TARGET_ID
bp click --handle-file /session.json --target TARGET_ID '#submit'
bp screenshot --handle-file /session.json --target TARGET_ID --out result.png
```

The screenshot destination belongs to `ArtifactSink`. It becomes a shell VFS file
only if the host's sink writes it there. The memory sink above stores it in
`artifacts.store`; `NodeArtifactSink({ root })` writes to a scoped host directory.

## Capabilities and results

| Capability | Operations |
|---|---|
| `read` | Session lifecycle, navigation, inspection, text, screenshot |
| `evaluate` | JavaScript evaluation |
| `action` | Click, type, press |
| `webmcp` | Page tool discovery and calls |

Grant only the capabilities needed by the shell. `read` includes navigation and
session creation; it is not a promise that no remote state can change. Mutating
WebMCP calls require `--confirm-mutation`.

Actions use browser-pilot's dispatch states and receipts. An uncertain result
must not be automatically retried. Cancellation and deadlines stop admission of
new work. Navigation, click, and type receive the remaining deadline as their
Page timeout. Reads and evaluation report exit 124 (deadline) or 130 (cancellation)
if the budget ends before completion. These are cooperative limits; they do not
interrupt every in-flight Page operation or undo effects already sent to the
browser. Action and artifact receipts remain available even when the budget ends.

Stale handles and expired leases report exit 2. Missing host capabilities report
exit 3. Session release remains available after cancellation or lease expiry.

JSON is the default output. `text --format text` emits text, and
`tabs --format text` emits tab-separated rows. Pipes and redirection receive
complete output. `limits.maxOutputBytes` is a hard per-stream cap (default 1 MiB,
minimum 32 bytes). Exceeding it returns `{"error":"output_limit"}` on stderr and
a nonzero exit code, with no partial stdout. Apply display truncation in the host
after `bash.exec()` returns. The cap is checked after execution, so an output
failure does not make a mutating command safe to retry.
Screenshots use the artifact sink and return a size/hash/reference receipt.
A pending write retains its receipt and exits 124, or 130 if cancelled; the
destination may still change afterward. Session cleanup that remains pending
exits 1 and retains its handle for a later release attempt.

Run `bp --help` or `bp COMMAND --help` for arguments and exit codes.

## Extending the shell

Add custom commands alongside `registerBrowserPilotCommands(ports)`, or use
`addBrowserPilotCommands(bash, ports)` on an existing shell. Commands outside the
built-in subset can call the same public Browser/Page APIs used by the CLI and
Flightplan. Keep application-specific workflows in the application.

`ports.connect` optionally supplies the connection factory, for embedding or
tests. Its result provides the browser/page operations used by this adapter.
`SessionOwner` controls lifecycle; the connection factory only detaches its socket.
The just-bash dependency is an optional peer and only its types are imported;
`browser-pilot/shell` has no dependency on `just-bash` at all.

Daemon/local discovery, filesystem recording, audio, and native environment
persistence remain native CLI features. Batch execution and advanced Page APIs
remain available to library consumers without corresponding built-in shell commands.
