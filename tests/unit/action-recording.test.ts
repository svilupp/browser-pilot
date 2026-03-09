import { describe, expect, test } from 'bun:test';
import {
  getHighlightLabel,
  stepToHighlightKind,
} from '../../src/browser/action-highlight.ts';
import type { RecordingFrame, RecordingManifest } from '../../src/recording/manifest.ts';
import type { RecordOptions, StepResult } from '../../src/actions/types.ts';

describe('stepToHighlightKind', () => {
  test('click → click', () => {
    expect(stepToHighlightKind({ action: 'click', index: 0, success: true, durationMs: 0 })).toBe(
      'click',
    );
  });

  test('fill → fill', () => {
    expect(stepToHighlightKind({ action: 'fill', index: 0, success: true, durationMs: 0 })).toBe(
      'fill',
    );
  });

  test('type → type', () => {
    expect(stepToHighlightKind({ action: 'type', index: 0, success: true, durationMs: 0 })).toBe(
      'type',
    );
  });

  test('select → select', () => {
    expect(
      stepToHighlightKind({ action: 'select', index: 0, success: true, durationMs: 0 }),
    ).toBe('select');
  });

  test('hover → hover', () => {
    expect(stepToHighlightKind({ action: 'hover', index: 0, success: true, durationMs: 0 })).toBe(
      'hover',
    );
  });

  test('goto → navigate', () => {
    expect(stepToHighlightKind({ action: 'goto', index: 0, success: true, durationMs: 0 })).toBe(
      'navigate',
    );
  });

  test('submit → submit', () => {
    expect(
      stepToHighlightKind({ action: 'submit', index: 0, success: true, durationMs: 0 }),
    ).toBe('submit');
  });

  test('focus → focus', () => {
    expect(stepToHighlightKind({ action: 'focus', index: 0, success: true, durationMs: 0 })).toBe(
      'focus',
    );
  });

  test('evaluate → evaluate', () => {
    expect(
      stepToHighlightKind({ action: 'evaluate', index: 0, success: true, durationMs: 0 }),
    ).toBe('evaluate');
  });

  test('press → evaluate', () => {
    expect(stepToHighlightKind({ action: 'press', index: 0, success: true, durationMs: 0 })).toBe(
      'evaluate',
    );
  });

  test('shortcut → evaluate', () => {
    expect(
      stepToHighlightKind({ action: 'shortcut', index: 0, success: true, durationMs: 0 }),
    ).toBe('evaluate');
  });

  test('scroll → scroll', () => {
    expect(
      stepToHighlightKind({ action: 'scroll', index: 0, success: true, durationMs: 0 }),
    ).toBe('scroll');
  });

  test('assertVisible success → assert-pass', () => {
    expect(
      stepToHighlightKind({ action: 'assertVisible', index: 0, success: true, durationMs: 0 }),
    ).toBe('assert-pass');
  });

  test('assertVisible failure → assert-fail', () => {
    expect(
      stepToHighlightKind({ action: 'assertVisible', index: 0, success: false, durationMs: 0 }),
    ).toBe('assert-fail');
  });

  test('wait → null', () => {
    expect(stepToHighlightKind({ action: 'wait', index: 0, success: true, durationMs: 0 })).toBe(
      null,
    );
  });

  test('snapshot → null', () => {
    expect(
      stepToHighlightKind({ action: 'snapshot', index: 0, success: true, durationMs: 0 }),
    ).toBe(null);
  });

  test('forms → null', () => {
    expect(stepToHighlightKind({ action: 'forms', index: 0, success: true, durationMs: 0 })).toBe(
      null,
    );
  });

  test('text → null', () => {
    expect(stepToHighlightKind({ action: 'text', index: 0, success: true, durationMs: 0 })).toBe(
      null,
    );
  });

  test('screenshot → null', () => {
    expect(
      stepToHighlightKind({ action: 'screenshot', index: 0, success: true, durationMs: 0 }),
    ).toBe(null);
  });
});

describe('getHighlightLabel', () => {
  const okResult: StepResult = { index: 0, action: 'click', success: true, durationMs: 0 };
  const failResult: StepResult = { index: 0, action: 'click', success: false, durationMs: 0 };

  test('fill with value → quoted string', () => {
    expect(getHighlightLabel({ action: 'fill', value: 'hello' }, okResult)).toBe('"hello"');
  });

  test('type with value → quoted string', () => {
    expect(getHighlightLabel({ action: 'type', value: 'world' }, okResult)).toBe('"world"');
  });

  test('select with value → unquoted string', () => {
    expect(getHighlightLabel({ action: 'select', value: 'option1' }, okResult)).toBe('option1');
  });

  test('goto with url → url string', () => {
    expect(
      getHighlightLabel({ action: 'goto', url: 'https://example.com' }, okResult),
    ).toBe('https://example.com');
  });

  test('evaluate → JS', () => {
    expect(getHighlightLabel({ action: 'evaluate' }, okResult)).toBe('JS');
  });

  test('press with key → key name', () => {
    expect(getHighlightLabel({ action: 'press', key: 'Enter' }, okResult)).toBe('Enter');
  });

  test('shortcut with combo → combo string', () => {
    expect(getHighlightLabel({ action: 'shortcut', combo: 'Control+a' }, okResult)).toBe(
      'Control+a',
    );
  });

  test('assertText success → checkmark', () => {
    const result: StepResult = { index: 0, action: 'assertText', success: true, durationMs: 0 };
    expect(getHighlightLabel({ action: 'assertText' }, result)).toBe('\u2713');
  });

  test('assertText failure → cross', () => {
    const result: StepResult = { index: 0, action: 'assertText', success: false, durationMs: 0 };
    expect(getHighlightLabel({ action: 'assertText' }, result)).toBe('\u2717');
  });

  test('click → undefined', () => {
    expect(getHighlightLabel({ action: 'click' }, okResult)).toBeUndefined();
  });
});

