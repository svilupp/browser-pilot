#!/usr/bin/env bun
/**
 * browser-pilot CLI - Browser automation for AI agents
 *
 * Key workflow:
 *   1. bp snapshot --format text    → Get page with element refs [ref=e4]
 *   2. bp exec '{"selector":"ref:e4",...}'  → Use refs for reliable targeting
 *
 * Commands:
 *   quickstart  Getting started guide
 *   connect     Create browser session
 *   exec        Execute actions (supports --dialog accept|dismiss)
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
import { cleanCommand } from './commands/clean.ts';
import { closeCommand } from './commands/close.ts';
import { connectCommand } from './commands/connect.ts';
import { execCommand } from './commands/exec.ts';
import { listCommand } from './commands/list.ts';
import { quickstartCommand } from './commands/quickstart.ts';
import { screenshotCommand } from './commands/screenshot.ts';
import { snapshotCommand } from './commands/snapshot.ts';
import { textCommand } from './commands/text.ts';

const HELP = `
bp - Browser automation CLI for AI agents

Usage:
  bp <command> [options]

Commands:
  quickstart  Getting started guide (start here!)
  connect     Create browser session
  exec        Execute actions
  snapshot    Get page with element refs
  text        Extract text content
  screenshot  Take screenshot
  close       Close session
  list        List sessions
  clean       Clean up old sessions
  actions     Complete action reference

Options:
  -s, --session <id>    Session ID
  -o, --output <fmt>    json | pretty (default: pretty)
  --trace               Enable debug tracing
  --dialog <mode>       Handle dialogs: accept | dismiss
  -h, --help            Show help

Examples:
  bp connect --provider generic --name dev
  bp exec '{"action":"goto","url":"https://example.com"}'
  bp snapshot --format text
  bp exec '{"action":"click","selector":"ref:e3"}'

Run 'bp quickstart' for CLI workflow guide.
Run 'bp actions' for complete action reference.
`;

interface GlobalOptions {
  session?: string;
  output?: 'json' | 'pretty';
  trace?: boolean;
  help?: boolean;
}

function parseGlobalOptions(args: string[]): { options: GlobalOptions; remaining: string[] } {
  const options: GlobalOptions = {
    output: 'pretty',
  };
  const remaining: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;

    if (arg === '-s' || arg === '--session') {
      options.session = args[++i];
    } else if (arg === '-o' || arg === '--output') {
      options.output = args[++i] as 'json' | 'pretty';
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
  if (format === 'json') {
    console.log(JSON.stringify(data, null, 2));
  } else {
    if (typeof data === 'string') {
      console.log(data);
    } else if (typeof data === 'object' && data !== null) {
      // Pretty print objects
      const { truncated } = prettyPrint(data as Record<string, unknown>);
      if (truncated) {
        console.log('\n(Output truncated. Use -o json for full data)');
      }
    } else {
      console.log(data);
    }
  }
}

function prettyPrint(obj: Record<string, unknown>, indent = 0): { truncated: boolean } {
  const prefix = '  '.repeat(indent);
  let truncated = false;

  for (const [key, value] of Object.entries(obj)) {
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      console.log(`${prefix}${key}:`);
      const result = prettyPrint(value as Record<string, unknown>, indent + 1);
      if (result.truncated) truncated = true;
    } else if (Array.isArray(value)) {
      console.log(`${prefix}${key}: [${value.length} items]`);
      truncated = true;
    } else {
      console.log(`${prefix}${key}: ${value}`);
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

      case 'snapshot':
        await snapshotCommand(remaining, options);
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

main();
