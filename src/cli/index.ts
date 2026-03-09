#!/usr/bin/env bun
/**
 * browser-pilot CLI - Browser automation for AI agents
 *
 * Key workflow:
 *   1. bp snapshot -i               → Get interactive elements with refs ref:e4
 *   2. bp exec '{"selector":"ref:e4",...}'  → Use refs for reliable targeting
 *
 * Commands:
 *   quickstart  Getting started guide
 *   connect     Create browser session
 *   exec        Execute actions (supports --dialog accept|dismiss)
 *   page        Show a compact overview of the current page
 *   forms       List form controls on the current page
 *   targets     List available page tabs in the connected browser
 *   audio       Audio I/O for voice agent testing
 *   snapshot    Get page snapshot with element refs
 *   text        Extract text content
 *   screenshot  Take screenshot
 *   close       Close session
 *   list        List sessions
 *   clean       Clean up old sessions
 *   actions     Complete action reference
 *
 * Run 'bp quickstart' for getting started guide.
 */

import { actionsCommand } from './commands/actions.ts';
import { audioCommand } from './commands/audio.ts';
import { cleanCommand } from './commands/clean.ts';
import { closeCommand } from './commands/close.ts';
import { connectCommand } from './commands/connect.ts';
import { daemonCommand } from './commands/daemon.ts';
import { diagnoseCommand } from './commands/diagnose.ts';
import { evalCommand } from './commands/eval.ts';
import { execCommand } from './commands/exec.ts';
import { formsCommand } from './commands/forms.ts';
import { listCommand } from './commands/list.ts';
import { listenCommand } from './commands/listen.ts';
import { pageCommand } from './commands/page.ts';
import { quickstartCommand } from './commands/quickstart.ts';
import { recordCommand } from './commands/record.ts';
import { runCommand } from './commands/run.ts';
import { screenshotCommand } from './commands/screenshot.ts';
import { snapshotCommand } from './commands/snapshot.ts';
import { targetsCommand } from './commands/targets.ts';
import { textCommand } from './commands/text.ts';

const HELP = `
bp - Browser automation CLI for AI agents

Usage:
  bp <command> [options]

Commands:
  quickstart  Getting started guide (start here!)
  connect     Create browser session
  exec        Execute actions
  eval        Evaluate JavaScript expression
  page        Show a compact page overview
  forms       List form controls on the page
  targets     List available browser tabs
  run         Run a workflow file (JSON steps)
  record      Record browser actions to JSON
  audio       Audio I/O for voice agent testing
  listen      Monitor network traffic (WebSocket/HTTP)
  snapshot    Get page with element refs
  diagnose    Debug element selection issues
  text        Extract text content
  screenshot  Take screenshot
  daemon      Manage daemon processes (status, stop, logs)
  close       Close session
  list        List sessions (--log-path, --log-tail, --info)
  clean       Clean up old sessions
  actions     Complete action reference

Options:
  -s, --session <id>    Session ID
  -f, --format <fmt>    json | pretty (default: pretty)
  --json                Alias for -f json
  --trace               Enable debug tracing
  --dialog <mode>       Handle dialogs: accept | dismiss
  -h, --help            Show help

Examples:
  bp connect --provider generic --name dev
  bp exec '{"action":"goto","url":"https://example.com"}'
  bp snapshot -i
  bp exec '{"action":"click","selector":"ref:e3"}'
  bp eval 'document.title'
  bp audio roundtrip -i prompt.wav --transcribe --silence-timeout 5000

Run 'bp quickstart' for CLI workflow guide.
Run 'bp actions' for complete action reference.
Run 'bp audio --help' for voice agent testing guide.
`;

interface GlobalOptions {
  session?: string;
  format?: 'json' | 'pretty';
  trace?: boolean;
  help?: boolean;
}

