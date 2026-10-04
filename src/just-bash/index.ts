/**
 * just-bash adapter: registers browser-pilot as a `bp` shell command.
 *
 * `just-bash` is an optional peer dependency — only its *types* are imported
 * here, so hosts that never touch this module pay nothing. This module is a
 * thin adapter over the shell-agnostic core in `src/shell/`; the trusted
 * host constructs the ports (SessionOwner holding credentials, ArtifactSink,
 * capability policy) and hands the returned commands to `new Bash({
 * customCommands })` or `bash.registerCommand(...)`.
 */

import type { Command, ResolvedCommandContext } from 'just-bash';
import { type BpIo, type BrowserPilotShellPorts, defaultConnect, runBp } from '../shell/index.ts';

export * from '../shell/index.ts';

/**
 * just-bash `ByteString` packs UTF-8 bytes into a latin1-shaped JS string.
 * Decode without importing the just-bash runtime into this module.
 */
function decodeStdin(stdin: unknown): string {
  const raw = String(stdin ?? '');
  return new TextDecoder().decode(Uint8Array.from(raw, (char) => char.charCodeAt(0)));
}

/**
 * Combine multiple AbortSignals into one that aborts when any input does.
 *
 * `AbortSignal.any` (Node >=20.3) would do this natively, but package.json
 * declares `engines.node >= 18`, so this stays a manual combiner for
 * portability.
 */
function signalScope(signals: AbortSignal[]): { signal: AbortSignal; dispose(): void } {
  const controller = new AbortController();
  const subscriptions: Array<() => void> = [];
  const dispose = () => {
    for (const remove of subscriptions.splice(0)) remove();
  };
  for (const signal of signals) {
    if (signal.aborted) {
      controller.abort(signal.reason);
      break;
    }
    const abort = () => {
      controller.abort(signal.reason);
      dispose();
    };
    signal.addEventListener('abort', abort, { once: true });
    subscriptions.push(() => signal.removeEventListener('abort', abort));
  }
  if (controller.signal.aborted) dispose();
  return { signal: controller.signal, dispose };
}

export function combineAbortSignals(signals: AbortSignal[]): AbortSignal {
  return signalScope(signals).signal;
}

function makeIo(ctx: ResolvedCommandContext): BpIo {
  return {
    stdin: decodeStdin(ctx.stdin),
    readFile: (path) => ctx.fs.readFile(ctx.fs.resolvePath(ctx.cwd, path)),
  };
}

/**
 * Build the `bp` command backed by the host's ports.
 *
 * @example
 * const bash = new Bash({ customCommands: registerBrowserPilotCommands(ports) });
 */
export function registerBrowserPilotCommands(ports: BrowserPilotShellPorts): Command[] {
  const connect = ports.connect ?? defaultConnect;
  return [
    {
      name: 'bp',
      trusted: true,
      async execute(args: string[], ctx: ResolvedCommandContext) {
        const signalScopes: Array<() => void> = [];
        // Cooperative cancellation: combine the shell's signal with the host
        // context signal produced per invocation by ports.createContext().
        const hostPorts: BrowserPilotShellPorts = ctx.signal
          ? {
              ...ports,
              createContext: () => {
                const inner = ports.createContext();
                const shellSignal = ctx.signal;
                if (!shellSignal) return inner;
                const scope = signalScope([inner.signal, shellSignal]);
                signalScopes.push(scope.dispose);
                return { ...inner, signal: scope.signal };
              },
            }
          : ports;
        try {
          const result = await runBp(args, makeIo(ctx), hostPorts, connect);
          return { ...result, stdoutKind: 'text' as const };
        } finally {
          for (const dispose of signalScopes) dispose();
        }
      },
    },
  ];
}

/** Register the `bp` command on an existing just-bash instance. */
export function addBrowserPilotCommands(
  bash: { registerCommand(command: Command): void },
  ports: BrowserPilotShellPorts
): void {
  for (const command of registerBrowserPilotCommands(ports)) bash.registerCommand(command);
}

/** Convenience name for registering owner-backed browser commands. */
export const commandsForJustBash = registerBrowserPilotCommands;
