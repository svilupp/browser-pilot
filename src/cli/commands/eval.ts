/**
 * Eval command - Evaluate JavaScript in the browser
 *
 * Convenience wrapper around exec's evaluate action.
 * Eliminates JSON-in-JSON escaping nightmare.
 */

import type { Step } from '../../index.ts';
import { attachSession, resolveSession } from '../attach.ts';
import { output } from '../output.ts';
import { updateSession } from '../session.ts';

const EVAL_HELP = `
bp eval - Evaluate JavaScript in the browser

Convenience wrapper around exec's evaluate action.
No JSON escaping needed -- just pass a JS expression directly.
Use this as an escape hatch after higher-level commands like snapshot, text, review, and exec.

Usage:
  bp eval '<expression>'        Evaluate inline JavaScript
  bp eval -f <file>             Evaluate a saved JavaScript file
  bp eval -f <file> --script    Evaluate an async multi-statement script body
  echo '<expr>' | bp eval       Evaluate from stdin

Local options:
  -f, --file <path>     Read JavaScript from a file
  --wrap                Wrap one expression in an async IIFE
  --script              Wrap input as an async function body (supports const/await/return)

Global options:
  -s, --session <id>    Session to use (default: most recent)
  --json                Output JSON
  --pretty              Output readable text (default)
  --debug               Enable CDP transport debugging
  -h, --help            Show this help

Examples:
  bp eval 'document.title'
  bp eval 'document.querySelectorAll("a").length'
  bp eval -f scrape.js
  bp eval -f /tmp/bp-probe.js --script
  bp eval --wrap 'await fetch("/health").then((r) => r.status)'

File workflow:
  Save longer probes to a temporary .js file to avoid shell quoting and JSON escaping.
  Use plain -f for normal JavaScript programs. Add --script when the file uses
  top-level await or return; the returned value becomes the command result.
`.trimEnd();

interface EvalOptions {
  file?: string;
  wrap?: boolean;
  script?: boolean;
}

function parseEvalArgs(args: string[]): { expression: string | undefined; options: EvalOptions } {
  const options: EvalOptions = {};
  let expression: string | undefined;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '-f' || arg === '--file') {
      options.file = args[++i];
    } else if (arg === '--wrap') {
      options.wrap = true;
    } else if (arg === '--script') {
      options.script = true;
    } else if (!expression && !arg.startsWith('-')) {
      expression = arg;
    }
  }

  return { expression, options };
}

export function normalizeEvalExpression(expression: string, options: EvalOptions = {}): string {
  const trimmed = expression.trim();
  if (options.wrap && options.script) {
    throw new Error('--wrap and --script are mutually exclusive');
  }
  if (options.script) {
    return `(async () => {\n${trimmed}\n})()`;
  }

  const needsWrap = options.wrap || trimmed.includes('=>') || /\bawait\b/.test(trimmed);
  if (!needsWrap) {
    return trimmed;
  }

  if (options.wrap || /\bawait\b/.test(trimmed)) {
    return `(async () => (${trimmed}))()`;
  }

  return `(() => (${trimmed}))()`;
}

export async function evalCommand(
  args: string[],
  globalOptions: { session?: string; format?: 'json' | 'pretty'; trace?: boolean; help?: boolean }
): Promise<void> {
  if (globalOptions.help) {
    console.log(EVAL_HELP);
    return;
  }

  const { expression: argExpression, options: evalOptions } = parseEvalArgs(args);

  let expression: string | undefined = argExpression;

  // Read from file if -f specified
  if (evalOptions.file) {
    const fs = await import('node:fs/promises');
    expression = await fs.readFile(evalOptions.file, 'utf-8');
  }

  // Read from stdin if no expression and stdin is piped
  if (!expression && !process.stdin.isTTY) {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) {
      chunks.push(chunk as Buffer);
    }
    expression = Buffer.concat(chunks).toString('utf-8').trim();
  }

  if (!expression) {
    throw new Error(
      'No expression provided.\n\n' +
        'Usage:\n' +
        "  bp eval 'document.title'\n" +
        '  bp eval -f script.js\n' +
        "  echo 'document.title' | bp eval"
    );
  }

  // Get session
  const session = await resolveSession(globalOptions.session);

  // Connect to browser (lazy — no preflight /json/version check)
  const { browser, page } = await attachSession(session, { trace: globalOptions.trace });

  try {
    const step: Step = {
      action: 'evaluate',
      value: normalizeEvalExpression(expression, evalOptions),
    };
    const result = await page.batch([step]);
    const stepResult = result.steps[0]!;

    if (!stepResult.success) {
      throw new Error(stepResult.error ?? 'Evaluation failed');
    }

    // Output the result
    output(
      globalOptions.format === 'json'
        ? { success: true, result: stepResult.result }
        : stepResult.result,
      globalOptions.format
    );

    await updateSession(session.id, { currentUrl: await page.url() });
  } finally {
    await browser.disconnect();
  }
}
