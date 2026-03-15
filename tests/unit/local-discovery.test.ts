import { describe, expect, test } from 'bun:test';
import {
  buildLocalBrowserScanTargets,
  discoverLocalBrowsers,
  parseDevToolsActivePortFile,
  resolveBrowserEndpoint,
  resolveChromeUserDataDirs,
} from '../../src/providers/local-discovery.ts';

function missingFile(path: string): NodeJS.ErrnoException {
  const error = new Error(`ENOENT: ${path}`) as NodeJS.ErrnoException;
  error.code = 'ENOENT';
  return error;
}

describe('resolveChromeUserDataDirs', () => {
  test('resolves macOS default channel paths', () => {
    const dirs = resolveChromeUserDataDirs({
      platform: 'darwin',
      homeDir: '/Users/tester',
    });

    expect(dirs).toEqual({
      stable: '/Users/tester/Library/Application Support/Google/Chrome',
      beta: '/Users/tester/Library/Application Support/Google/Chrome Beta',
      dev: '/Users/tester/Library/Application Support/Google/Chrome Dev',
      canary: '/Users/tester/Library/Application Support/Google/Chrome Canary',
    });
  });

  test('prefers CHROME_CONFIG_HOME on Linux', () => {
    const dirs = resolveChromeUserDataDirs({
      platform: 'linux',
      homeDir: '/home/tester',
      env: { CHROME_CONFIG_HOME: '/chrome-config' },
    });

    expect(dirs.stable).toBe('/chrome-config/google-chrome');
    expect(dirs.beta).toBe('/chrome-config/google-chrome-beta');
  });

  test('falls back to XDG_CONFIG_HOME then HOME on Linux', () => {
    const xdgDirs = resolveChromeUserDataDirs({
      platform: 'linux',
      homeDir: '/home/tester',
      env: { XDG_CONFIG_HOME: '/xdg-config' },
    });
    const fallbackDirs = resolveChromeUserDataDirs({
      platform: 'linux',
      homeDir: '/home/tester',
      env: {},
    });

    expect(xdgDirs.dev).toBe('/xdg-config/google-chrome-dev');
    expect(fallbackDirs.canary).toBe('/home/tester/.config/google-chrome-canary');
  });

  test('resolves Windows channel paths from LOCALAPPDATA', () => {
    const dirs = resolveChromeUserDataDirs({
      platform: 'win32',
      homeDir: 'C:\\Users\\tester',
      env: { LOCALAPPDATA: 'C:\\Users\\tester\\AppData\\Local' },
    });

    expect(dirs).toEqual({
      stable: 'C:\\Users\\tester\\AppData\\Local\\Google\\Chrome\\User Data',
      beta: 'C:\\Users\\tester\\AppData\\Local\\Google\\Chrome Beta\\User Data',
      dev: 'C:\\Users\\tester\\AppData\\Local\\Google\\Chrome Dev\\User Data',
      canary: 'C:\\Users\\tester\\AppData\\Local\\Google\\Chrome SxS\\User Data',
    });
  });
});

describe('buildLocalBrowserScanTargets', () => {
  test('explicit userDataDir bypasses channel scanning', () => {
    const targets = buildLocalBrowserScanTargets({
      platform: 'darwin',
      homeDir: '/Users/tester',
      userDataDir: '/tmp/custom-profile',
    });

    expect(targets).toEqual([
      {
        channel: 'custom',
        userDataDir: '/tmp/custom-profile',
        portFile: '/tmp/custom-profile/DevToolsActivePort',
      },
    ]);
  });
});

