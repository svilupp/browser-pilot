/**
 * just-bash adapter: registers browser-pilot as a `bp` shell command.
 *
 * `just-bash` is an optional peer dependency — only its *types* are imported
 * here, so hosts that never touch this module pay nothing. The trusted host
 * constructs the ports (SessionOwner holding credentials, ArtifactSink,
 * capability policy) and hands the returned commands to `new Bash({
 * customCommands })` or `bash.registerCommand(...)`.
 */

import type { Command, ResolvedCommandContext } from 'just-bash';
import { type BpIo, runBp } from './app.ts';
import { defaultConnect } from './default-connect.ts';
import type { BrowserPilotJustBashPorts } from './types.ts';

export type { BpIo } from './app.ts';
export { runBp } from './app.ts';
export { parseArgs } from './args.ts';
export { helpText } from './help.ts';
export {
  type ActionReceipt,
  type ArtifactPutResult,
  type ArtifactSink,
  CapabilityError,
  type Clock,
  type CreateSessionOptions,
  type DispatchState,
  type ExecutionContext,
  type ProviderReleaseResult,
  type SessionHandle,
  type SessionOpenOptions,
  type SessionOwner,
} from './ports.ts';
export type {
  BpBrowser,
  BpPage,
  BpPageOptions,
  BpRunResult,
  BpTargetInfo,
  BrowserPilotCapabilities,
  BrowserPilotJustBashPorts,
  BrowserPilotLimits,
  ConnectFn,
} from './types.ts';

/**
 * just-bash `ByteString` packs UTF-8 bytes into a latin1-shaped JS string.
 * Decode without importing the just-bash runtime into this module.
 */
function decodeStdin(stdin: unknown): string {
  const raw = String(stdin ?? '');
  return new TextDecoder().decode(Uint8Array.from(raw, (char) => char.charCodeAt(0)));
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
export function registerBrowserPilotCommands(ports: BrowserPilotJustBashPorts): Command[] {
  const connect = ports.connect ?? defaultConnect;
  return [
    {
      name: 'bp',
      trusted: true,
      async execute(args: string[], ctx: ResolvedCommandContext) {
        // Cooperative cancellation: combine the shell's signal with the host
        // context signal produced per invocation by ports.createContext().
        const hostPorts: BrowserPilotJustBashPorts = ctx.signal
          ? {
              ...ports,
              createContext: () => {
                const inner = ports.createContext();
                const shellSignal = ctx.signal;
                return shellSignal
                  ? { ...inner, signal: AbortSignal.any([inner.signal, shellSignal]) }
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
  ports: BrowserPilotJustBashPorts
): void {
  for (const command of registerBrowserPilotCommands(ports)) bash.registerCommand(command);
}
