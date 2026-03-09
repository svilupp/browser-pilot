/**
 * Exec command - Execute actions on current session
 */

import * as nodeFs from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { type RecordOptions, type Step, validateSteps } from '../../index.ts';
import { attachSession, resolveSession } from '../attach.ts';
import { output, renderOutput } from '../index.ts';
import { updateSession } from '../session.ts';
import { getSessionLogger } from '../session-logger.ts';

const EXEC_HELP = `
bp exec - Execute browser actions on current session

Usage:
  bp exec '<json>'              Execute action(s) from inline JSON
  bp exec -f <file>             Execute action(s) from a JSON file
  echo '<json>' | bp exec       Execute action(s) from stdin

Options:
  -f, --file <path>    Read actions from a JSON file
  -o, --output <path>  Write command output to a file instead of stdout
  --dialog <mode>      Handle native dialogs: accept | dismiss
  -s, --session <id>   Session to use (default: most recent)
  -f, --format <fmt>   Output format: json | pretty (default: pretty)
  --json               Alias for -f json
  --trace              Enable debug tracing

Recording:
  --record                    Enable screenshot recording
  --record-dir <path>         Override screenshot output directory
  --record-format <fmt>       Screenshot format: webp (default), png, jpeg
  --record-quality <n>        Quality 0-100 (default: 40)
  --no-highlights             Disable visual highlights on screenshots

  -h, --help           Show this help

Examples:
  bp exec '{"action":"goto","url":"https://example.com"}'
  bp exec --record '[{"action":"fill","selector":"#email","value":"me@test.com"},{"action":"submit","selector":"form"}]'
  bp exec --dialog accept '{"action":"click","selector":"#delete-btn"}'
  bp exec -f login-steps.json

Run 'bp actions' for the complete action reference.
Run 'bp quickstart' for getting started guide.
`.trimEnd();

interface ExecOptions {
  session?: string;
  output?: 'json' | 'pretty';
  outputFile?: string;
  trace?: boolean;
  dialog?: 'accept' | 'dismiss';
  record?: boolean;
  recordDir?: string;
  recordFormat?: 'png' | 'jpeg' | 'webp';
  recordQuality?: number;
  noHighlights?: boolean;
}

function parseExecArgs(args: string[]): {
  actionsJson: string | undefined;
  options: ExecOptions & { file?: string };
} {
  const options: ExecOptions & { file?: string } = {};
  let actionsJson: string | undefined;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--dialog') {
      const value = args[++i];
      if (value === 'accept' || value === 'dismiss') {
        options.dialog = value;
      } else {
        throw new Error('--dialog must be "accept" or "dismiss"');
      }
    } else if (arg === '-f' || arg === '--file') {
      options.file = args[++i];
    } else if (arg === '-o' || arg === '--output') {
      options.outputFile = args[++i];
    } else if (arg === '--record') {
      options.record = true;
    } else if (arg === '--record-dir') {
      options.recordDir = args[++i];
      options.record = true; // --record-dir implies --record
    } else if (arg === '--record-format') {
      const fmt = args[++i];
      if (fmt !== 'png' && fmt !== 'jpeg' && fmt !== 'webp') {
        throw new Error('--record-format must be "png", "jpeg", or "webp"');
      }
      options.recordFormat = fmt;
      options.record = true;
    } else if (arg === '--record-quality') {
      const q = parseInt(args[++i] ?? '', 10);
      if (Number.isNaN(q) || q < 0 || q > 100) {
        throw new Error('--record-quality must be 0-100');
      }
      options.recordQuality = q;
      options.record = true;
    } else if (arg === '--no-highlights') {
      options.noHighlights = true;
    } else if (!actionsJson && !arg.startsWith('-')) {
      actionsJson = arg;
    }
  }

  return { actionsJson, options };
}

async function getCurrentUrlSafe(
  page: { url(): Promise<string> },
  fallback: string
): Promise<string> {
  try {
    return await page.url();
  } catch {
    return fallback;
  }
}

