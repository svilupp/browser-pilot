/**
 * Run command - Execute a workflow file (JSON array of steps)
 */

import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { Step } from '../../actions/types.ts';
import { validateSteps } from '../../actions/validate.ts';
import { attachSession, resolveSession } from '../attach.ts';

const RUN_HELP = `
bp run - Execute a saved workflow file

When to use:
  You already have reusable steps from \`bp record derive\` or a hand-authored workflow.

When not to use:
  You are exploring a page inline or debugging one interaction. Use \`bp exec\`.

Default flow:
  derive or author workflow -> run -> inspect failures -> harden with assertions

Common mistake:
  Treating \`run\` as discovery. It is for repeatable execution, not first-pass exploration.

Usage:
  bp run <workflow.json> [options]

The workflow file can be:
  - A bare JSON array: [{ "action": "goto", "url": "..." }, ...]
  - A wrapper object:  { "steps": [...] }

Options:
  --on-fail <mode>     How to handle failures: stop | continue (default: stop)
  --timeout <ms>       Default timeout for all steps (ms)
  -s, --session <id>   Session to use (default: most recent)
  --json               Output results as JSON
  --debug              Enable CDP transport debugging (global option)
  -h, --help           Show this help

Examples:
  bp run login-flow.json
  bp run checkout.json --on-fail continue --json
  bp run smoke-test.json --timeout 10000

Likely next commands:
  bp trace summary -s <session> --view console
  bp exec --record -f workflow.json
`.trimEnd();

interface RunOptions {
  session?: string;
  onFail?: 'stop' | 'continue';
  timeout?: number;
  json?: boolean;
  trace?: boolean;
}

function parseRunArgs(args: string[]): {
  workflowPath: string | undefined;
  options: RunOptions;
} {
  const options: RunOptions = {};
  let workflowPath: string | undefined;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--on-fail') {
      const value = args[++i];
      if (value === 'stop' || value === 'continue') {
        options.onFail = value;
      } else {
        throw new Error('--on-fail must be "stop" or "continue"');
      }
    } else if (arg === '--timeout') {
      const value = args[++i];
      const num = Number(value);
      if (Number.isNaN(num) || num <= 0) {
        throw new Error('--timeout must be a positive number');
      }
      options.timeout = num;
    } else if (!workflowPath && !arg.startsWith('-')) {
      workflowPath = arg;
    }
  }

  return { workflowPath, options };
}

export async function runCommand(
  args: string[],
  globalOptions: {
    session?: string;
    format?: 'json' | 'pretty';
    trace?: boolean;
    help?: boolean;
  }
): Promise<void> {
  if (globalOptions.help) {
    console.log(RUN_HELP);
    return;
  }

  const { workflowPath, options: runOptions } = parseRunArgs(args);

  if (!workflowPath) {
    throw new Error(
      "No workflow file provided. Usage: bp run <workflow.json>\n\nRun 'bp run --help' for details."
    );
  }

  // 1. Read and parse workflow file
  const absPath = resolve(workflowPath);
  let raw: string;
  try {
    raw = await readFile(absPath, 'utf-8');
  } catch {
    throw new Error(`Cannot read workflow file: ${absPath}`);
  }

  let workflow: unknown;
  try {
    workflow = JSON.parse(raw);
  } catch {
    throw new Error(`Invalid JSON in workflow file: ${absPath}`);
  }

  // 2. Extract steps — support both { steps: [...] } wrapper and bare [...]
  const steps = Array.isArray(workflow)
    ? workflow
    : workflow &&
        typeof workflow === 'object' &&
        'steps' in workflow &&
        Array.isArray((workflow as Record<string, unknown>)['steps'])
      ? (workflow as Record<string, unknown>)['steps']
      : null;

  if (!Array.isArray(steps) || steps.length === 0) {
    throw new Error(
      'Workflow must contain a non-empty "steps" array or be a non-empty JSON array.'
    );
  }

  // 3. Validate all steps before executing
  const validation = validateSteps(steps);
  if (!validation.valid) {
    throw new Error(validation.formatted());
  }

  const typedSteps = steps as Step[];

  // 4. Attach to session
  const session = await resolveSession(globalOptions.session);
  const { page, browser } = await attachSession(session, {
    trace: globalOptions.trace || runOptions.trace,
  });

  try {
    // 5. Execute batch
    const result = await page.batch(typedSteps, {
      onFail: runOptions.onFail ?? 'stop',
      timeout: runOptions.timeout,
    });

    // 6. Output result
    const isJson = globalOptions.format === 'json';
    if (isJson) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      for (const step of result.steps) {
        const status = step.success ? 'PASS' : 'FAIL';
        const duration = `${step.durationMs}ms`;
        const label = step.selector
          ? `${step.action} ${Array.isArray(step.selector) ? step.selector[0] : step.selector}`
          : step.action;
        console.log(`  ${status}  ${label}  (${duration})`);
        if (!step.success && step.error) {
          console.log(`         ${step.error}`);
        }
        if (step.suggestion) {
          console.log(`         Suggestion: ${step.suggestion}`);
        }
      }
      console.log(
        `\n${result.success ? 'Workflow passed' : 'Workflow failed'} in ${result.totalDurationMs}ms`
      );
    }

    process.exit(result.success ? 0 : 1);
  } finally {
    await browser.close();
  }
}
