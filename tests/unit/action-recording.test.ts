import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BatchExecutor } from '../../src/actions/executor.ts';
import type { StepResult } from '../../src/actions/types.ts';
import { getHighlightLabel, stepToHighlightKind } from '../../src/browser/action-highlight.ts';
import type { Page } from '../../src/browser/page.ts';
import type { RecordingManifest } from '../../src/recording/manifest.ts';
import {
  isSensitiveFieldMetadata,
  REDACTED_VALUE,
  redactValueForRecording,
} from '../../src/recording/redaction.ts';
import { RECORDER_SCRIPT } from '../../src/recording/script.ts';

function createRecordingPage(options: { failClick?: boolean } = {}) {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const evaluateScripts: string[] = [];
  let lastCoordinates: { x: number; y: number } | null = null;
  let lastBoundingBox: { x: number; y: number; width: number; height: number } | null = null;
  let lastTargetMetadata: {
    tagName?: string;
    inputType?: string;
    autocomplete?: string;
    sensitiveValue?: boolean;
  } | null = null;

  const page = {
    calls,
    evaluateScripts,
    targetId: 'page-target-123',
    cdpClient: {
      async send(method: string) {
        calls.push({ method: `cdp:${method}`, args: [] });
        if (method === 'Page.getLayoutMetrics') {
          return {
            cssVisualViewport: { clientWidth: 1440, clientHeight: 900 },
          };
        }
        return {};
      },
    },

    resetLastActionPosition() {
      lastCoordinates = null;
      lastBoundingBox = null;
      lastTargetMetadata = null;
    },

    getLastActionCoordinates() {
      return lastCoordinates;
    },

    getLastActionBoundingBox() {
      return lastBoundingBox;
    },

    getLastActionTargetMetadata() {
      return lastTargetMetadata;
    },

    getLastMatchedSelector() {
      return undefined;
    },

    async url() {
      calls.push({ method: 'url', args: [] });
      return 'https://example.com/account';
    },

    async title() {
      calls.push({ method: 'title', args: [] });
      return 'Example Account';
    },

    async fill(selector: string | string[], value: string, actionOptions?: unknown) {
      calls.push({ method: 'fill', args: [selector, value, actionOptions] });
      lastCoordinates = { x: 120, y: 64 };
      lastBoundingBox = { x: 80, y: 40, width: 200, height: 48 };
      lastTargetMetadata = {
        tagName: 'input',
        inputType: 'password',
        autocomplete: 'current-password',
      };
      return true;
    },

    async click(selector: string | string[], actionOptions?: unknown) {
      calls.push({ method: 'click', args: [selector, actionOptions] });
      if (options.failClick) {
        throw new Error('Click failed');
      }
      lastCoordinates = { x: 320, y: 180 };
      lastBoundingBox = { x: 280, y: 150, width: 80, height: 40 };
      lastTargetMetadata = null;
      return true;
    },

    async screenshot(actionOptions?: unknown) {
      calls.push({ method: 'screenshot', args: [actionOptions] });
      return Buffer.from('mock-image').toString('base64');
    },

    async evaluate(expression: string) {
      calls.push({ method: 'evaluate', args: [expression] });
      evaluateScripts.push(expression);
      return null;
    },
  };

  return page;
}

describe('recording redaction helpers', () => {
  test('flags password fields as sensitive', () => {
    expect(isSensitiveFieldMetadata({ inputType: 'password' })).toBe(true);
  });

  test('flags one-time-code autocomplete as sensitive', () => {
    expect(
      isSensitiveFieldMetadata({
        tagName: 'input',
        inputType: 'text',
        autocomplete: 'section-login one-time-code',
      })
    ).toBe(true);
  });

  test('leaves normal text fields unchanged', () => {
    expect(
      redactValueForRecording('hello@example.com', {
        tagName: 'input',
        inputType: 'email',
        autocomplete: 'email',
      })
    ).toBe('hello@example.com');
  });
});

describe('highlight labels', () => {
  const okResult: StepResult = { index: 0, action: 'fill', success: true, durationMs: 0 };

  test('maps actions to highlight kinds', () => {
    expect(stepToHighlightKind({ action: 'click', index: 0, success: true, durationMs: 0 })).toBe(
      'click'
    );
    expect(stepToHighlightKind({ action: 'wait', index: 0, success: true, durationMs: 0 })).toBe(
      null
    );
  });

  test('redacts sensitive fill values in overlay labels', () => {
    expect(
      getHighlightLabel({ action: 'fill', value: 'supersecret123' }, okResult, {
        inputType: 'password',
      })
    ).toBe(`"${REDACTED_VALUE}"`);
  });

  test('keeps ordinary select labels readable', () => {
    expect(
      getHighlightLabel(
        { action: 'select', value: 'en-GB' },
        { index: 0, action: 'select', success: true, durationMs: 0 },
        { inputType: 'text' }
      )
    ).toBe('en-GB');
  });
});

