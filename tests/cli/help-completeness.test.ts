/**
 * CLI Help Completeness Tests
 *
 * Verifies that CLI help output is complete and self-documenting.
 * Critical for AI agents that read CLI help to understand available commands.
 */

import { describe, expect, test } from 'bun:test';
import { ROOT_HELP_COMMANDS } from '../../src/cli/command-registry.ts';
import { runCLI } from './setup.ts';

function countOccurrences(text: string, needle: string): number {
  return text.split(needle).length - 1;
}

describe('CLI Help Completeness', () => {
  test('bp --help lists all commands', async () => {
    const result = await runCLI(['--help']);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('bp - automation-first browser CLI for agents');

    for (const command of ROOT_HELP_COMMANDS) {
      expect(result.stdout).toContain(command.name);
    }
  });

  test('bp --help shows global options', async () => {
    const result = await runCLI(['--help']);

    expect(result.stdout).toContain('-s');
    expect(result.stdout).toContain('--session');
    expect(result.stdout).toContain('-f');
    expect(result.stdout).toContain('--format');
    expect(result.stdout).toContain('--pretty');
    expect(result.stdout).toContain('--trace');
    expect(result.stdout).toContain('--version');
  });

  test('bp --help excludes command-local exec options', async () => {
    const result = await runCLI(['--help']);

    expect(result.stdout).not.toContain('--dialog');
  });

  test('bp --help shows examples', async () => {
    const result = await runCLI(['--help']);

    expect(result.stdout).toContain('Golden paths:');
    expect(result.stdout).toContain('bp connect');
    expect(result.stdout).toContain('bp exec');
    expect(result.stdout).toContain('bp text');
    expect(result.stdout).toContain('bp review');
  });

  test('bp --help mentions bp actions for reference', async () => {
    const result = await runCLI(['--help']);

    expect(result.stdout).toContain('actions     Complete action reference');
  });

  test('bp --version prints only version and exits 0', async () => {
    const expected = (await Bun.file(new URL('../../package.json', import.meta.url)).json()) as {
      version: string;
    };
    const result = await runCLI(['--version']);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(`${expected.version}\n`);
    expect(result.stderr).toBe('');
  });
});

describe('bp actions Command', () => {
  test('bp actions shows complete action reference', async () => {
    const result = await runCLI(['actions']);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('bp actions - Complete action reference');
  });

  test('bp actions includes all action types', async () => {
    const result = await runCLI(['actions']);

    const requiredActions = [
      '"action": "goto"',
      '"action": "click"',
      '"action": "fill"',
      '"action": "type"',
      '"action": "select"',
      '"action": "check"',
      '"action": "uncheck"',
      '"action": "submit"',
      '"action": "press"',
      '"action": "focus"',
      '"action": "hover"',
      '"action": "scroll"',
      '"action": "wait"',
      '"action": "snapshot"',
      '"action": "screenshot"',
      '"action": "evaluate"',
      '"action": "switchFrame"',
      '"action": "switchToMain"',
    ];

    for (const action of requiredActions) {
      expect(result.stdout).toContain(action);
    }
  });

  test('bp actions includes navigation section', async () => {
    const result = await runCLI(['actions']);

    expect(result.stdout).toContain('NAVIGATION');
    expect(result.stdout).toContain('goto');
    expect(result.stdout).toContain('url');
  });

  test('bp actions includes interaction section', async () => {
    const result = await runCLI(['actions']);

    expect(result.stdout).toContain('INTERACTION');
    expect(result.stdout).toContain('click');
    expect(result.stdout).toContain('fill');
    expect(result.stdout).toContain('Multi-selector');
  });

  test('bp actions includes waiting section', async () => {
    const result = await runCLI(['actions']);

    expect(result.stdout).toContain('WAITING');
    expect(result.stdout).toContain('visible');
    expect(result.stdout).toContain('hidden');
    expect(result.stdout).toContain('attached');
    expect(result.stdout).toContain('detached');
  });

  test('bp actions includes content extraction section', async () => {
    const result = await runCLI(['actions']);

    expect(result.stdout).toContain('CONTENT EXTRACTION');
    expect(result.stdout).toContain('snapshot');
    expect(result.stdout).toContain('screenshot');
    expect(result.stdout).toContain('evaluate');
  });

  test('bp actions includes iframe navigation section', async () => {
    const result = await runCLI(['actions']);

    expect(result.stdout).toContain('IFRAME NAVIGATION');
    expect(result.stdout).toContain('switchFrame');
    expect(result.stdout).toContain('switchToMain');
    expect(result.stdout.toLowerCase()).toContain('cross-origin');
  });

  test('bp actions includes dialog handling section', async () => {
    const result = await runCLI(['actions']);

    expect(result.stdout).toContain('DIALOG HANDLING');
    expect(result.stdout).toContain('--dialog');
    expect(result.stdout).toContain('accept');
    expect(result.stdout).toContain('dismiss');
    expect(result.stdout).toContain('WARNING');
  });

  test('bp actions includes ref selectors section', async () => {
    const result = await runCLI(['actions']);

    expect(result.stdout).toContain('REF SELECTORS');
    expect(result.stdout).toContain('ref:');
    expect(result.stdout).toContain('snapshot');
  });

  test('bp actions includes multi-selector section', async () => {
    const result = await runCLI(['actions']);

    expect(result.stdout).toContain('MULTI-SELECTOR PATTERN');
    expect(result.stdout).toContain('array');
  });

  test('bp actions includes common options', async () => {
    const result = await runCLI(['actions']);

    expect(result.stdout).toContain('COMMON OPTIONS');
    expect(result.stdout).toContain('timeout');
    expect(result.stdout).toContain('optional');
  });

  test('bp actions includes examples', async () => {
    const result = await runCLI(['actions']);

    expect(result.stdout).toContain('EXAMPLES');
    expect(result.stdout).toContain('Login flow');
    expect(result.stdout).toContain('cookie');
  });

  test('bp actions includes selector priority', async () => {
    const result = await runCLI(['actions']);

    expect(result.stdout).toContain('SELECTOR PRIORITY');
    expect(result.stdout).toContain('data-testid');
    expect(result.stdout).toContain('aria-label');
  });

  test('bp actions documents simple timeout wait', async () => {
    const result = await runCLI(['actions']);

    // Simple timeout wait should be documented
    expect(result.stdout).toContain('"action": "wait", "timeout":');
    expect(result.stdout).toContain('Simple delay');
  });

  test('bp actions documents page-level scroll', async () => {
    const result = await runCLI(['actions']);

    // Page-level scroll with direction should be documented
    expect(result.stdout).toContain('"direction"');
    expect(result.stdout).toContain('"amount"');
    expect(result.stdout).toContain('up/down/left/right');
  });
});

