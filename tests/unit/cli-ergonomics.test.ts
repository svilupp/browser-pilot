import { describe, expect, test } from 'bun:test';
import { normalizeEvalExpression } from '../../src/cli/commands/eval.ts';
import { parseTraceArgs } from '../../src/cli/commands/trace.ts';
import type { CanonicalTraceEvent } from '../../src/trace/model.ts';
import { buildTraceSummary } from '../../src/trace/views.ts';

describe('trace CLI ergonomics', () => {
  test('parses bounded background capture options', () => {
    const options = parseTraceArgs([
      'start',
      '--background',
      '--timeout',
      '30000',
      '--max-mb',
      '12.5',
    ]);

    expect(options).toMatchObject({
      subcommand: 'start',
      background: true,
      timeout: 30000,
      maxBytes: Math.floor(12.5 * 1024 * 1024),
    });
  });

  test('accepts the HTTP trace view and rejects unknown views', () => {
    expect(parseTraceArgs(['summary', '--view', 'http']).view).toBe('http');
    expect(() => parseTraceArgs(['summary', '--view', 'waterfall'])).toThrow(
      'Unsupported trace view: waterfall'
    );
  });

  test('summarizes HTTP URLs and durations', () => {
    const event = (overrides: Partial<CanonicalTraceEvent>): CanonicalTraceEvent => ({
      traceId: 'http-1',
      ts: '2026-08-29T12:00:00.000Z',
      elapsedMs: 0,
      channel: 'http',
      event: 'http.request.sent',
      severity: 'info',
      summary: 'GET https://example.test/api',
      data: { method: 'GET' },
      url: 'https://example.test/api',
      ...overrides,
    });
    const summary = buildTraceSummary(
      [
        event({}),
        event({
          traceId: 'http-2',
          elapsedMs: 125,
          event: 'http.response.finished',
          summary: '200 GET https://example.test/api (125ms)',
          data: { method: 'GET', status: 200, durationMs: 125 },
        }),
      ],
      'http'
    );

    expect(summary).toMatchObject({
      view: 'http',
      sent: 1,
      completed: 1,
      failed: 0,
      slowest: [
        {
          method: 'GET',
          status: 200,
          durationMs: 125,
          url: 'https://example.test/api',
        },
      ],
    });
  });
});

describe('eval file ergonomics', () => {
  test('keeps ordinary statement programs raw', () => {
    expect(normalizeEvalExpression('const x = 2; x + 1')).toBe('const x = 2; x + 1');
  });

  test('wraps async expressions as expressions', () => {
    expect(normalizeEvalExpression('await Promise.resolve(3)', { wrap: true })).toBe(
      '(async () => (await Promise.resolve(3)))()'
    );
  });

  test('wraps saved scripts as async function bodies', () => {
    expect(
      normalizeEvalExpression('const x = await Promise.resolve(2);\nreturn x + 1;', {
        script: true,
      })
    ).toBe('(async () => {\nconst x = await Promise.resolve(2);\nreturn x + 1;\n})()');
  });

  test('rejects conflicting eval wrappers', () => {
    expect(() => normalizeEvalExpression('1', { wrap: true, script: true })).toThrow(
      '--wrap and --script are mutually exclusive'
    );
  });
});