describe('parseDevToolsActivePortFile', () => {
  test('parses a valid two-line file and trims blank lines', () => {
    expect(parseDevToolsActivePortFile('\n9222\n/devtools/browser/abc-123\n\n')).toEqual({
      port: 9222,
      browserPath: '/devtools/browser/abc-123',
      wsUrl: 'ws://127.0.0.1:9222/devtools/browser/abc-123',
    });
  });

  test('rejects invalid line counts', () => {
    expect(() => parseDevToolsActivePortFile('9222')).toThrow('Expected exactly 2 non-empty lines');
  });

  test('rejects invalid ports', () => {
    expect(() => parseDevToolsActivePortFile('70000\n/devtools/browser/abc')).toThrow(
      'Invalid DevToolsActivePort port'
    );
  });

  test('rejects invalid path prefixes', () => {
    expect(() => parseDevToolsActivePortFile('9222\n/devtools/page/abc')).toThrow(
      'Invalid DevToolsActivePort browser path'
    );
  });

  test('rejects malformed path traversal', () => {
    expect(() => parseDevToolsActivePortFile('9222\n/devtools/browser/../abc')).toThrow(
      'Invalid DevToolsActivePort browser path'
    );
  });
});

describe('discoverLocalBrowsers', () => {
  test('returns a single live candidate when exactly one profile is reachable', async () => {
    const readCalls: string[] = [];
    const result = await discoverLocalBrowsers(
      {
        platform: 'darwin',
        homeDir: '/Users/tester',
      },
      {
        async readTextFile(path) {
          readCalls.push(path);
          if (path.endsWith('/Chrome Beta/DevToolsActivePort')) {
            return '9222\n/devtools/browser/beta-browser';
          }
          throw missingFile(path);
        },
        async probeBrowserWebSocket(wsUrl) {
          return { browserVersion: wsUrl.includes('beta-browser') ? 'Chrome/147.0' : 'unknown' };
        },
        async getLegacyBrowserWebSocketUrl() {
          throw new Error('legacy should not be called');
        },
      }
    );

    expect(readCalls).toHaveLength(4);
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]).toMatchObject({
      channel: 'beta',
      userDataDir: '/Users/tester/Library/Application Support/Google/Chrome Beta',
      wsUrl: 'ws://127.0.0.1:9222/devtools/browser/beta-browser',
      browserVersion: 'Chrome/147.0',
    });
    expect(result.failures).toHaveLength(3);
  });

  test('returns no candidates when no DevToolsActivePort files exist', async () => {
    const result = await discoverLocalBrowsers(
      {
        platform: 'linux',
        homeDir: '/home/tester',
        env: {},
      },
      {
        async readTextFile(path) {
          throw missingFile(path);
        },
        async probeBrowserWebSocket() {
          return {};
        },
        async getLegacyBrowserWebSocketUrl() {
          throw new Error('legacy should not be called');
        },
      }
    );

    expect(result.candidates).toEqual([]);
    expect(result.failures).toHaveLength(4);
    expect(result.failures.every((failure) => failure.reason === 'missing-file')).toBe(true);
  });

  test('explicit channel reduces search scope', async () => {
    const readCalls: string[] = [];

    await discoverLocalBrowsers(
      {
        platform: 'darwin',
        homeDir: '/Users/tester',
        channel: 'beta',
      },
      {
        async readTextFile(path) {
          readCalls.push(path);
          return '9222\n/devtools/browser/beta-browser';
        },
        async probeBrowserWebSocket() {
          return {};
        },
        async getLegacyBrowserWebSocketUrl() {
          throw new Error('legacy should not be called');
        },
      }
    );

    expect(readCalls).toEqual([
      '/Users/tester/Library/Application Support/Google/Chrome Beta/DevToolsActivePort',
    ]);
  });

  test('classifies refused, timeout, and unexpected-close probe failures', async () => {
    const makeResult = async (message: string) =>
      discoverLocalBrowsers(
        {
          platform: 'darwin',
          homeDir: '/Users/tester',
          userDataDir: '/tmp/profile',
        },
        {
          async readTextFile() {
            return '9222\n/devtools/browser/test-browser';
          },
          async probeBrowserWebSocket() {
            throw new Error(message);
          },
          async getLegacyBrowserWebSocketUrl() {
            throw new Error('legacy should not be called');
          },
        }
      );

    await expect(makeResult('connect ECONNREFUSED 127.0.0.1:9222')).resolves.toMatchObject({
      failures: [{ reason: 'connection-refused' }],
    });
    await expect(makeResult('WebSocket connection timeout after 1000ms')).resolves.toMatchObject({
      failures: [{ reason: 'connection-timeout' }],
    });
    await expect(makeResult('WebSocket connection closed')).resolves.toMatchObject({
      failures: [{ reason: 'unexpected-close' }],
    });
  });
});

