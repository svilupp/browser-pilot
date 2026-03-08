import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { withRetry } from '../utils/retry';
import { generateSessionName, getBaseUrl, getWebSocketUrl, runCLI, setup, teardown } from './setup';

describe.skipIf(!!process.env['CI'])('CLI Page Tools', () => {
  beforeAll(setup);
  afterAll(teardown);

  test('connect --new-tab can open a fresh tab at a page URL', async () => {
    const sessionName = generateSessionName();

    await withRetry(async () => {
      const wsUrl = await getWebSocketUrl();
      const baseUrl = getBaseUrl();

      const connectResult = await runCLI([
        'connect',
        '--provider',
        'generic',
        '--browser-url',
        wsUrl,
        '--new-tab',
        '--url',
        `${baseUrl}/basic.html`,
        '--name',
        sessionName,
        '-f',
        'json',
      ]);

      expect(connectResult.exitCode).toBe(0);
      expect((connectResult.json as { currentUrl?: string }).currentUrl).toContain('basic.html');

      await runCLI(['close', '-s', sessionName]).catch(() => {});
    });
  }, 60000);

  test('bp page shows URL, headings, forms, and actions', async () => {
    const sessionName = generateSessionName();

    await withRetry(async () => {
      const wsUrl = await getWebSocketUrl();
      const baseUrl = getBaseUrl();

      await runCLI(['connect', '--provider', 'generic', '--url', wsUrl, '--name', sessionName]);
      await runCLI([
        'exec',
        '-s',
        sessionName,
        JSON.stringify({ action: 'goto', url: `${baseUrl}/form.html` }),
      ]);

      const result = await runCLI(['page', '-s', sessionName]);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('URL:');
      expect(result.stdout).toContain('Title:');
      expect(result.stdout).toContain('Headings:');
      expect(result.stdout).toContain('Form fields:');
      expect(result.stdout).toContain('Actions:');
      expect(result.stdout).toContain('#name');

      await runCLI(['close', '-s', sessionName]).catch(() => {});
    });
  }, 60000);

  test('bp forms returns structured field metadata', async () => {
    const sessionName = generateSessionName();

    await withRetry(async () => {
      const wsUrl = await getWebSocketUrl();
      const baseUrl = getBaseUrl();

      await runCLI(['connect', '--provider', 'generic', '--url', wsUrl, '--name', sessionName]);
      await runCLI([
        'exec',
        '-s',
        sessionName,
        JSON.stringify({ action: 'goto', url: `${baseUrl}/react-form.html` }),
      ]);

      const result = await runCLI(['forms', '-s', sessionName, '-f', 'json']);

      expect(result.exitCode).toBe(0);
      const forms = result.json as Array<{
        id?: string;
        label?: string;
        options?: Array<{ text: string; value: string }>;
      }>;
      expect(forms).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: 'username', label: 'Username (controlled)' }),
          expect.objectContaining({
            id: 'country',
            options: expect.arrayContaining([
              expect.objectContaining({ text: 'United States', value: 'us' }),
            ]),
          }),
        ])
      );

      await runCLI(['close', '-s', sessionName]).catch(() => {});
    });
  }, 60000);

  test('bp targets lists browser tabs', async () => {
    const sessionName = generateSessionName();

    await withRetry(async () => {
      const wsUrl = await getWebSocketUrl();
      const baseUrl = getBaseUrl();

      await runCLI(['connect', '--provider', 'generic', '--url', wsUrl, '--name', sessionName]);
      await runCLI([
        'exec',
        '-s',
        sessionName,
        JSON.stringify({ action: 'goto', url: `${baseUrl}/basic.html` }),
      ]);

      const result = await runCLI(['targets', '-s', sessionName, '-f', 'json']);

      expect(result.exitCode).toBe(0);
      const targets = result.json as Array<{ targetId: string; title: string; url: string }>;
      expect(targets.length).toBeGreaterThan(0);
      expect(targets[0]).toEqual(
        expect.objectContaining({
          targetId: expect.any(String),
          title: expect.any(String),
          url: expect.any(String),
        })
      );

      await runCLI(['close', '-s', sessionName]).catch(() => {});
    });
  }, 60000);
});