describe('RecordingManifest type checks', () => {
  test('a valid manifest object satisfies the interface', () => {
    const manifest: RecordingManifest = {
      version: 1,
      recordedAt: '2026-03-09T12:00:00.000Z',
      sessionId: 'sess-abc123',
      startUrl: 'https://example.com',
      endUrl: 'https://example.com/done',
      viewport: { width: 1280, height: 720 },
      format: 'webp',
      quality: 40,
      totalDurationMs: 5000,
      success: true,
      frames: [],
    };

    expect(manifest.version).toBe(1);
    expect(manifest.recordedAt).toBe('2026-03-09T12:00:00.000Z');
    expect(manifest.sessionId).toBe('sess-abc123');
    expect(manifest.startUrl).toBe('https://example.com');
    expect(manifest.endUrl).toBe('https://example.com/done');
    expect(manifest.viewport).toEqual({ width: 1280, height: 720 });
    expect(manifest.format).toBe('webp');
    expect(manifest.quality).toBe(40);
    expect(manifest.totalDurationMs).toBe(5000);
    expect(manifest.success).toBe(true);
    expect(manifest.frames).toEqual([]);
  });

  test('frame fields are all correct types', () => {
    const frame: RecordingFrame = {
      seq: 1,
      timestamp: Date.now(),
      action: 'click',
      selector: '#btn',
      value: 'Submit',
      url: undefined,
      coordinates: { x: 100, y: 200 },
      boundingBox: { x: 90, y: 190, width: 120, height: 40 },
      success: true,
      durationMs: 150,
      screenshot: '001-click.webp',
      pageUrl: 'https://example.com',
      pageTitle: 'Example',
    };

    expect(typeof frame.seq).toBe('number');
    expect(typeof frame.timestamp).toBe('number');
    expect(typeof frame.action).toBe('string');
    expect(typeof frame.selector).toBe('string');
    expect(typeof frame.value).toBe('string');
    expect(frame.coordinates).toEqual({ x: 100, y: 200 });
    expect(frame.boundingBox).toEqual({ x: 90, y: 190, width: 120, height: 40 });
    expect(typeof frame.success).toBe('boolean');
    expect(typeof frame.durationMs).toBe('number');
    expect(typeof frame.screenshot).toBe('string');
    expect(typeof frame.pageUrl).toBe('string');
    expect(typeof frame.pageTitle).toBe('string');
  });
});

describe('RecordOptions defaults', () => {
  test('accepts expected fields', () => {
    const opts: RecordOptions = {
      outputDir: '/tmp/recording',
      format: 'webp',
      quality: 40,
      highlights: true,
      captureBefore: false,
      skipActions: ['wait', 'snapshot', 'forms', 'text'],
    };

    expect(opts.outputDir).toBe('/tmp/recording');
    expect(opts.format).toBe('webp');
    expect(opts.quality).toBe(40);
    expect(opts.highlights).toBe(true);
    expect(opts.captureBefore).toBe(false);
    expect(opts.skipActions).toEqual(['wait', 'snapshot', 'forms', 'text']);
  });

  test('all fields are optional', () => {
    const opts: RecordOptions = {};
    expect(opts.outputDir).toBeUndefined();
    expect(opts.format).toBeUndefined();
    expect(opts.quality).toBeUndefined();
    expect(opts.highlights).toBeUndefined();
    expect(opts.captureBefore).toBeUndefined();
    expect(opts.skipActions).toBeUndefined();
  });
});

describe('StepResult new fields', () => {
  test('timestamp, coordinates, boundingBox, screenshotPath fields exist', () => {
    const result: StepResult = {
      index: 0,
      action: 'click',
      success: true,
      durationMs: 120,
      timestamp: 1741521600000,
      coordinates: { x: 150, y: 300 },
      boundingBox: { x: 140, y: 290, width: 80, height: 30 },
      screenshotPath: '/tmp/recording/001-click.webp',
    };

    expect(result.timestamp).toBe(1741521600000);
    expect(result.coordinates).toEqual({ x: 150, y: 300 });
    expect(result.boundingBox).toEqual({ x: 140, y: 290, width: 80, height: 30 });
    expect(result.screenshotPath).toBe('/tmp/recording/001-click.webp');
  });

  test('new fields are optional', () => {
    const result: StepResult = {
      index: 0,
      action: 'click',
      success: true,
      durationMs: 50,
    };

    expect(result.timestamp).toBeUndefined();
    expect(result.coordinates).toBeUndefined();
    expect(result.boundingBox).toBeUndefined();
    expect(result.screenshotPath).toBeUndefined();
  });
});