async function captureFinalUrl(
  page: { url(): Promise<string> },
  steps: Step[],
  fallback: string
): Promise<string> {
  const currentUrl = await getCurrentUrlSafe(page, fallback);
  if (currentUrl !== fallback) {
    return currentUrl;
  }

  const mightNavigate = steps.some((step) => step.action === 'click' || step.action === 'submit');
  if (!mightNavigate) {
    return currentUrl;
  }

  await new Promise((resolve) => setTimeout(resolve, 200));
  return getCurrentUrlSafe(page, currentUrl);
}

/**
 * Mirror recording files to export directory (dual-write pattern)
 */
function mirrorRecordingToExport(recordingManifest: string, exportLogPath: string): void {
  try {
    const sourceDir = dirname(recordingManifest);
    const exportDir = dirname(exportLogPath);

    // Copy recording.json
    const manifestName = basename(recordingManifest);
    const exportManifestPath = join(exportDir, manifestName);
    nodeFs.copyFileSync(recordingManifest, exportManifestPath);

    // Copy screenshots directory
    const sourceScreenshotsDir = join(sourceDir, 'screenshots');
    const exportScreenshotsDir = join(exportDir, 'screenshots');

    if (nodeFs.existsSync(sourceScreenshotsDir)) {
      nodeFs.mkdirSync(exportScreenshotsDir, { recursive: true });
      const files = nodeFs.readdirSync(sourceScreenshotsDir);
      for (const file of files) {
        nodeFs.copyFileSync(join(sourceScreenshotsDir, file), join(exportScreenshotsDir, file));
      }
    }
  } catch (err) {
    console.warn(`[browser-pilot] Failed to mirror recording to export path: ${err}`);
  }
}

