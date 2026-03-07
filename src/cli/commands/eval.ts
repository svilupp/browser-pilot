/**
 * Eval command - Evaluate JavaScript in the browser
 *
 * Convenience wrapper around exec's evaluate action.
 * Eliminates JSON-in-JSON escaping nightmare.
 */

import type { Step } from '../../index.ts';
import { attachSession, resolveSession } from '../attach.ts';
import { output } from '../index.ts';
import { updateSession } from '../session.ts';

const EVAL_HELP = `
bp eval - Evaluate JavaScript in the browser

Convenience wrapper around exec's evaluate action.
No JSON escaping needed -- just pass a JS expression directly.

Usage:
  bp eval '<expression>'        Evaluate inline JavaScript
  bp eval -f <file>             Evaluate JavaScript from a file
  echo '<expr>' | bp eval       Evaluate from stdin

Options:
  -f, --file <path>    Read JavaScript from a file
  -s, --session <id>   Session to use (default: most recent)
  -f, --format <fmt>   Output format: json | pretty (default: pretty)
  --json               Alias for -f json
  --trace              Enable debug tracing
  -h, --help           Show this help

Examples:
  bp eval 'document.title'
  bp eval 'document.querySelectorAll("a").length'
  bp eval -f scrape.js
`.trimEnd();

interface EvalOptions {
  file?: string;
}

function parseEvalArgs(args: string[]): { expression: string | undefined; options: EvalOptions } {
  const options: EvalOptions = {};
  let expression: string | undefined;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '-f' || arg === '--file') {
      options.file = args[++i];
    } else if (!expression && !arg.startsWith('-')) {
      expression = arg;
    }
  }

  return { expression, options };
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
    const step: Step = { action: 'evaluate', value: expression };
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