export function parseGlobalOptions(args: string[]): {
  options: GlobalOptions;
  remaining: string[];
} {
  const options: GlobalOptions = {
    format: 'pretty',
  };
  const remaining: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;

    if (arg === '-s' || arg === '--session') {
      options.session = args[++i];
    } else if (arg === '-f' || arg === '--format') {
      const nextVal = args[i + 1];
      if (nextVal === 'json' || nextVal === 'pretty') {
        options.format = args[++i] as 'json' | 'pretty';
      } else {
        // Not a known format — pass through as command-specific arg
        // (e.g. `bp snapshot -f interactive`)
        remaining.push(arg);
      }
    } else if (arg === '--json') {
      options.format = 'json';
    } else if (arg === '--pretty') {
      options.format = 'pretty';
    } else if (arg === '--trace') {
      options.trace = true;
    } else if (arg === '-h' || arg === '--help') {
      options.help = true;
    } else {
      remaining.push(arg);
    }
  }

  return { options, remaining };
}

export function output(data: unknown, format: 'json' | 'pretty' = 'pretty'): void {
  const text = renderOutput(data, format);
  process.stdout.write(text.endsWith('\n') ? text : `${text}\n`);
}

export function renderOutput(data: unknown, format: 'json' | 'pretty' = 'pretty'): string {
  if (format === 'json') {
    return JSON.stringify(data, null, 2);
  }

  if (typeof data === 'string') {
    return data;
  }

  if (Array.isArray(data)) {
    return JSON.stringify(data, null, 2);
  }

  if (typeof data === 'object' && data !== null) {
    const lines: string[] = [];
    const { truncated } = prettyPrint(data as Record<string, unknown>, lines);
    if (truncated) {
      lines.push('', '(Output truncated. Use --json for full data)');
    }
    return lines.join('\n');
  }

  return String(data);
}

function prettyPrint(
  obj: Record<string, unknown>,
  lines: string[],
  indent = 0
): { truncated: boolean } {
  const prefix = '  '.repeat(indent);
  let truncated = false;

  for (const [key, value] of Object.entries(obj)) {
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      lines.push(`${prefix}${key}:`);
      const result = prettyPrint(value as Record<string, unknown>, lines, indent + 1);
      if (result.truncated) truncated = true;
    } else if (Array.isArray(value)) {
      lines.push(`${prefix}${key}: [${value.length} items]`);
      truncated = true;
    } else {
      lines.push(`${prefix}${key}: ${value}`);
    }
  }

  return { truncated };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.length === 0) {
    console.log(HELP);
    process.exit(0);
  }

  const command = args[0];
  const { options, remaining } = parseGlobalOptions(args.slice(1));

  if (options.help && !command) {
    console.log(HELP);
    process.exit(0);
  }

  try {
    switch (command) {
      case 'quickstart':
        await quickstartCommand();
        break;

      case 'connect':
        await connectCommand(remaining, options);
        break;

      case 'exec':
        await execCommand(remaining, options);
        break;

      case 'eval':
        await evalCommand(remaining, options);
        break;

      case 'page':
        await pageCommand(remaining, options);
        break;

      case 'forms':
        await formsCommand(remaining, options);
        break;

      case 'targets':
        await targetsCommand(remaining, options);
        break;

      case 'snapshot':
        await snapshotCommand(remaining, options);
        break;

      case 'diagnose':
        await diagnoseCommand(remaining, options);
        break;

      case 'text':
        await textCommand(remaining, options);
        break;

      case 'screenshot':
        await screenshotCommand(remaining, options);
        break;

      case 'daemon':
        await daemonCommand(remaining, options);
        break;

      case 'close':
        await closeCommand(remaining, options);
        break;

      case 'list':
        await listCommand(remaining, options);
        break;

      case 'clean':
        await cleanCommand(remaining, options);
        break;

      case 'actions':
        await actionsCommand();
        break;

      case 'run':
        await runCommand(remaining, options);
        break;

      case 'record':
        await recordCommand(remaining, options);
        break;

      case 'audio':
        await audioCommand(remaining, options);
        break;

      case 'listen':
        await listenCommand(remaining, options);
        break;

      case 'help':
      case '--help':
      case '-h':
        console.log(HELP);
        break;

      default:
        console.error(`Unknown command: ${command}`);
        console.log(HELP);
        process.exit(1);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Error: ${message}`);
    process.exit(1);
  }
}

// Only run when executed directly (not when imported for testing)
if (import.meta.main) {
  void main();
}
