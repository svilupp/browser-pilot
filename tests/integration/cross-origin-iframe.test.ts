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

  // (d) STRETCH — nested OOPIF (Stripe-Elements-like): the parent embeds a
  //     controller frame on origin B, which itself embeds the field form.
  //     Reaching the field means descending two frame levels, the second
  //     inside an OOPIF. Skipped until basic OOPIF support (a–c) is solid.
  //
  // STILL SKIPPED — and the reason is a fixture/topology fact, not an engine gap.
  //
  // Recursive auto-attach IS implemented (the engine arms Target.setAutoAttach on
  // every attached child session), so a frame that is genuinely cross-SITE inside
  // an OOPIF would attach as its own grandchild session and descend fine. But in
  // THIS fixture the controller frame and the field frame are both served from
  // origin B (`%%CHILD_ORIGIN%%` === localhost:portB) — i.e. the SAME origin. Under
  // `--site-per-process` Chrome isolates by site, so the same-site field frame stays
  // in the controller's renderer and is NOT promoted to a separate OOPIF. Verified
  // empirically: exactly two child sessions attach (x-frame + stripe-controller),
  // and from the controller session `describeNode(stripe-field-frame).contentDocument`
  // is PRESENT (reachable) — proving it is a same-origin child of the controller,
  // not a nested OOPIF. Descending into it would need same-origin-iframe-inside-OOPIF
  // support (contentDocument-subtree queries on the child session + per-child-session
  // execution-context tracking for evaluate), which is outside the OOPIF child-session
  // recipe and the checkout-fill subset this work targets. To exercise a TRUE nested
  // OOPIF, the field frame's src would need a different site than the controller.
  test.skip('(d) should fill a field in a nested OOPIF (stripe-like)', async () => {
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
