import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Tests for the `bp run` command's workflow parsing and validation.
 * These tests exercise the file reading + step extraction logic without
 * needing a real browser session (we mock attachSession).
 */

// Mock the attach module so we never need a real browser
const mockBatch = mock(() =>
  Promise.resolve({
    success: true,
    steps: [
      { index: 0, action: 'goto', success: true, durationMs: 50 },
      { index: 1, action: 'click', success: true, durationMs: 30, selector: '#btn' },
    ],
    totalDurationMs: 80,
  })
);

const mockPage = {
  batch: mockBatch,
  url: mock(() => Promise.resolve('https://example.com')),
};

const mockBrowser = {
  close: mock(() => Promise.resolve()),
  disconnect: mock(() => Promise.resolve()),
};

mock.module('../../src/cli/attach.ts', () => ({
  resolveSession: () =>
    Promise.resolve({
      id: 'test-session',
      wsUrl: 'ws://localhost:9222',
      provider: 'generic',
    }),
  attachSession: () =>
    Promise.resolve({
      session: { id: 'test-session' },
      browser: mockBrowser,
      page: mockPage,
    }),
}));

// Mock process.exit to prevent test runner from exiting
const originalExit = process.exit;
let exitCode: number | undefined;
beforeEach(() => {
  exitCode = undefined;
  process.exit = mock((code?: number) => {
    exitCode = code ?? 0;
    throw new Error(`process.exit(${code})`);
  }) as never;
});
afterEach(() => {
  process.exit = originalExit;
  mockBatch.mockClear();
});

// Import after mocking
const { runCommand } = await import('../../src/cli/commands/run.ts');

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'bp-run-test-'));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