describe('recording artifacts', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'bp-recording-test-'));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  test('writes screenshots and a redacted manifest for sensitive fields', async () => {
    const page = createRecordingPage();
    const executor = new BatchExecutor(page as unknown as Page);

    const result = await executor.execute(
      [{ action: 'fill', selector: '#password', value: 'supersecret123' }],
      {
        record: {
          outputDir: tempDir,
          sessionId: 'sess-redacted',
        },
      }
    );

    expect(result.success).toBe(true);
    expect(result.recordingManifest).toBe(join(tempDir, 'recording.json'));
    expect(result.steps[0]?.screenshotPath).toBeDefined();
    expect(fs.existsSync(result.steps[0]!.screenshotPath!)).toBe(true);

    const manifest = JSON.parse(
      await readFile(result.recordingManifest!, 'utf-8')
    ) as RecordingManifest;

    expect(manifest.session.id).toBe('sess-redacted');
    expect(manifest.actions).toHaveLength(1);
    expect(manifest.screenshots).toHaveLength(1);
    expect(manifest.actions[0]?.value).toBe(REDACTED_VALUE);
    expect(manifest.actions[0]?.selector).toBe('#password');
    expect(manifest.trace.events.some((event) => event.event === 'action.succeeded')).toBe(true);

    const overlayScript = page.evaluateScripts.find((script) =>
      script.includes('__bp-action-highlight')
    );
    expect(overlayScript).toContain(REDACTED_VALUE);
    expect(overlayScript).not.toContain('supersecret123');
  });

  test('writes a manifest even when execution stops on failure', async () => {
    const page = createRecordingPage({ failClick: true });
    const executor = new BatchExecutor(page as unknown as Page);

    const result = await executor.execute([{ action: 'click', selector: '#submit' }], {
      record: {
        outputDir: tempDir,
        sessionId: 'sess-failure',
      },
    });

    expect(result.success).toBe(false);
    expect(result.stoppedAtIndex).toBe(0);
    expect(result.recordingManifest).toBe(join(tempDir, 'recording.json'));

    const manifest = JSON.parse(
      await readFile(result.recordingManifest!, 'utf-8')
    ) as RecordingManifest;

    expect(manifest.session.id).toBe('sess-failure');
    expect(manifest.actions).toHaveLength(1);
    expect(manifest.actions[0]?.success).toBe(false);
    expect(manifest.trace.events.some((event) => event.event === 'action.failed')).toBe(true);
    expect(fs.existsSync(join(tempDir, 'screenshots', manifest.screenshots[0]!.file))).toBe(true);
  });

  test('accumulates frames across multiple executions', async () => {
    const page = createRecordingPage();
    const executor = new BatchExecutor(page as unknown as Page);

    // First execution: one click
    const result1 = await executor.execute([{ action: 'click', selector: '#btn1' }], {
      record: { outputDir: tempDir, sessionId: 'sess-accum' },
    });
    expect(result1.success).toBe(true);

    const manifest1 = JSON.parse(
      await readFile(join(tempDir, 'recording.json'), 'utf-8')
    ) as RecordingManifest;
    expect(manifest1.actions).toHaveLength(1);

    // Second execution: another click — frames should accumulate
    const result2 = await executor.execute([{ action: 'click', selector: '#btn2' }], {
      record: { outputDir: tempDir, sessionId: 'sess-accum' },
    });
    expect(result2.success).toBe(true);

    const manifest2 = JSON.parse(
      await readFile(join(tempDir, 'recording.json'), 'utf-8')
    ) as RecordingManifest;
    expect(manifest2.actions).toHaveLength(2);
    expect(manifest2.actions[0]?.action).toBe('click');
    expect(manifest2.actions[1]?.action).toBe('click');

    // Both screenshots should exist
    expect(fs.existsSync(join(tempDir, 'screenshots', manifest2.screenshots[0]!.file))).toBe(true);
    expect(fs.existsSync(join(tempDir, 'screenshots', manifest2.screenshots[1]!.file))).toBe(true);

    // Original recordedAt should be preserved
    expect(manifest2.recordedAt).toBe(manifest1.recordedAt);
  });

  test('browser-side recorder script uses the same sensitive-field rules', () => {
    expect(RECORDER_SCRIPT).toContain('one-time-code');
    expect(RECORDER_SCRIPT).toContain('current-password');
    expect(RECORDER_SCRIPT).toContain('cc-number');
  });
});