describe('Error Messages', () => {
  test('exec without actions suggests bp actions', async () => {
    const result = await runCLI(['exec']);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('bp actions');
  });

  test('exec with invalid JSON suggests bp actions', async () => {
    const result = await runCLI(['exec', 'not-json']);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('bp actions');
  });
});

describe('Command Help', () => {
  test('bp snapshot --help prefers --view and avoids duplicate -f meaning', async () => {
    const result = await runCLI(['snapshot', '--help']);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('--view <type>');
    expect(countOccurrences(result.stdout, '-f, --format')).toBe(1);
    expect(result.stdout).not.toContain('Output format: json | pretty');
  });

  test('bp exec --help documents replay recording options', async () => {
    const result = await runCLI(['exec', '--help']);

    expect(result.exitCode).toBe(0);
    expect(countOccurrences(result.stdout, '-f, --format')).toBe(0);
    expect(result.stdout).toContain('--record');
    expect(result.stdout).toContain('--record-dir');
    expect(result.stdout).toContain('--record-format');
    expect(result.stdout).toContain('--record-quality');
    expect(result.stdout).toContain('--no-highlights');
    expect(result.stdout).toContain('Sensitive fields');
  });

  test('bp connect --help documents recording options', async () => {
    const result = await runCLI(['connect', '--help']);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('--browser-url');
    expect(result.stdout).toContain('--page-url');
    expect(result.stdout).toContain('--channel');
    expect(result.stdout).toContain('--user-data-dir');
    expect(result.stdout).toContain('Auto-connect to local Chrome');
    expect(result.stdout).toContain('--record');
    expect(result.stdout).toContain('--record-format');
    expect(result.stdout).toContain('--record-quality');
    expect(result.stdout).toContain('--no-highlights');
    expect(result.stdout).not.toContain('--new-tab --url');
  });

  test('bp eval --help keeps file input and treats formatting as global long-form only', async () => {
    const result = await runCLI(['eval', '--help']);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('-f, --file <path>');
    expect(result.stdout).toContain('--script');
    expect(result.stdout).toContain('/tmp/bp-probe.js');
    expect(countOccurrences(result.stdout, '-f, --format')).toBe(0);
    expect(result.stdout).toContain('--debug');
  });

  test('bp trace --help distinguishes blocking and bounded background capture', async () => {
    const result = await runCLI(['trace', '--help']);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Foreground/blocking');
    expect(result.stdout).toContain('Background/non-blocking');
    expect(result.stdout).toContain('--background');
    expect(result.stdout).toContain('10 minutes');
    expect(result.stdout).toContain('100 MB');
    expect(result.stdout).toContain('http | ws');
    expect(result.stdout).toContain('status');
    expect(result.stdout).toContain('stop');
  });

  test('bp webmcp --help explains local policy requirements', async () => {
    const result = await runCLI(['webmcp', '--help']);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('#enable-webmcp-testing');
    expect(result.stdout).toContain('same-origin documents are allowed by default');
    expect(result.stdout).toContain('allow="tools"');
  });

  test('bp screenshot --help documents image format without global -f collision', async () => {
    const result = await runCLI(['screenshot', '--help']);

    expect(result.exitCode).toBe(0);
    expect(countOccurrences(result.stdout, '-f, --format')).toBe(1);
    expect(result.stdout).toContain('Image format: png | jpeg | webp');
    expect(result.stdout).not.toContain('Output format: json | pretty');
  });

  test('bp text --help documents --selector only', async () => {
    const result = await runCLI(['text', '--help']);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('--selector <selector>');
    expect(result.stdout).not.toContain('-s, --selector');
  });

  test('bp clean --help documents size-based cleanup', async () => {
    const result = await runCLI(['clean', '--help']);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('--max-size');
    expect(result.stdout).toContain('100MB');
  });
});