describe('bp run', () => {
  describe('workflow parsing', () => {
    test('parses bare array workflow', async () => {
      const steps = [
        { action: 'goto', url: 'https://example.com' },
        { action: 'click', selector: '#btn' },
      ];
      const file = join(tempDir, 'workflow.json');
      await writeFile(file, JSON.stringify(steps));

      try {
        await runCommand([file], { format: 'json' });
      } catch {
        // process.exit throws
      }

      expect(mockBatch).toHaveBeenCalledTimes(1);
      const calledSteps = (mockBatch.mock.calls[0] as unknown[])[0] as Array<{ action: string }>;
      expect(calledSteps).toHaveLength(2);
      expect(calledSteps[0]!.action).toBe('goto');
      expect(calledSteps[1]!.action).toBe('click');
    });

    test('parses { steps: [...] } wrapper', async () => {
      const workflow = {
        steps: [{ action: 'goto', url: 'https://example.com' }, { action: 'snapshot' }],
      };
      const file = join(tempDir, 'workflow.json');
      await writeFile(file, JSON.stringify(workflow));

      try {
        await runCommand([file], { format: 'json' });
      } catch {
        // process.exit throws
      }

      expect(mockBatch).toHaveBeenCalledTimes(1);
      const calledSteps = (mockBatch.mock.calls[0] as unknown[])[0] as Array<{ action: string }>;
      expect(calledSteps).toHaveLength(2);
      expect(calledSteps[0]!.action).toBe('goto');
      expect(calledSteps[1]!.action).toBe('snapshot');
    });

    test('rejects empty steps array', async () => {
      const file = join(tempDir, 'empty.json');
      await writeFile(file, '[]');

      await expect(runCommand([file], {})).rejects.toThrow('non-empty');
    });

    test('rejects empty steps in wrapper', async () => {
      const file = join(tempDir, 'empty-wrapper.json');
      await writeFile(file, JSON.stringify({ steps: [] }));

      await expect(runCommand([file], {})).rejects.toThrow('non-empty');
    });

    test('rejects object without steps array', async () => {
      const file = join(tempDir, 'bad.json');
      await writeFile(file, JSON.stringify({ name: 'test' }));

      await expect(runCommand([file], {})).rejects.toThrow('non-empty');
    });
  });

  describe('validation', () => {
    test('validates steps before execution', async () => {
      const steps = [{ action: 'click' }]; // missing selector
      const file = join(tempDir, 'invalid.json');
      await writeFile(file, JSON.stringify(steps));

      await expect(runCommand([file], {})).rejects.toThrow('missing required "selector"');
      expect(mockBatch).not.toHaveBeenCalled();
    });

    test('rejects unknown actions', async () => {
      const steps = [{ action: 'dance' }];
      const file = join(tempDir, 'unknown.json');
      await writeFile(file, JSON.stringify(steps));

      await expect(runCommand([file], {})).rejects.toThrow('unknown action');
      expect(mockBatch).not.toHaveBeenCalled();
    });

    test('rejects invalid JSON file', async () => {
      const file = join(tempDir, 'bad.json');
      await writeFile(file, 'not json {{{');

      await expect(runCommand([file], {})).rejects.toThrow('Invalid JSON');
    });
  });

  describe('options', () => {
    test('passes onFail option to batch', async () => {
      const steps = [{ action: 'goto', url: 'https://example.com' }];
      const file = join(tempDir, 'workflow.json');
      await writeFile(file, JSON.stringify(steps));

      try {
        await runCommand([file, '--on-fail', 'continue'], { format: 'json' });
      } catch {
        // process.exit throws
      }

      expect(mockBatch).toHaveBeenCalledTimes(1);
      const batchOptions = (mockBatch.mock.calls[0] as unknown[])[1] as Record<string, unknown>;
      expect(batchOptions['onFail']).toBe('continue');
    });

    test('passes timeout option to batch', async () => {
      const steps = [{ action: 'goto', url: 'https://example.com' }];
      const file = join(tempDir, 'workflow.json');
      await writeFile(file, JSON.stringify(steps));

      try {
        await runCommand([file, '--timeout', '5000'], { format: 'json' });
      } catch {
        // process.exit throws
      }

      expect(mockBatch).toHaveBeenCalledTimes(1);
      const batchOptions = (mockBatch.mock.calls[0] as unknown[])[1] as Record<string, unknown>;
      expect(batchOptions['timeout']).toBe(5000);
    });

    test('shows help with --help flag', async () => {
      const logs: string[] = [];
      const origLog = console.log;
      console.log = (...args: unknown[]) => logs.push(args.join(' '));

      await runCommand([], { help: true });

      console.log = origLog;
      expect(logs.join('\n')).toContain('bp run');
      expect(logs.join('\n')).toContain('workflow');
    });

    test('errors when no workflow path given', async () => {
      await expect(runCommand([], {})).rejects.toThrow('No workflow file provided');
    });

    test('errors when file does not exist', async () => {
      await expect(runCommand(['/tmp/nonexistent-bp-test.json'], {})).rejects.toThrow(
        'Cannot read workflow file'
      );
    });
  });

  describe('exit codes', () => {
    test('exits 0 on success', async () => {
      const steps = [{ action: 'goto', url: 'https://example.com' }];
      const file = join(tempDir, 'workflow.json');
      await writeFile(file, JSON.stringify(steps));

      try {
        await runCommand([file], { format: 'json' });
      } catch {
        // process.exit throws
      }

      expect(exitCode).toBe(0);
    });

    test('exits 1 on batch failure', async () => {
      mockBatch.mockImplementationOnce(() =>
        Promise.resolve({
          success: false,
          stoppedAtIndex: 0,
          steps: [
            { index: 0, action: 'click', success: false, durationMs: 30, error: 'Not found' },
          ],
          totalDurationMs: 30,
        })
      );

      const steps = [{ action: 'goto', url: 'https://example.com' }];
      const file = join(tempDir, 'workflow.json');
      await writeFile(file, JSON.stringify(steps));

      try {
        await runCommand([file], { format: 'json' });
      } catch {
        // process.exit throws
      }

      expect(exitCode).toBe(1);
    });
  });
});
