/**
 * Ref-based selector integration tests
 *
 * Tests for using ref:eX syntax to interact with elements after taking a snapshot.
 * Refs are stable identifiers from the accessibility tree that map to backendNodeIds.
 *
 * Test cases from PLAN.md:
 * 1. Click by ref after snapshot
 * 2. Fill input by ref
 * 3. Multi-selector with ref + CSS fallbacks
 * 4. Ref not found (no snapshot taken) → falls back to CSS selectors
 * 5. Stale ref after navigation → clear error or fallback
 */

import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import type { InteractiveElement } from '../../src';
import { withRetry } from '../utils/retry';
import { TestContext } from './setup';

const ctx = new TestContext();

/**
 * Find ref for an element by role and optional name match
 */
function findRef(
  elements: InteractiveElement[],
  role: string,
  nameContains?: string
): string | undefined {
  const el = elements.find(
    (e) =>
      e.role === role &&
      (!nameContains || e.name?.toLowerCase().includes(nameContains.toLowerCase()))
  );
  return el?.ref;
}

describe('Ref-Based Selectors', () => {
  beforeAll(() => ctx.setup());
  afterAll(() => ctx.teardown());
  afterEach(() => ctx.resetPage());

  // === Test 1: Click by ref after snapshot ===

  test('should click button by ref after snapshot', async () => {
    const { page, baseUrl } = ctx.get();

    await withRetry(async () => {
      await page.goto(`${baseUrl}/form.html`);

      // Fill required fields first so form can submit
      await page.fill('#name', 'Test User');
      await page.fill('#email', 'test@example.com');

      // Take snapshot to populate refMap
      const snapshot = await page.snapshot();

      // Find the submit button ref
      const buttonRef = findRef(snapshot.interactiveElements, 'button', 'submit');
      expect(buttonRef).toBeDefined();

      // Click using ref:eX syntax
      const clicked = await page.click(`ref:${buttonRef}`);
      expect(clicked).toBe(true);

      // Verify form was submitted - result div should show success
      await page.waitFor('#result.success', { state: 'visible', timeout: 3000 });
      const resultText = await page.text('#result');
      expect(resultText).toContain('Form submitted successfully');
    });
  }, 30000);

  // === Test 2: Fill input by ref ===

  test('should fill input by ref', async () => {
    const { page, baseUrl } = ctx.get();

    await withRetry(async () => {
      await page.goto(`${baseUrl}/form.html`);

      // Take snapshot to populate refMap
      const snapshot = await page.snapshot();

      // Find textbox refs - look for name input
      const nameInputRef = findRef(snapshot.interactiveElements, 'textbox', 'name');
      expect(nameInputRef).toBeDefined();

      // Fill using ref:eX syntax
      const filled = await page.fill(`ref:${nameInputRef}`, 'John Doe');
      expect(filled).toBe(true);

      // Verify the input was filled
      const value = await page.evaluate('document.getElementById("name")?.value || ""');
      expect(value).toBe('John Doe');
    });
  }, 30000);

  test('should fill multiple inputs by ref', async () => {
    const { page, baseUrl } = ctx.get();

    await withRetry(async () => {
      await page.goto(`${baseUrl}/form.html`);

      // Take snapshot
      const snapshot = await page.snapshot();

      // Find both name and email textbox refs
      const nameRef = findRef(snapshot.interactiveElements, 'textbox', 'name');
      const emailRef = findRef(snapshot.interactiveElements, 'textbox', 'email');

      expect(nameRef).toBeDefined();
      expect(emailRef).toBeDefined();

      // Fill both using refs
      await page.fill(`ref:${nameRef}`, 'Jane Smith');
      await page.fill(`ref:${emailRef}`, 'jane@example.com');

      // Verify values
      const nameValue = await page.evaluate('document.getElementById("name")?.value || ""');
      const emailValue = await page.evaluate('document.getElementById("email")?.value || ""');

      expect(nameValue).toBe('Jane Smith');
      expect(emailValue).toBe('jane@example.com');
    });
  }, 30000);

  // === Test 3: Multi-selector with ref + CSS fallbacks ===

  test('should use ref in multi-selector array', async () => {
    const { page, baseUrl } = ctx.get();

    await withRetry(async () => {
      await page.goto(`${baseUrl}/form.html`);

      // Take snapshot
      const snapshot = await page.snapshot();

      // Find name input ref
      const nameRef = findRef(snapshot.interactiveElements, 'textbox', 'name');
      expect(nameRef).toBeDefined();

      // Use multi-selector with ref first, CSS fallbacks after
      const filled = await page.fill(
        [`ref:${nameRef}`, '#name', '[name="name"]'],
        'Multi-Selector Test'
      );

      expect(filled).toBe(true);

      // Verify the value
      const value = await page.evaluate('document.getElementById("name")?.value || ""');
      expect(value).toBe('Multi-Selector Test');
    });
  }, 30000);

  test('should fallback to CSS selector when ref is invalid', async () => {
    const { page, baseUrl } = ctx.get();

    await withRetry(async () => {
      await page.goto(`${baseUrl}/form.html`);

      // Take snapshot (to have some refs, but we'll use a wrong one)
      await page.snapshot();

      // Use multi-selector with invalid ref first, valid CSS selector second
      const filled = await page.fill(['ref:invalid999', '#name'], 'Fallback Test');

      expect(filled).toBe(true);

      // Verify the value - should have used #name fallback
      const value = await page.evaluate('document.getElementById("name")?.value || ""');
      expect(value).toBe('Fallback Test');
    });
  }, 30000);

  // === Test 4: Fallback to CSS when ref not in map (no snapshot taken) ===

  test('should fallback to CSS when no snapshot taken', async () => {
    const { page, baseUrl } = ctx.get();

    await withRetry(async () => {
      await page.goto(`${baseUrl}/form.html`);

      // Do NOT take snapshot - refMap should be empty

      // Try multi-selector with ref first (will fail), CSS second (will succeed)
      const filled = await page.fill(['ref:e1', 'ref:e2', '#name'], 'No Snapshot Test');

      expect(filled).toBe(true);

      // Verify CSS selector was used as fallback
      const value = await page.evaluate('document.getElementById("name")?.value || ""');
      expect(value).toBe('No Snapshot Test');
    });
  }, 30000);

  // === Test 5: Stale ref after navigation ===

  test('should handle stale ref after navigation with multi-selector fallback', async () => {
    const { page, baseUrl } = ctx.get();

    await withRetry(async () => {
      // Navigate to form and take snapshot
      await page.goto(`${baseUrl}/form.html`);
      const snapshot = await page.snapshot();

      // Get a ref from form page
      const formRef = findRef(snapshot.interactiveElements, 'textbox', 'name');
      expect(formRef).toBeDefined();

      // Navigate to different page - this should clear refMap
      await page.goto(`${baseUrl}/basic.html`);

      // Try to use stale ref with CSS fallback
      // The old ref should not work, but #show-dynamic should
      const clicked = await page.click([`ref:${formRef}`, '#show-dynamic'], { timeout: 5000 });

      expect(clicked).toBe(true);

      // Verify we clicked the button on basic.html (it shows dynamic content)
      await page.waitFor('#dynamic.visible', { state: 'visible', timeout: 3000 });
      const text = await page.text('#dynamic');
      expect(text).toContain('Dynamic content loaded');
    });
  }, 30000);

  test('should return false for stale ref-only selector with optional flag', async () => {
    const { page, baseUrl } = ctx.get();

    await withRetry(async () => {
      // Navigate to form and take snapshot
      await page.goto(`${baseUrl}/form.html`);
      const snapshot = await page.snapshot();

      // Get a ref from form page
      const formRef = findRef(snapshot.interactiveElements, 'textbox', 'name');
      expect(formRef).toBeDefined();

      // Navigate to different page - refs are now stale
      await page.goto(`${baseUrl}/basic.html`);

      // Try to use stale ref only (no CSS fallback), with optional flag
      const result = await page.fill(`ref:${formRef}`, 'Should not work', {
        optional: true,
        timeout: 2000,
      });

      // Should return false since ref is stale and no fallback provided
      expect(result).toBe(false);
    });
  }, 30000);

  // === Additional edge case tests ===

  test('should work with batch execution using refs', async () => {
    const { page, baseUrl } = ctx.get();

    await withRetry(async () => {
      await page.goto(`${baseUrl}/form.html`);

      // Take snapshot
      const snapshot = await page.snapshot();

      // Find refs for inputs
      const nameRef = findRef(snapshot.interactiveElements, 'textbox', 'name');
      const emailRef = findRef(snapshot.interactiveElements, 'textbox', 'email');
      const buttonRef = findRef(snapshot.interactiveElements, 'button', 'submit');

      expect(nameRef).toBeDefined();
      expect(emailRef).toBeDefined();
      expect(buttonRef).toBeDefined();

      // Execute batch with ref selectors
      const result = await page.batch([
        { action: 'fill', selector: `ref:${nameRef}`, value: 'Batch User' },
        { action: 'fill', selector: `ref:${emailRef}`, value: 'batch@example.com' },
        { action: 'click', selector: `ref:${buttonRef}` },
      ]);

      expect(result.success).toBe(true);
      expect(result.steps).toHaveLength(3);
      expect(result.steps.every((s) => s.success)).toBe(true);

      // Verify form was submitted
      await page.waitFor('#result.success', { state: 'visible', timeout: 3000 });
    });
  }, 30000);

  test('should clear refs on page navigation', async () => {
    const { page, baseUrl } = ctx.get();

    await withRetry(async () => {
      // Take snapshot on first page
      await page.goto(`${baseUrl}/form.html`);
      const snapshot1 = await page.snapshot();
      const formTextboxRef = findRef(snapshot1.interactiveElements, 'textbox', 'name');
      expect(formTextboxRef).toBeDefined();

      // Navigate to different page - this clears the refMap
      await page.goto(`${baseUrl}/basic.html`);

      // WITHOUT taking a new snapshot, old refs should not work
      // (refMap was cleared during navigation)
      const oldRefWorks = await page.click(`ref:${formTextboxRef}`, {
        optional: true,
        timeout: 1000,
      });
      expect(oldRefWorks).toBe(false);

      // NOW take a new snapshot on basic.html
      const snapshot2 = await page.snapshot();

      // The new snapshot creates fresh refs for basic.html elements
      const buttonRef = findRef(snapshot2.interactiveElements, 'button', 'show');
      expect(buttonRef).toBeDefined();

      // New ref should work - click the button
      const clicked = await page.click(`ref:${buttonRef}`, { timeout: 3000 });
      expect(clicked).toBe(true);

      // Verify button worked
      await page.waitFor('#dynamic.visible', { state: 'visible', timeout: 3000 });
    });
  }, 30000);
});
