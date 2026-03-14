#!/usr/bin/env bun
/**
 * browser-pilot CLI - automation-first browser workflows for agents
 */

import { actionsCommand } from './commands/actions.ts';
import { audioCommand } from './commands/audio.ts';
import { cleanCommand } from './commands/clean.ts';
import { closeCommand } from './commands/close.ts';
import { connectCommand } from './commands/connect.ts';
import { daemonCommand } from './commands/daemon.ts';
import { diagnoseCommand } from './commands/diagnose.ts';
import { envCommand } from './commands/env.ts';
import { evalCommand } from './commands/eval.ts';
import { execCommand } from './commands/exec.ts';
import { formsCommand } from './commands/forms.ts';
import { listCommand } from './commands/list.ts';
import { pageCommand } from './commands/page.ts';
import { quickstartCommand } from './commands/quickstart.ts';
import { recordCommand } from './commands/record.ts';
import { runCommand } from './commands/run.ts';
import { screenshotCommand } from './commands/screenshot.ts';
import { snapshotCommand } from './commands/snapshot.ts';
import { targetsCommand } from './commands/targets.ts';
import { textCommand } from './commands/text.ts';
import { traceCommand } from './commands/trace.ts';

const HELP = `
bp - automation-first browser CLI for agents

Route the job first:
  Inspect page state              snapshot, page, forms, text, targets, diagnose
  Act in the browser              exec, run
  Capture a human demo            record
  Analyze behavior over time      trace   (listen is a compatibility alias)
  Exercise voice/media            audio
  Change browser conditions       env

Usage:
  bp <command> [options]

Commands:
  quickstart  Getting started guide
  connect     Create a browser session
  exec        Execute high-level actions
  snapshot    Inspect current page with refs
  record      Record a human workflow and derive replayable output
  trace       Inspect and analyze behavior over time (listen alias for live stream)
  audio       Set up/validate/inject/capture voice pipelines
  env         Session and browser-environment controls
  run         Run a workflow file
  page        Compact page overview
  forms       List form controls
  targets     List available browser tabs
  daemon      Manage session daemon
  list        List sessions
  close       Close session
  clean       Clean old sessions and artifacts
  actions     Complete action reference

Golden paths:
  1. Automate a page
     bp connect --provider generic --name dev
     bp snapshot -i -s dev
     bp exec -s dev '[{"action":"click","selector":"ref:e4"}]'

  2. Capture a manual workflow and derive automation
     bp record -s demo --profile automation
     bp record summary demo/recording.json
     bp record derive demo/recording.json -o workflow.json
     bp run workflow.json

  3. Debug a realtime or voice session
     bp trace start -s dev
     bp trace summary -s dev --view ws
     bp audio check -s dev
     bp trace summary -s dev --view voice

  4. Exercise failure modes
     bp env network offline -s dev --duration 10000
     bp trace watch -s dev --view ws --assert profile:reconnect --timeout 15000

Options:
  -s, --session <id>    Session ID
  -f, --format <fmt>    json | pretty (default: pretty)
  --json                Alias for -f json
  --debug               Enable debug logs for CDP transport
  --trace               Legacy alias for --debug
  --dialog <mode>       Handle dialogs: accept | dismiss
  -h, --help            Show help

Notes:
  Start with "record summary" or "trace summary" before opening raw artifacts.
`;

interface GlobalOptions {
  session?: string;
  format?: 'json' | 'pretty';
  trace?: boolean;
  debug?: boolean;
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
    } else if (arg === '--debug' || arg === '--trace') {
      options.debug = true;
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

      case 'trace':
        await traceCommand(remaining, options);
        break;

      case 'audio':
        await audioCommand(remaining, options);
        break;

      case 'env':
        await envCommand(remaining, options);
        break;

      case 'listen':
        // Backward compatibility alias: `listen` → `trace tail`
        await traceCommand(['tail', ...remaining], options);
        break;

      case 'daemon':
        await daemonCommand(remaining, options);
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
