import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { getSessionLogger, SessionLogger } from '../../src/cli/session-logger';

const SESSION_DIR = join(homedir(), '.browser-pilot', 'sessions');

describe('SessionLogger', () => {
  const testSessionId = `test-session-${Date.now()}`;
  const testSessionDir = join(SESSION_DIR, testSessionId);
  const testLogPath = join(testSessionDir, 'log.jsonl');

  beforeEach(() => {
    // Clean up before each test
    if (fs.existsSync(testLogPath)) {
      fs.unlinkSync(testLogPath);
    }
    if (fs.existsSync(testSessionDir)) {
      fs.rmSync(testSessionDir, { recursive: true });
    }
  });

  afterEach(() => {
    // Clean up after each test
    if (fs.existsSync(testLogPath)) {
      fs.unlinkSync(testLogPath);
    }
    if (fs.existsSync(testSessionDir)) {
      fs.rmSync(testSessionDir, { recursive: true });
    }
  });

  describe('constructor', () => {
    it('creates session directory if it does not exist', () => {
      new SessionLogger(testSessionId);
      expect(fs.existsSync(testSessionDir)).toBe(true);
    });

    it('creates log file on first write', () => {
      const logger = new SessionLogger(testSessionId);
      expect(fs.existsSync(testLogPath)).toBe(false);

      logger.log({ type: 'event' });
      expect(fs.existsSync(testLogPath)).toBe(true);
    });
  });

  describe('log()', () => {
    it('appends one line per call', () => {
      const logger = new SessionLogger(testSessionId);

      logger.log({ type: 'event' });
      logger.log({ type: 'command', cmd: 'click' });
      logger.log({ type: 'error', error: 'test error' });

      const content = fs.readFileSync(testLogPath, 'utf-8').trim();
      const lines = content.split('\n');
      expect(lines.length).toBe(3);
    });

    it('writes valid JSON on each line', () => {
      const logger = new SessionLogger(testSessionId);

      logger.log({ type: 'event' });
      logger.log({ type: 'command', cmd: 'fill' });

      const content = fs.readFileSync(testLogPath, 'utf-8').trim();
      const lines = content.split('\n');

      for (const line of lines) {
        expect(() => JSON.parse(line)).not.toThrow();
      }
    });

    it('increments seq for each entry', () => {
      const logger = new SessionLogger(testSessionId);

      logger.log({ type: 'event' });
      logger.log({ type: 'command', cmd: 'click' });
      logger.log({ type: 'event' });

      const content = fs.readFileSync(testLogPath, 'utf-8').trim();
      const lines = content.split('\n');
      const entries = lines.map((l) => JSON.parse(l));

      expect(entries[0]?.seq).toBe(1);
      expect(entries[1]?.seq).toBe(2);
      expect(entries[2]?.seq).toBe(3);
    });

    it('includes ISO timestamp in ts field', () => {
      const logger = new SessionLogger(testSessionId);
      const before = new Date().toISOString();

      logger.log({ type: 'event' });

      const after = new Date().toISOString();
      const content = fs.readFileSync(testLogPath, 'utf-8').trim();
      const entry = JSON.parse(content);

      expect(entry.ts).toBeDefined();
      expect(typeof entry.ts).toBe('string');
      // Timestamp should be between before and after
      expect(entry.ts >= before).toBe(true);
      expect(entry.ts <= after).toBe(true);
    });

    it('preserves all entry fields', () => {
      const logger = new SessionLogger(testSessionId);

      logger.log({
        type: 'command',
        cmd: 'click',
        args: { selector: '#btn' },
        status: 'success',
        durationMs: 150,
        selectorUsed: '#btn',
        urlBefore: 'https://before.com',
        urlAfter: 'https://after.com',
      });

      const content = fs.readFileSync(testLogPath, 'utf-8').trim();
      const entry = JSON.parse(content);

      expect(entry.type).toBe('command');
      expect(entry.cmd).toBe('click');
      expect(entry.args).toEqual({ selector: '#btn' });
      expect(entry.status).toBe('success');
      expect(entry.durationMs).toBe(150);
      expect(entry.selectorUsed).toBe('#btn');
      expect(entry.urlBefore).toBe('https://before.com');
      expect(entry.urlAfter).toBe('https://after.com');
    });
  });

  describe('logCommand()', () => {
    it('logs successful command', () => {
      const logger = new SessionLogger(testSessionId);

      logger.logCommand('click', { selector: '#btn' }, { success: true }, 100, '0001-click.webp');

      const content = fs.readFileSync(testLogPath, 'utf-8').trim();
      const entry = JSON.parse(content);

      expect(entry.type).toBe('command');
      expect(entry.cmd).toBe('click');
      expect(entry.args).toEqual({ selector: '#btn' });
      expect(entry.status).toBe('success');
      expect(entry.durationMs).toBe(100);
      expect(entry.error).toBeUndefined();
      expect(entry.screenshotFile).toBe('0001-click.webp');
    });

    it('logs failed command with error and hints', () => {
      const logger = new SessionLogger(testSessionId);

      const hints = [
        {
          selector: 'ref:e1',
          reason: 'similar name',
          confidence: 'high' as const,
          element: { ref: 'e1', role: 'button', name: 'Submit' },
        },
      ];

      logger.logCommand(
        'click',
        { selector: '#missing' },
        { success: false, error: 'Element not found', hints },
        200
      );

      const content = fs.readFileSync(testLogPath, 'utf-8').trim();
      const entry = JSON.parse(content);

      expect(entry.status).toBe('failed');
      expect(entry.error).toBe('Element not found');
      expect(entry.hints).toEqual(hints);
    });
  });

  describe('logError()', () => {
    it('logs error with message', () => {
      const logger = new SessionLogger(testSessionId);

      logger.logError(new Error('Something went wrong'));

      const content = fs.readFileSync(testLogPath, 'utf-8').trim();
      const entry = JSON.parse(content);

      expect(entry.type).toBe('error');
      expect(entry.error).toBe('Something went wrong');
    });

    it('logs error with context', () => {
      const logger = new SessionLogger(testSessionId);

      logger.logError(new Error('Failed'), { action: 'fill', selector: '#email' });

      const content = fs.readFileSync(testLogPath, 'utf-8').trim();
      const entry = JSON.parse(content);

      expect(entry.type).toBe('error');
      expect(entry.error).toBe('Failed');
      expect(entry.args).toEqual({ action: 'fill', selector: '#email' });
    });
  });

  describe('getLogPath()', () => {
    it('returns correct log file path', () => {
      const logger = new SessionLogger(testSessionId);
      expect(logger.getLogPath()).toBe(testLogPath);
    });
  });

  describe('getLogStats()', () => {
    it('returns zero stats for empty log', () => {
      const logger = new SessionLogger(testSessionId);
      const stats = logger.getLogStats();

      expect(stats.entries).toBe(0);
      expect(stats.size).toBe(0);
      expect(stats.first).toBeUndefined();
      expect(stats.last).toBeUndefined();
    });

    it('returns correct stats after logging', () => {
      const logger = new SessionLogger(testSessionId);

      logger.log({ type: 'event' });
      logger.log({ type: 'command', cmd: 'click' });
      logger.log({ type: 'event' });

      const stats = logger.getLogStats();

      expect(stats.entries).toBe(3);
      expect(stats.size).toBeGreaterThan(0);
      expect(stats.first).toBeDefined();
      expect(stats.last).toBeDefined();
      expect(stats.first! <= stats.last!).toBe(true);
    });
  });

  describe('tailLog()', () => {
    it('returns empty array for empty log', () => {
      const logger = new SessionLogger(testSessionId);
      const entries = logger.tailLog(5);

      expect(entries).toEqual([]);
    });

    it('returns last n entries', () => {
      const logger = new SessionLogger(testSessionId);

      for (let i = 1; i <= 10; i++) {
        logger.log({ type: 'event', cmd: `event-${i}` });
      }

      const entries = logger.tailLog(5);

      expect(entries.length).toBe(5);
      expect(entries[0]?.seq).toBe(6);
      expect(entries[4]?.seq).toBe(10);
    });

    it('returns all entries when n > total', () => {
      const logger = new SessionLogger(testSessionId);

      logger.log({ type: 'event' });
      logger.log({ type: 'command', cmd: 'click' });

      const entries = logger.tailLog(10);

      expect(entries.length).toBe(2);
    });

    it('returns parsed LogEntry objects', () => {
      const logger = new SessionLogger(testSessionId);

      logger.log({ type: 'command', cmd: 'fill', args: { value: 'test' } });

      const entries = logger.tailLog(1);

      expect(entries.length).toBe(1);
      expect(entries[0]?.type).toBe('command');
      expect(entries[0]?.cmd).toBe('fill');
      expect(entries[0]?.args).toEqual({ value: 'test' });
      expect(entries[0]?.seq).toBe(1);
      expect(entries[0]?.ts).toBeDefined();
    });
  });

  describe('seq persistence', () => {
    it('continues seq from existing log', () => {
      // Create logger and add some entries
      const logger1 = new SessionLogger(testSessionId);
      logger1.log({ type: 'event' });
      logger1.log({ type: 'event' });
      logger1.log({ type: 'event' });

      // Create new logger instance for same session
      const logger2 = new SessionLogger(testSessionId);
      logger2.log({ type: 'command', cmd: 'click' });

      const content = fs.readFileSync(testLogPath, 'utf-8').trim();
      const lines = content.split('\n');
      const lastLine = lines[lines.length - 1];
      expect(lastLine).toBeDefined();
      const lastEntry = JSON.parse(lastLine!);

      expect(lastEntry.seq).toBe(4);
    });
  });
});

describe('getSessionLogger()', () => {
  const testSessionId = `cached-session-${Date.now()}`;
  const testSessionDir = join(SESSION_DIR, testSessionId);

  afterEach(() => {
    if (fs.existsSync(testSessionDir)) {
      fs.rmSync(testSessionDir, { recursive: true });
    }
  });

  it('returns same logger instance for same session', () => {
    const logger1 = getSessionLogger(testSessionId);
    const logger2 = getSessionLogger(testSessionId);

    expect(logger1).toBe(logger2);
  });

  it('returns different logger instances for different sessions', () => {
    const logger1 = getSessionLogger(testSessionId);
    const logger2 = getSessionLogger(`${testSessionId}-2`);

    expect(logger1).not.toBe(logger2);

    // Clean up second session
    const sessionDir2 = join(SESSION_DIR, `${testSessionId}-2`);
    if (fs.existsSync(sessionDir2)) {
      fs.rmSync(sessionDir2, { recursive: true });
    }
  });
});
