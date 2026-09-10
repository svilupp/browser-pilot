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
export function combineAbortSignals(signals: AbortSignal[]): AbortSignal {
  const controller = new AbortController();
  for (const signal of signals) {
    if (signal.aborted) {
      controller.abort(signal.reason);
      break;
    }
  }
  if (!controller.signal.aborted) {
    for (const signal of signals) {
      signal.addEventListener('abort', () => controller.abort(signal.reason), { once: true });
    }
  }
  return controller.signal;
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
        // Cooperative cancellation: combine the shell's signal with the host
        // context signal produced per invocation by ports.createContext().
        const hostPorts: BrowserPilotShellPorts = ctx.signal
          ? {
              ...ports,
              createContext: () => {
                const inner = ports.createContext();
                const shellSignal = ctx.signal;
                return shellSignal
                  ? { ...inner, signal: combineAbortSignals([inner.signal, shellSignal]) }
                  : inner;
              },
            }
          : ports;
        const result = await runBp(args, makeIo(ctx), hostPorts, connect);
        return { ...result, stdoutKind: 'text' as const };
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
