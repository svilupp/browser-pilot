#!/usr/bin/env bun
/**
 * browser-pilot CLI - Browser automation for AI agents
 *
 * Key workflow:
 *   1. bp snapshot --format text    → Get page with element refs [ref=e4]
 *   2. bp exec '{"selector":"ref:e4",...}'  → Use refs for reliable targeting
 *
 * Commands:
 *   connect     Create browser session
 *   exec        Execute actions (supports --dialog accept|dismiss)
 *   snapshot    Get page snapshot with element refs
 *   text        Extract text content
 *   screenshot  Take screenshot
 *   close       Close session
 *   list        List sessions
 *   actions     Complete action reference
 *
 * Run 'bp actions' for full action DSL documentation.
 */

import { actionsCommand } from './commands/actions.ts';
import { closeCommand } from './commands/close.ts';
import { connectCommand } from './commands/connect.ts';
import { execCommand } from './commands/exec.ts';
import { listCommand } from './commands/list.ts';
import { screenshotCommand } from './commands/screenshot.ts';
import { snapshotCommand } from './commands/snapshot.ts';
import { textCommand } from './commands/text.ts';

const HELP = `
bp - Browser automation CLI for AI agents

Usage:
  bp <command> [options]

Commands:
  connect     Create or resume browser session
  exec        Execute actions on current session
  snapshot    Get page accessibility snapshot (includes element refs)
  text        Extract text content from page
  screenshot  Take screenshot
  close       Close session
  list        List all sessions
  actions     Show all available actions with examples

Global Options:
  -s, --session <id>    Session ID to use
  -o, --output <fmt>    Output format: json | pretty (default: pretty)
  --trace               Enable execution tracing
  -h, --help            Show this help message

Exec Options:
  --dialog <mode>       Auto-handle dialogs: accept | dismiss

Ref Selectors (Recommended for AI Agents):
  1. Take snapshot:     bp snapshot --format text
     Output shows:      button "Submit" [ref=e4], textbox "Email" [ref=e5]
  2. Use ref directly:  bp exec '{"action":"click","selector":"ref:e4"}'

  Refs are stable until navigation. Combine with CSS fallbacks:
    {"selector": ["ref:e4", "#submit", "button[type=submit]"]}

Examples:
  # Connect to browser
  bp connect --provider generic --name dev

  # Navigate and get snapshot with refs
  bp exec '{"action":"goto","url":"https://example.com"}'
  bp snapshot --format text

  # Use ref from snapshot (most reliable)
  bp exec '{"action":"click","selector":"ref:e4"}'
  bp exec '{"action":"fill","selector":"ref:e5","value":"test@example.com"}'

  # Handle native dialogs (alert/confirm/prompt)
  bp exec --dialog accept '{"action":"click","selector":"#delete-btn"}'

  # Batch multiple actions
  bp exec '[
    {"action":"fill","selector":"ref:e5","value":"user@example.com"},
    {"action":"click","selector":"ref:e4"},
    {"action":"snapshot"}
  ]'

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