export async function execCommand(
  args: string[],
  globalOptions: { session?: string; format?: 'json' | 'pretty'; trace?: boolean; help?: boolean }
): Promise<void> {
  if (globalOptions.help) {
    console.log(EXEC_HELP);
    return;
  }

  // Parse exec-specific options
  let { actionsJson, options: execOptions } = parseExecArgs(args);

  // Read actions from file if -f specified
  if (execOptions.file) {
    const fs = await import('node:fs/promises');
    actionsJson = await fs.readFile(execOptions.file, 'utf-8');
  }

  // Read from stdin if no actions and stdin is piped
  if (!actionsJson && !process.stdin.isTTY) {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) {
      chunks.push(chunk as Buffer);
    }
    actionsJson = Buffer.concat(chunks).toString('utf-8').trim();
  }

  // Validate actions first (doesn't require session - better error message)
  if (!actionsJson) {
    throw new Error(
      'No actions provided. Usage: bp exec \'{"action":"goto","url":"..."}\'\n\nRun \'bp actions\' for complete action reference.'
    );
  }

  let actions: Step | Step[];
  try {
    const parsed: unknown = JSON.parse(actionsJson);
    actions = parsed as Step | Step[];
  } catch {
    const snippet = actionsJson.substring(0, 80);
    const looksLikeEvaluate = /evaluate/i.test(actionsJson);
    const evalTip = looksLikeEvaluate
      ? "\n\nTip: If you truly need raw JavaScript evaluation, use 'bp eval' instead — no JSON wrapping needed:\n  bp eval 'your.expression.here'\nUse high-level actions plus refs first whenever possible."
      : '';
    throw new Error(
      `Invalid JSON: ${snippet}${actionsJson.length > 80 ? '...' : ''}\n\n` +
        "Actions must be valid JSON. Tip: use 'bp exec -f actions.json' for complex steps.\n" +
        `Run 'bp actions' for complete action reference.${evalTip}`
    );
  }

  // Validate step structure before connecting to browser
  const stepsToValidate = Array.isArray(actions) ? actions : [actions];
  const validation = validateSteps(stepsToValidate);
  if (!validation.valid) {
    throw new Error(validation.formatted());
  }

  // Get session (only after actions are validated)
  const session = await resolveSession(globalOptions.session);

  // Get logger for this session (with optional export path)
  const logger = getSessionLogger(session.id, session.exportLog);

  // Build record options if --record is enabled
  let recordOptions: RecordOptions | undefined;
  if (execOptions.record) {
    recordOptions = {
      format: execOptions.recordFormat ?? 'webp',
      quality: execOptions.recordQuality ?? 40,
      highlights: !execOptions.noHighlights,
    };
    if (execOptions.recordDir) {
      recordOptions.outputDir = resolve(execOptions.recordDir);
    } else {
      // Default: session log directory
      const { homedir } = await import('node:os');
      recordOptions.outputDir = join(homedir(), '.browser-pilot', 'sessions', session.id);
    }
  }

  // Connect to browser (lazy — no preflight /json/version check)
  const { browser, page } = await attachSession(session, { trace: globalOptions.trace });

  try {
    // Set up dialog handling if --dialog flag is provided
    if (execOptions.dialog) {
      await page.onDialog(async (dialog) => {
        if (execOptions.dialog === 'accept') {
          await dialog.accept();
        } else {
          await dialog.dismiss();
        }
      });
    }

    // Execute actions
    const steps = Array.isArray(actions) ? actions : [actions];
    const urlBefore = await page.url();
    const currentTargetId = page.targetId;
    const closesCurrentTarget = steps.some(
      (step) => step.action === 'closeTab' && (!step.targetId || step.targetId === currentTargetId)
    );
    const result = await page.batch(steps, {
      record: recordOptions,
    });
    const urlAfter = closesCurrentTarget
      ? urlBefore
      : await captureFinalUrl(page, steps, urlBefore);

    // Log each step result (with optional screenshot reference)
    for (const stepResult of result.steps) {
      logger.logCommand(
        stepResult.action,
        { selector: stepResult.selectorUsed },
        {
          success: stepResult.success,
          error: stepResult.error,
          hints: stepResult.hints,
        },
        stepResult.durationMs,
        stepResult.screenshotPath ? basename(stepResult.screenshotPath) : undefined
      );
    }

    // Mirror recording to export path if configured
    if (result.recordingManifest && session.exportLog) {
      mirrorRecordingToExport(result.recordingManifest, session.exportLog);
    }

    // Log overall execution
    logger.log({
      type: 'event',
      cmd: 'batch',
      args: { stepCount: steps.length, recording: !!recordOptions },
      status: result.success ? 'success' : 'failed',
      durationMs: result.totalDurationMs,
      urlBefore,
      urlAfter,
    });

    // Update session with current URL
    const currentUrl = closesCurrentTarget
      ? urlBefore
      : await captureFinalUrl(page, steps, urlAfter);
    const hasSnapshot = steps.some((step) => step.action === 'snapshot');
    if (closesCurrentTarget) {
      await updateSession(session.id, {
        currentUrl,
        targetId: undefined,
      });
    } else if (hasSnapshot) {
      await updateSession(session.id, {
        currentUrl,
        metadata: {
          refCache: {
            url: currentUrl,
            savedAt: new Date().toISOString(),
            refMap: page.exportRefMap(),
          },
        },
      });
    } else {
      await updateSession(session.id, { currentUrl });
    }

    // Output result
    const outputSteps = result.steps.map((s) => ({
      action: s.action,
      success: s.success,
      durationMs: s.durationMs,
      selectorUsed: s.selectorUsed,
      error: s.error,
      text: s.text,
      result: s.result,
    }));

    const payload = {
      success: result.success,
      stoppedAtIndex: result.stoppedAtIndex,
      steps: outputSteps,
      totalDurationMs: result.totalDurationMs,
      currentUrl,
      ...(result.recordingManifest ? { recordingManifest: result.recordingManifest } : {}),
    };

    if (execOptions.outputFile) {
      const fs = await import('node:fs/promises');
      await fs.writeFile(execOptions.outputFile, renderOutput(payload, globalOptions.format));
      process.stderr.write(`Wrote output to ${execOptions.outputFile}\n`);
    } else {
      output(payload, globalOptions.format);
    }

    // Print recording summary
    if (result.recordingManifest) {
      const frameCount = result.steps.filter((s) => s.screenshotPath).length;
      process.stderr.write(
        `\nRecording: ${frameCount} screenshots saved to ${dirname(result.recordingManifest)}\n`
      );
    }

    // Tip: suggest bp eval only as an escape hatch when evaluate steps fail
    const failedEval = result.steps.find((s) => s.action === 'evaluate' && !s.success);
    if (failedEval) {
      console.error(
        '\nTip: Use "bp eval \'expression\'" for simpler JavaScript inspection/debugging (no JSON escaping needed). Prefer high-level actions for interactions.'
      );
    }
  } finally {
    await browser.disconnect();
  }
}