describe('resolveBrowserEndpoint', () => {
  test('explicit wsUrl wins over all discovery paths', async () => {
    const endpoint = await resolveBrowserEndpoint(
      {
        explicitWsUrl: 'ws://127.0.0.1:9222/devtools/browser/explicit',
      },
      {
        async readTextFile() {
          throw new Error('should not be called');
        },
        async probeBrowserWebSocket() {
          throw new Error('should not be called');
        },
        async getLegacyBrowserWebSocketUrl() {
          throw new Error('should not be called');
        },
      }
    );

    expect(endpoint).toEqual({
      wsUrl: 'ws://127.0.0.1:9222/devtools/browser/explicit',
      source: 'explicit-ws',
    });
  });

  test('local discovery wins over legacy fallback when available', async () => {
    const endpoint = await resolveBrowserEndpoint(
      {
        platform: 'linux',
        homeDir: '/home/tester',
        channel: 'beta',
        env: {},
      },
      {
        async readTextFile() {
          return '9223\n/devtools/browser/local-beta';
        },
        async probeBrowserWebSocket() {
          return { browserVersion: 'Chrome/147.0' };
        },
        async getLegacyBrowserWebSocketUrl() {
          return 'ws://localhost:9222/devtools/browser/legacy';
        },
      }
    );

    expect(endpoint).toEqual({
      wsUrl: 'ws://127.0.0.1:9223/devtools/browser/local-beta',
      source: 'devtools-active-port',
      channel: 'beta',
      userDataDir: '/home/tester/.config/google-chrome-beta',
    });
  });

  test('legacy fallback still works when local discovery finds nothing', async () => {
    const endpoint = await resolveBrowserEndpoint(
      {
        platform: 'linux',
        homeDir: '/home/tester',
        env: {},
      },
      {
        async readTextFile(path) {
          throw missingFile(path);
        },
        async probeBrowserWebSocket() {
          return {};
        },
        async getLegacyBrowserWebSocketUrl() {
          return 'ws://localhost:9222/devtools/browser/legacy';
        },
      }
    );

    expect(endpoint).toEqual({
      wsUrl: 'ws://localhost:9222/devtools/browser/legacy',
      source: 'json-version',
    });
  });

  test('throws a deterministic ambiguity error for multiple live candidates', async () => {
    await expect(
      resolveBrowserEndpoint(
        {
          platform: 'darwin',
          homeDir: '/Users/tester',
        },
        {
          async readTextFile(path) {
            if (path.endsWith('/Chrome/DevToolsActivePort')) {
              return '9222\n/devtools/browser/stable';
            }
            if (path.endsWith('/Chrome Beta/DevToolsActivePort')) {
              return '9333\n/devtools/browser/beta';
            }
            throw missingFile(path);
          },
          async probeBrowserWebSocket() {
            return { browserVersion: 'Chrome/147.0' };
          },
          async getLegacyBrowserWebSocketUrl() {
            throw new Error('legacy should not be called');
          },
        }
      )
    ).rejects.toMatchObject({
      code: 'multiple-local-browsers',
      details: {
        candidates: [
          {
            channel: 'stable',
            userDataDir: '/Users/tester/Library/Application Support/Google/Chrome',
          },
          {
            channel: 'beta',
            userDataDir: '/Users/tester/Library/Application Support/Google/Chrome Beta',
          },
        ],
      },
    });
  });
});
