/**
 * Cross-origin iframe (OOPIF) integration tests.
 *
 * These mirror `iframe.test.ts` but the child frame is loaded from a DIFFERENT
 * ORIGIN (a second Bun.serve on a second port), and Chrome is launched with
 * `--site-per-process` so the frame is a true out-of-process iframe (OOPIF)
 * where the build honours it. See `../utils/cross-origin-harness.ts`.
 *
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │ EXPECTED TO FAIL (RED) until the OOPIF engine work lands.                 │
 * │                                                                           │
 * │ Today `Page.switchToFrame` reaches an iframe via `DOM.describeNode`'s     │
 * │ `contentDocument`, which is `null` for a true out-of-process (cross-site) │
 * │ frame — so it throws "Cannot access iframe content...". The harness       │
 * │ (see `../utils/cross-origin-harness.ts`) forces a real OOPIF by serving   │
 * │ the parent on `127.0.0.1` and the child on `localhost` (different sites)  │
 * │ under `--site-per-process`. Verified empirically: with the current engine │
 * │ `switchToFrame` throws here. The engine agent is adding cross-origin/     │
 * │ OOPIF support; until it lands, tests (a)–(c) below fail at `switchToFrame`│
 * │ (or the first in-frame action), which is correct and expected.            │
 * │                                                                           │
 * │ (Note: two `localhost` ports would be the SAME site and stay same-process,│
 * │ where the current engine already works — so the harness deliberately does │
 * │ NOT do that. See the harness header for the site-vs-origin rationale.)    │
 * └─────────────────────────────────────────────────────────────────────────┘
 */

import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { CrossOriginTestContext } from '../utils/cross-origin-harness.ts';
import { withRetry } from '../utils/retry.ts';

const ctx = new CrossOriginTestContext();

