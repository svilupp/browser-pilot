/**
 * CLI Help Completeness Tests
 *
 * Verifies that CLI help output is complete and self-documenting.
 * Critical for AI agents that read CLI help to understand available commands.
 */

import { describe, expect, test } from 'bun:test';
import { runCLI } from './setup';

describe('CLI Help Completeness', () => {
  test('bp --help lists all commands', async () => {
    const result = await runCLI(['--help']);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('bp - Browser automation CLI');

    // All commands should be listed
    const requiredCommands = [
      'connect',
      'exec',
      'snapshot',
      'text',
      'screenshot',
      'close',
      'list',
      'actions',
    ];

    for (const cmd of requiredCommands) {
      expect(result.stdout).toContain(cmd);
    }
  });

  test('bp --help shows global options', async () => {
    const result = await runCLI(['--help']);

    expect(result.stdout).toContain('-s');
    expect(result.stdout).toContain('--session');
    expect(result.stdout).toContain('-o');
    expect(result.stdout).toContain('--output');
    expect(result.stdout).toContain('--trace');
  });

  test('bp --help shows --dialog option under Exec Options', async () => {
    const result = await runCLI(['--help']);

    expect(result.stdout).toContain('--dialog');
    expect(result.stdout).toContain('accept');
    expect(result.stdout).toContain('dismiss');
  });

  test('bp --help shows examples', async () => {
    const result = await runCLI(['--help']);

    expect(result.stdout).toContain('Examples:');
    expect(result.stdout).toContain('bp connect');
    expect(result.stdout).toContain('bp exec');
  });

  test('bp --help mentions bp actions for reference', async () => {
    const result = await runCLI(['--help']);

    expect(result.stdout).toContain("'bp actions'");
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
