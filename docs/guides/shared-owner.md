# Shared browser owner

These APIs require the prepared browser-pilot 0.8.0 build. The npm release remains 0.7.0 until 0.8.0 is published.

Borrow a named BP session from Node without opening another browser connection. The daemon admits one controller across every logical name for that browser, fences each request, and records unfinished work across daemon restarts.

## Borrow an existing page

```ts
import { borrowNamedSession } from 'browser-pilot/adapters/node';

const lease = await borrowNamedSession({
  session: 'work',
  targetPolicy: 'selected',
  recovery: 'never',
});
try {
  await lease.page.click('#open-order');
  await lease.handback({ targetId: lease.page.targetId });
} finally {
  await lease.detach();
}
```

Create the named session with `bp connect --name work` first. Borrowing requires its live daemon and an existing page. Missing targets, unavailable owners, old protocols and contention fail before workflow actions. Borrowing never opens a replacement browser, reconnects a provider or creates a fallback tab.

| Option | Meaning |
| --- | --- |
| `targetPolicy: 'selected'` | Existing page selected by the named session |
| `targetPolicy: 'exact', targetId` | One exact existing page |
| `recovery: 'never'` | Retain the current owner or fail |
| `signal`, `deadline` | Cancel borrowing; deadline is Unix milliseconds |

`protocolVersion: 1` describes the public borrowing envelope. Daemon wire protocol is version 2. These numbers are independent of the package version.

`borrowNamedSession` returns a raw-compatible `Page` and browser view. Its capabilities explicitly report `nativeAtomic: false`. It grants trusted fenced browser access; it does not enforce a semantic action policy.

## Handback and failure states

Handback closes new operation admission, waits for admitted actions and their CDP messages, verifies the final page, updates the named binding and invalidates cached refs. Concurrent duplicate handbacks return one receipt. A different final target after handback fails. Detach releases only the borrower's connection and grant; the daemon/browser stays alive.

The receipt includes `ownerEpoch`, `targetId`, `bindingRevision`, `observationEpoch`, `refsInvalidated: true` and `pendingActions: 'drained'`. Refresh observations after acquiring the next grant. Never retain snapshot refs across a handback.

Each acquisition has a fresh opaque grant tied to its socket and owner epoch. Requests have increasing sequence numbers. A grant from another socket, an old epoch or a released controller cannot dispatch. Admission tracks complete public Page operations, including the intervals between mouse/key events and observation waits.

A raw CDP timeout has unknown remote outcome. A disconnected unfinished logical action also has unknown outcome. Both quarantine the owner. An unfinished mode0600 journal remains beside the Unix socket across daemon restarts. The owner refuses new grants until a trusted operator reconciles the browser and the external business effect. Do not delete this journal or retry the action to make a run pass. Automated reconciliation is not provided.

Raw CDP callers composing multiple messages into one gesture must use the `daemon.beginOperation` / `daemon.endOperation` scope. Public borrowed Page methods do this automatically. A raw message is otherwise one operation; the daemon cannot infer a caller's larger intent.

## Passive tracing

Compatibility tracing creates a dedicated observer attachment under a controller grant, subscribes to fixed telemetry events for that exact session, then releases action authority. Passive subscriptions cannot dispatch browser commands or inspect other sessions. Strict owner profiles refuse raw telemetry.

Stopping a trace reacquires a fresh grant before removing instrumentation. While another controller is active, cleanup remains pending and retries without interrupting that controller. The owner defers detach of known observer attachments until active work drains. Abrupt process death can leave inert JavaScript wrappers until navigation; detaching a CDP session cannot undo JavaScript already installed in the document.

## Strict owner actions

A trusted Node host can install a policy when launching its owner:

```ts
import { borrowOwnerActions, startOwnerActionDaemon } from 'browser-pilot/adapters/node';

const owner = await startOwnerActionDaemon({
  socketPath,
  cdp, // host's private, already-connected browser CDP client
  daemonId,
  wsUrl, // exact trusted endpoint used to connect cdp; identity is derived internally
  resolveBinding, // validate the named session and return its binding revision
  handback, // persist the exact binding with compare-and-swap
  policy: {
    id: 'dashboard', version: '1', mode: 'enforce',
    allowedActions: ['click', 'fill', 'press'],
    evaluate: trustedGuard,
  },
});
```

The host owns registry persistence, the private browser connection and administrative shutdown. Callbacks and policy are constructor inputs, never client RPC data. `owner.close()` is a trusted administrative transport shutdown; it is not borrower handback or browser cleanup. Standard CLI daemons retain raw compatibility by default. There is no CLI flag that serializes arbitrary policy callbacks into the daemon.

Strict clients use `borrowOwnerActions` with the same session options. It returns `pageTargetId` and a typed `port`; it never constructs or returns a raw Page/CDP facade. Owner identity and capabilities are checked before returning the port.

```ts
const lease = await borrowOwnerActions({ session: 'work', targetPolicy: 'selected' });
try {
  const capabilities = await lease.port.capabilities();
  // Require the assurance your trusted application accepts before proceeding.
  const prepared = await lease.port.prepare({
    pageTargetId: lease.pageTargetId,
    action: { kind: 'click', selector: '#open-order' },
  });
  const approval = await lease.port.authorize({ preparedId: prepared.preparedId });
  if (approval.verdict !== 'allow' || !approval.approvalId) throw new Error(approval.reason);
  const receipt = await lease.port.dispatch({ approvalId: approval.approvalId });
  if (receipt.dispatchState !== 'dispatched') throw new Error(receipt.reason);
  await lease.handback({ targetId: lease.pageTargetId });
} finally {
  await lease.detach();
}
```

Strict mode rejects caller-supplied raw Runtime/Input/CDP commands. Prepared evidence and one-use approvals are owner-issued and grant-bound. Flow restrictions may narrow the host policy; they cannot authorize more actions. Text is suppressed unless the host supplies a trusted redactor. Consult capabilities for supported actions, reads and extraction; unsupported operations fail explicitly.

Native dispatch is serialized and checks the prepared document/element again before input. Page JavaScript can still change the DOM between the check and a native event. This is **not renderer-atomic dispatch**. No automatic downgrade from a renderer-atomic requirement is allowed. External direct CDP connections are outside this daemon's boundary.

## Upgrade compatibility

New clients refuse an old daemon before using browser actions. Old clients may inspect control status but cannot dispatch through a new fenced daemon without owner proofs. Upgrade/restart the owner outside an active workflow. Restarting does not clear uncertain-work journals or replay unfinished actions.

The borrowing API is Node/Unix-only. Portable `ConnectionSessionOwner` remains available for embedding; Workers do not import daemon or filesystem code.
