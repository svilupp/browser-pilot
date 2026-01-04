/**
 * React-like controlled form integration tests
 *
 * Tests that fill actions properly trigger events needed for React-style
 * controlled inputs where internal state must sync with DOM values.
 *
 * Pain point: "Using bp fill on React controlled inputs doesn't always
 * trigger React's onChange handlers properly."
 */

import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { withRetry } from '../utils/retry';
import { TestContext } from './setup';

const ctx = new TestContext();

describe('React-like Controlled Form', () => {
  beforeAll(() => ctx.setup());
  afterAll(() => ctx.teardown());
  afterEach(() => ctx.resetPage());

  test('fill should trigger input event and update controlled state', async () => {
    const { page, baseUrl } = ctx.get();

    await withRetry(async () => {
      await page.goto(`${baseUrl}/react-form.html`);

      // Fill the username field
      await page.fill('#username', 'testuser');

      // Check if state was updated via the input event
      const state = await page.evaluate(() => {
        const stateEl = document.getElementById('state-output');
        return JSON.parse(stateEl?.textContent || '{}');
      });

      expect(state.username).toBe('testuser');
    });
  });

  test('fill should sync DOM and internal state', async () => {
    const { page, baseUrl } = ctx.get();

    await withRetry(async () => {
      await page.goto(`${baseUrl}/react-form.html`);

      // Fill multiple fields
      await page.fill('#username', 'john_doe');
      await page.fill('#email', 'john@example.com');
      await page.fill('#search', 'test query');

      // Click the sync check button
      await page.click('#check-sync');

      // Verify sync status
      const syncStatus = await page.evaluate(() => {
        const el = document.getElementById('sync-status');
        return el?.dataset['synced'];
      });

      expect(syncStatus).toBe('true');
    });
  });

  test('fill should trigger enough events for state tracking', async () => {
    const { page, baseUrl } = ctx.get();

    await withRetry(async () => {
      await page.goto(`${baseUrl}/react-form.html`);

      // Fill a field
      await page.fill('#username', 'eventtest');

      // Check that events were captured
      const state = await page.evaluate(() => {
        const stateEl = document.getElementById('state-output');
        return JSON.parse(stateEl?.textContent || '{}');
      });

      // Should have received at least one event (ideally input event)
      expect(state.eventCount).toBeGreaterThanOrEqual(1);
      expect(state.lastEvent).toBe('input');
    });
  });

  test('fill followed by blur should work for frameworks needing blur', async () => {
    const { page, baseUrl } = ctx.get();

    await withRetry(async () => {
      await page.goto(`${baseUrl}/react-form.html`);

      // Fill then trigger blur via Tab key (common workaround)
      await page.fill('#username', 'blurtest');
      await page.press('Tab');

      // Check state
      const state = await page.evaluate(() => {
        const stateEl = document.getElementById('state-output');
        return JSON.parse(stateEl?.textContent || '{}');
      });

      expect(state.username).toBe('blurtest');
    });
  });

  test('select should update controlled state', async () => {
    const { page, baseUrl } = ctx.get();

    await withRetry(async () => {
      await page.goto(`${baseUrl}/react-form.html`);

      // Select a country
      await page.select('#country', 'uk');

      // Verify state was updated
      const state = await page.evaluate(() => {
        const stateEl = document.getElementById('state-output');
        return JSON.parse(stateEl?.textContent || '{}');
      });

      expect(state.country).toBe('uk');
    });
  });

  test('checkbox check should update controlled state', async () => {
    const { page, baseUrl } = ctx.get();

    await withRetry(async () => {
      await page.goto(`${baseUrl}/react-form.html`);

      // Check the newsletter checkbox
      await page.check('#newsletter');

      // Verify state
      const state = await page.evaluate(() => {
        const stateEl = document.getElementById('state-output');
        return JSON.parse(stateEl?.textContent || '{}');
      });

      expect(state.newsletter).toBe(true);
    });
  });

  test('form submission should have synced state', async () => {
    const { page, baseUrl } = ctx.get();

    await withRetry(async () => {
      await page.goto(`${baseUrl}/react-form.html`);

      // Fill all fields
      await page.fill('#username', 'submituser');
      await page.fill('#email', 'submit@test.com');
      await page.select('#country', 'ca');
      await page.check('#newsletter');

      // Check sync before submit
      await page.click('#check-sync');

      const syncStatus = await page.evaluate(() => {
        const el = document.getElementById('sync-status');
        return el?.dataset['synced'];
      });

      expect(syncStatus).toBe('true');

      // Verify final state
      const state = await page.evaluate(() => {
        const stateEl = document.getElementById('state-output');
        return JSON.parse(stateEl?.textContent || '{}');
      });

      expect(state).toMatchObject({
        username: 'submituser',
        email: 'submit@test.com',
        country: 'ca',
        newsletter: true,
      });
    });
  });

  test('type action should also update controlled state', async () => {
    const { page, baseUrl } = ctx.get();

    await withRetry(async () => {
      await page.goto(`${baseUrl}/react-form.html`);

      // Use type instead of fill
      await page.type('#search', 'typing test', { delay: 10 });

      // Check state
      const state = await page.evaluate(() => {
        const stateEl = document.getElementById('state-output');
        return JSON.parse(stateEl?.textContent || '{}');
      });

      expect(state.search).toBe('typing test');
      // type triggers events per character, so event count should be higher
      expect(state.eventCount).toBeGreaterThanOrEqual(10);
    });
  });
});
