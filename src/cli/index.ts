#!/usr/bin/env bun
/**
 * browser-pilot CLI
 *
 * Usage:
 *   browser-pilot <command> [options]
 *
 * Commands:
 *   connect     Create browser session
 *   exec        Execute actions
 *   snapshot    Get page snapshot
 *   text        Extract text content
 *   screenshot  Take screenshot
 *   close       Close session
 *   list        List sessions
 */

import { closeCommand } from './commands/close.ts';
import { connectCommand } from './commands/connect.ts';
import { execCommand } from './commands/exec.ts';
import { listCommand } from './commands/list.ts';
import { screenshotCommand } from './commands/screenshot.ts';
import { snapshotCommand } from './commands/snapshot.ts';
import { textCommand } from './commands/text.ts';

const HELP = `
bp - browser-pilot CLI

Usage:
  bp <command> [options]

Commands:
  connect     Create or resume browser session
  exec        Execute actions on current session
  snapshot    Get page accessibility snapshot
  text        Extract text content from page
  screenshot  Take screenshot
  close       Close session
  list        List all sessions

Global Options:
  -s, --session <id>    Session ID to use
  -o, --output <fmt>    Output format: json | pretty (default: pretty)
  --trace               Enable execution tracing
  -h, --help            Show this help message

Examples:
  # Connect to a local browser
  bp connect --provider generic --url ws://localhost:9222/devtools/browser/xxx

  # Execute actions
  bp exec '{"action":"goto","url":"https://example.com"}'
  bp exec '[{"action":"fill","selector":"#email","value":"test@example.com"}]'

  # Get snapshot
  bp snapshot --format text

  # Take screenshot
  bp screenshot --output screenshot.png
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
      prettyPrint(data as Record<string, unknown>);
    } else {
      console.log(data);
    }
  }
}

function prettyPrint(obj: Record<string, unknown>, indent = 0): void {
  const prefix = '  '.repeat(indent);

  for (const [key, value] of Object.entries(obj)) {
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      console.log(`${prefix}${key}:`);
      prettyPrint(value as Record<string, unknown>, indent + 1);
    } else if (Array.isArray(value)) {
      console.log(`${prefix}${key}: [${value.length} items]`);
    } else {
      console.log(`${prefix}${key}: ${value}`);
    }
  }
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