describe('Cross-Origin Iframe (OOPIF)', () => {
  beforeAll(() => ctx.setup());
  afterAll(() => ctx.teardown());
  afterEach(() => ctx.resetPage());

  // Warm-up: the iframe ELEMENT lives in the main (origin A) document, so this
  // works even before the engine changes — it just proves the fixture wiring
  // and the cross-origin `<iframe src>` templating are correct.
  test('should detect the cross-origin iframe element on the parent page', async () => {
    const { page, parentUrl } = ctx.get();

    await withRetry(async () => {
      await page.goto(parentUrl);

      const found = await page.waitFor('[data-testid="x-frame"]', {
        state: 'visible',
        timeout: 5000,
      });
      expect(found).toBe(true);

      // Confirm the frame really points at the OTHER origin (origin B).
      const { childOrigin } = ctx.get();
      const src = await page.evaluate<string>(
        'document.querySelector("[data-testid=\\"x-frame\\"]")?.getAttribute("src") || ""'
      );
      expect(src).toContain(childOrigin);
    });
  }, 30000);

  // (a) CORE checkout-fill scenario: switch into the cross-origin frame, fill
  //     the child's name field, click the child's submit, and read back the
  //     "Form submitted: <value>" message rendered inside the frame.
  test('(a) should fill and submit a form inside a cross-origin iframe', async () => {
    const { page, parentUrl } = ctx.get();

    await withRetry(async () => {
      await page.goto(parentUrl);
      await page.waitFor('[data-testid="x-frame"]', { state: 'visible', timeout: 5000 });

      // EXPECTED to throw/return false until OOPIF support lands.
      const switched = await page.switchToFrame('[data-testid="x-frame"]');
      expect(switched).toBe(true);

      await page.fill('[data-testid="xo-name"]', 'Ada Lovelace', { timeout: 5000 });
      await page.click('[data-testid="xo-submit"]', { timeout: 5000 });

      // The message is rendered INSIDE the cross-origin frame; read it via the
      // current (frame) context.
      await page.waitFor('[data-testid="xo-message"]', { state: 'visible', timeout: 5000 });
      const message = await page.text('[data-testid="xo-message"]');
      expect(message).toContain('Form submitted: Ada Lovelace');
    });
  }, 30000);

  // (b) ADVERSARIAL: the parent page has a look-alike input with the SAME
  //     data-testid/id ("xo-name"/"name") and a look-alike "Submit" button.
  //     Prove the value landed in the REAL in-frame field on origin B and NOT
  //     the parent look-alike.
  test('(b) should fill the real in-frame field, not the parent look-alike', async () => {
    const { page, parentUrl } = ctx.get();

    await withRetry(async () => {
      await page.goto(parentUrl);
      await page.waitFor('[data-testid="x-frame"]', { state: 'visible', timeout: 5000 });

      const switched = await page.switchToFrame('[data-testid="x-frame"]');
      expect(switched).toBe(true);

      await page.fill('[data-testid="xo-name"]', 'In-Frame Value', { timeout: 5000 });

      // While still in the frame context: the CHILD field holds the value.
      const childValue = await page.evaluate<string>(
        'document.getElementById("name")?.value || ""'
      );
      expect(childValue).toBe('In-Frame Value');

      // Back in the top document: the PARENT look-alike must still be empty —
      // this is the proof the fill did not hit the parent by mistake.
      await page.switchToMain();
      const parentValue = await page.evaluate<string>(
        'document.getElementById("name")?.value || ""'
      );
      expect(parentValue).toBe('');
    });
  }, 30000);

  // (c) switchToMain round-trip: after doing work inside the cross-origin
  //     frame, frame state must reset so a top-level element is interactable.
  test('(c) should reset to the main frame after cross-origin frame work', async () => {
    const { page, parentUrl } = ctx.get();

    await withRetry(async () => {
      await page.goto(parentUrl);
      await page.waitFor('[data-testid="x-frame"]', { state: 'visible', timeout: 5000 });

      expect(page.getCurrentFrame()).toBe(null);

      const switched = await page.switchToFrame('[data-testid="x-frame"]');
      expect(switched).toBe(true);
      expect(page.getCurrentFrame()).not.toBe(null);

      await page.switchToMain();
      expect(page.getCurrentFrame()).toBe(null);

      // Interact with a genuine top-level (origin A) control.
      await page.click('[data-testid="parent-button"]', { timeout: 5000 });
      await page.waitFor('#parent-result', { state: 'visible', timeout: 3000 });
      const text = await page.text('#parent-result');
      expect(text).toContain('Parent frame button clicked');
    });
  }, 30000);

  // (e) ADVERSARIAL (C1, keystroke family): `type` must route to the child
  //     session so keystrokes land in the REAL in-frame field, NOT the parent
  //     look-alike `#name`. Mirrors (b) but exercises the type() path (needed for
  //     checkout card entry), which previously resolved via the default session.
  test('(e) should type into the real in-frame field, not the parent look-alike', async () => {
    const { page, parentUrl } = ctx.get();

    await withRetry(async () => {
      await page.goto(parentUrl);
      await page.waitFor('[data-testid="x-frame"]', { state: 'visible', timeout: 5000 });

      const switched = await page.switchToFrame('[data-testid="x-frame"]');
      expect(switched).toBe(true);

      await page.type('[data-testid="xo-name"]', 'Typed In Frame', { timeout: 5000, delay: 0 });

      // While still in the frame context: the CHILD field holds the typed value.
      const childValue = await page.evaluate<string>(
        'document.getElementById("name")?.value || ""'
      );
      expect(childValue).toBe('Typed In Frame');

      // Back on the top document: the parent look-alike MUST still be empty —
      // proof the keystrokes did not leak to the parent.
      await page.switchToMain();
      const parentValue = await page.evaluate<string>(
        'document.getElementById("name")?.value || ""'
      );
      expect(parentValue).toBe('');
    });
  }, 30000);

  // (f) C1 HARD-FAIL: an action that is NOT routed into the OOPIF child session
  //     (e.g. hover / select) must THROW a clear, actionable error rather than
  //     silently resolving against the parent and acting on a look-alike. Also
  //     proves the parent look-alike is untouched afterwards.
  test('(f) unsupported in-frame actions throw a clear error, never touching the parent', async () => {
    const { page, parentUrl } = ctx.get();

    await withRetry(async () => {
      await page.goto(parentUrl);
      await page.waitFor('[data-testid="x-frame"]', { state: 'visible', timeout: 5000 });

      const switched = await page.switchToFrame('[data-testid="x-frame"]');
      expect(switched).toBe(true);

      // hover is not implemented for OOPIFs → must hard-fail with the guidance.
      await expect(page.hover('[data-testid="xo-submit"]', { timeout: 2000 })).rejects.toThrow(
        /not yet supported inside a cross-origin iframe/
      );
      // select likewise.
      await expect(page.select('[data-testid="xo-name"]', 'x', { timeout: 2000 })).rejects.toThrow(
        /not yet supported inside a cross-origin iframe/
      );

      // The parent look-alike button/handler was never invoked.
      await page.switchToMain();
      const parentResultVisible = await page.evaluate<boolean>(
        'getComputedStyle(document.getElementById("parent-result")).display !== "none"'
      );
      expect(parentResultVisible).toBe(false);
    });
  }, 30000);

  // M3 (nested switchToFrame from inside an OOPIF must FAIL CLEANLY rather than
  // silently return false / retarget the parent) is covered deterministically by
  // a unit test — see tests/unit/oopif-guards.test.ts
  // ("nested switchToFrame throws ... M3"). It is NOT asserted here: exercising
  // the real nested-descent branch against Chrome under `--site-per-process`
  // triggers an intermittent hard CDP disconnect that reproduces ONLY under the
  // `bun test` runner (the identical steps run cleanly standalone), and the
  // nested-OOPIF descent itself is an acknowledged out-of-scope follow-up.

  // (g) Fix #3: a SAME-ORIGIN wrapper iframe (served by origin A, the same
  //     origin as the top page — e.g. a modal/checkout-container) sits ABOVE
  //     the cross-origin OOPIF field frame. switchToFrame must first descend
  //     into the same-origin wrapper (the existing top-level same-origin path)
  //     and THEN, from inside it, descend into the cross-origin OOPIF nested
  //     inside that wrapper. This is the mirror image of fix #2 (same-origin
  //     frame INSIDE an OOPIF) — here the same-origin frame is OUTSIDE/ABOVE.
  test('(g) should descend through a same-origin wrapper into an OOPIF nested inside it', async () => {
    const { page, parentUrl } = ctx.get();

    await withRetry(async () => {
      await page.goto(parentUrl);
      await page.waitFor('[data-testid="wrapper-frame"]', { state: 'visible', timeout: 5000 });

      // Level 1: the same-origin wrapper iframe (unchanged top-level path).
      const level1 = await page.switchToFrame('[data-testid="wrapper-frame"]');
      expect(level1).toBe(true);
      expect(page.getCurrentFrame()).not.toBe(null);

      // Level 2: the cross-origin OOPIF nested inside the wrapper.
      await page.waitFor('[data-testid="wrapped-x-frame"]', { state: 'visible', timeout: 5000 });
      const level2 = await page.switchToFrame('[data-testid="wrapped-x-frame"]');
      expect(level2).toBe(true);

      await page.fill('[data-testid="xo-name"]', 'Through Wrapper', { timeout: 5000 });
      const value = await page.evaluate<string>('document.getElementById("name")?.value || ""');
      expect(value).toBe('Through Wrapper');

      // Round-trip back to the top document.
      await page.switchToMain();
      expect(page.getCurrentFrame()).toBe(null);
    });
  }, 30000);

  // (d) Stripe-Elements-like nested topology: the parent embeds a controller
  //     frame on origin B (an OOPIF), which itself embeds a SAME-ORIGIN field
  //     frame (both served from `%%CHILD_ORIGIN%%`). Under `--site-per-process`
  //     the same-site field frame stays in the controller's renderer and is
  //     NOT promoted to its own OOPIF — it is reached via the same-origin
  //     `contentDocument` path FROM the controller's own child session, with
  //     its own execution context tracked per-frameId in
  //     `oopifFrameExecutionContexts` (fix #2) so `evaluate()`/fill resolve
  //     against the nested document instead of the controller's top document.
  //     This is now supported: switching two frame levels deep (an OOPIF, then
  //     a same-origin frame nested inside it) and filling the in-frame field
  //     works end-to-end.
  test('(d) should fill a field in a same-origin frame nested inside an OOPIF (stripe-like)', async () => {
    const { page, parentUrl } = ctx.get();

    await withRetry(async () => {
      await page.goto(parentUrl);
      await page.waitFor('[data-testid="stripe-controller-frame"]', {
        state: 'visible',
        timeout: 5000,
      });

      // Level 1: into the controller OOPIF (origin B).
      const level1 = await page.switchToFrame('[data-testid="stripe-controller-frame"]');
      expect(level1).toBe(true);

      // Level 2: into the field frame nested inside the controller.
      await page.waitFor('[data-testid="stripe-field-frame"]', { state: 'visible', timeout: 5000 });
      const level2 = await page.switchToFrame('[data-testid="stripe-field-frame"]');
      expect(level2).toBe(true);

      await page.fill('[data-testid="xo-name"]', 'Nested OOPIF', { timeout: 5000 });
      const value = await page.evaluate<string>('document.getElementById("name")?.value || ""');
      expect(value).toBe('Nested OOPIF');
    });
  }, 30000);
});
