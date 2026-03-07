/**
 * Batch action executor
 */

import type { Page } from '../browser/page.ts';
import { ElementNotFoundError } from '../browser/types.ts';
import type { BatchOptions, BatchResult, Step, StepResult } from './types.ts';

const DEFAULT_TIMEOUT = 30000;

export class BatchExecutor {
  private page: Page;

  constructor(page: Page) {
    this.page = page;
  }

  /**
   * Execute a batch of steps
   */
  async execute(steps: Step[], options: BatchOptions = {}): Promise<BatchResult> {
    const { timeout = DEFAULT_TIMEOUT, onFail = 'stop' } = options;
    const results: StepResult[] = [];
    const startTime = Date.now();

    for (let i = 0; i < steps.length; i++) {
      const step = steps[i]!;
      const stepStart = Date.now();
      const maxAttempts = (step.retry ?? 0) + 1;
      const retryDelay = step.retryDelay ?? 500;

      let lastError: Error | undefined;
      let succeeded = false;

      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        if (attempt > 0) {
          await new Promise((resolve) => setTimeout(resolve, retryDelay));
        }

        try {
          const result = await this.executeStep(step, timeout);

          results.push({
            index: i,
            action: step.action,
            selector: step.selector,
            selectorUsed: result.selectorUsed,
            success: true,
            durationMs: Date.now() - stepStart,
            result: result.value,
            text: result.text,
          });
          succeeded = true;
          break;
        } catch (error) {
          lastError = error instanceof Error ? error : new Error(String(error));
        }
      }

      if (!succeeded) {
        const errorMessage = lastError?.message ?? 'Unknown error';
        const hints = lastError instanceof ElementNotFoundError ? lastError.hints : undefined;

        results.push({
          index: i,
          action: step.action,
          selector: step.selector,
          success: false,
          durationMs: Date.now() - stepStart,
          error: errorMessage,
          hints,
        });

        // Stop execution on failure (unless optional or onFail: 'continue')
        if (onFail === 'stop' && !step.optional) {
          return {
            success: false,
            stoppedAtIndex: i,
            steps: results,
            totalDurationMs: Date.now() - startTime,
          };
        }
      }
    }

    const allSuccess = results.every((r) => r.success || steps[r.index]?.optional);

    return {
      success: allSuccess,
      steps: results,
      totalDurationMs: Date.now() - startTime,
    };
  }

  /**
   * Execute a single step
   */
  private async executeStep(
    step: Step,
    defaultTimeout: number
  ): Promise<{ selectorUsed?: string; value?: unknown; text?: string }> {
    const timeout = step.timeout ?? defaultTimeout;
    const optional = step.optional ?? false;

    switch (step.action) {
      case 'goto': {
        if (!step.url) throw new Error('goto requires url');
        await this.page.goto(step.url, { timeout, optional });
        return {};
      }

      case 'click': {
        if (!step.selector) throw new Error('click requires selector');

        // If waitForNavigation is set, set up listener BEFORE clicking
        if (step.waitForNavigation === true) {
          const navPromise = this.page.waitForNavigation({ timeout, optional });
          await this.page.click(step.selector, { timeout, optional });
          await navPromise;
        } else {
          await this.page.click(step.selector, { timeout, optional });
        }

        return { selectorUsed: this.getUsedSelector(step.selector) };
      }

      case 'fill': {
        if (!step.selector) throw new Error('fill requires selector');
        if (typeof step.value !== 'string') throw new Error('fill requires string value');
        await this.page.fill(step.selector, step.value, {
          timeout,
          optional,
          blur: step.blur,
        });
        return { selectorUsed: this.getUsedSelector(step.selector) };
      }

      case 'type': {
        if (!step.selector) throw new Error('type requires selector');
        if (typeof step.value !== 'string') throw new Error('type requires string value');
        await this.page.type(step.selector, step.value, {
          timeout,
          optional,
          delay: step.delay ?? 50,
        });
        return { selectorUsed: this.getUsedSelector(step.selector) };
      }

      case 'select': {
        // Custom select (with trigger and option)
        if (step.trigger && step.option && typeof step.value === 'string') {
          await this.page.select(
            {
              trigger: step.trigger,
              option: step.option,
              value: step.value,
              match: step.match,
            },
            { timeout, optional }
          );
          return { selectorUsed: this.getUsedSelector(step.trigger) };
        }

        // Native select
        if (!step.selector) throw new Error('select requires selector');
        if (!step.value) throw new Error('select requires value');
        await this.page.select(step.selector, step.value, { timeout, optional });
        return { selectorUsed: this.getUsedSelector(step.selector) };
      }

      case 'check': {
        if (!step.selector) throw new Error('check requires selector');
        await this.page.check(step.selector, { timeout, optional });
        return { selectorUsed: this.getUsedSelector(step.selector) };
      }

      case 'uncheck': {
        if (!step.selector) throw new Error('uncheck requires selector');
        await this.page.uncheck(step.selector, { timeout, optional });
        return { selectorUsed: this.getUsedSelector(step.selector) };
      }

      case 'submit': {
        if (!step.selector) throw new Error('submit requires selector');
        await this.page.submit(step.selector, {
          timeout,
          optional,
          method: step.method ?? 'enter+click',
          waitForNavigation: step.waitForNavigation,
        });
        return { selectorUsed: this.getUsedSelector(step.selector) };
      }

      case 'press': {
        if (!step.key) throw new Error('press requires key');
        await this.page.press(step.key);
        return {};
      }

      case 'focus': {
        if (!step.selector) throw new Error('focus requires selector');
        await this.page.focus(step.selector, { timeout, optional });
        return { selectorUsed: this.getUsedSelector(step.selector) };
      }

      case 'hover': {
        if (!step.selector) throw new Error('hover requires selector');
        await this.page.hover(step.selector, { timeout, optional });
        return { selectorUsed: this.getUsedSelector(step.selector) };
      }

      case 'scroll': {
        // Scroll to absolute coordinates
        if (step.x !== undefined || step.y !== undefined) {
          await this.page.scroll('body', { x: step.x, y: step.y, timeout, optional });
          return {};
        }
        // Page-level scroll with direction (no selector needed)
        if (!step.selector && (step.direction || step.amount !== undefined)) {
          const amount = step.amount ?? 500;
          const direction = step.direction ?? 'down';
          const deltaY = direction === 'down' ? amount : direction === 'up' ? -amount : 0;
          const deltaX = direction === 'right' ? amount : direction === 'left' ? -amount : 0;
          await this.page.evaluate(`window.scrollBy(${deltaX}, ${deltaY})`);
          return {};
        }
        if (!step.selector) throw new Error('scroll requires selector, coordinates, or direction');
        await this.page.scroll(step.selector, { timeout, optional });
        return { selectorUsed: this.getUsedSelector(step.selector) };
      }

      case 'wait': {
        // Simple timeout wait (no selector, no waitFor)
        if (!step.selector && !step.waitFor) {
          const delay = step.timeout ?? 1000;
          await new Promise((resolve) => setTimeout(resolve, delay));
          return {};
        }
        if (step.waitFor === 'navigation') {
          await this.page.waitForNavigation({ timeout, optional });
          return {};
        }
        if (step.waitFor === 'networkIdle') {
          await this.page.waitForNetworkIdle({ timeout, optional });
          return {};
        }
        if (!step.selector)
          throw new Error(
            'wait requires selector (or waitFor: navigation/networkIdle, or timeout for simple delay)'
          );
        await this.page.waitFor(step.selector, {
          timeout,
          optional,
          state: step.waitFor ?? 'visible',
        });
        return { selectorUsed: this.getUsedSelector(step.selector) };
      }

      case 'snapshot': {
        const snapshot = await this.page.snapshot();
        return { value: snapshot };
      }

      case 'screenshot': {
        const data = await this.page.screenshot({
          format: step.format,
          quality: step.quality,
          fullPage: step.fullPage,
        });
        return { value: data };
      }

      case 'evaluate': {
        if (typeof step.value !== 'string')
          throw new Error('evaluate requires string value (expression)');
        const result = await this.page.evaluate(step.value);
        return { value: result };
      }

      case 'text': {
        // text() only accepts a single selector string, use first if array provided
        const selector = Array.isArray(step.selector) ? step.selector[0] : step.selector;
        const text = await this.page.text(selector);
        return { text, selectorUsed: selector };
      }

      case 'switchFrame': {
        if (!step.selector) throw new Error('switchFrame requires selector');
        await this.page.switchToFrame(step.selector, { timeout, optional });
        return { selectorUsed: this.getUsedSelector(step.selector) };
      }

      case 'switchToMain': {
        await this.page.switchToMain();
        return {};
      }

      case 'assertVisible': {
        if (!step.selector) throw new Error('assertVisible requires selector');
        const el = await this.page.waitFor(step.selector, {
          timeout,
          optional: true,
          state: 'visible',
        });
        if (!el) {
          throw new Error(
            `Assertion failed: selector ${JSON.stringify(step.selector)} is not visible`
          );
        }
        return { selectorUsed: this.getUsedSelector(step.selector) };
      }

      case 'assertExists': {
        if (!step.selector) throw new Error('assertExists requires selector');
        const el = await this.page.waitFor(step.selector, {
          timeout,
          optional: true,
          state: 'attached',
        });
        if (!el) {
          throw new Error(
            `Assertion failed: selector ${JSON.stringify(step.selector)} does not exist`
          );
        }
        return { selectorUsed: this.getUsedSelector(step.selector) };
      }

      case 'assertText': {
        const selector = Array.isArray(step.selector) ? step.selector[0] : step.selector;
        const text = await this.page.text(selector);
        const expected = step.expect ?? step.value;
        if (typeof expected !== 'string') throw new Error('assertText requires expect or value');
        if (!text.includes(expected)) {
          throw new Error(
            `Assertion failed: text does not contain ${JSON.stringify(expected)}. Got: ${JSON.stringify(text.slice(0, 200))}`
          );
        }
        return { selectorUsed: selector, text };
      }

      case 'assertUrl': {
        const currentUrl = await this.page.url();
        const expected = step.expect ?? step.url;
        if (typeof expected !== 'string') throw new Error('assertUrl requires expect or url');
        if (!currentUrl.includes(expected)) {
          throw new Error(
            `Assertion failed: URL does not contain ${JSON.stringify(expected)}. Got: ${JSON.stringify(currentUrl)}`
          );
        }
        return { value: currentUrl };
      }

      case 'assertValue': {
        if (!step.selector) throw new Error('assertValue requires selector');
        const expected = step.expect ?? step.value;
        if (typeof expected !== 'string') throw new Error('assertValue requires expect or value');
        const found = await this.page.waitFor(step.selector, {
          timeout,
          optional: true,
          state: 'attached',
        });
        if (!found) {
          throw new Error(`Assertion failed: selector ${JSON.stringify(step.selector)} not found`);
        }
        const usedSelector = this.getUsedSelector(step.selector);
        const actual = await this.page.evaluate(
          `(function() { var el = document.querySelector(${JSON.stringify(usedSelector)}); return el ? el.value : null; })()`
        );
        if (actual !== expected) {
          throw new Error(
            `Assertion failed: value of ${JSON.stringify(usedSelector)} is ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`
          );
        }
        return { selectorUsed: usedSelector, value: actual };
      }

      default: {
        const action = (step as Step).action;
        const aliases: Record<string, string> = {
          execute: 'evaluate',
          navigate: 'goto',
          input: 'fill',
          tap: 'click',
          go: 'goto',
          run: 'evaluate',
          capture: 'screenshot',
          inspect: 'snapshot',
          enter: 'press',
          open: 'goto',
          visit: 'goto',
          eval: 'evaluate',
          js: 'evaluate',
          snap: 'snapshot',
          frame: 'switchFrame',
          assert_visible: 'assertVisible',
          assert_exists: 'assertExists',
          assert_text: 'assertText',
          assert_url: 'assertUrl',
          assert_value: 'assertValue',
        };
        const suggestion = aliases[action.toLowerCase()];
        const hint = suggestion ? ` Did you mean "${suggestion}"?` : '';
        const valid =
          'goto, click, fill, type, select, check, uncheck, submit, press, focus, hover, scroll, wait, snapshot, screenshot, evaluate, text, switchFrame, switchToMain, assertVisible, assertExists, assertText, assertUrl, assertValue';
        throw new Error(`Unknown action "${action}".${hint}\n\nValid actions: ${valid}`);
      }
    }
  }

  /**
   * Get the actual selector that matched the element.
   * Uses the last matched selector tracked by Page, falls back to first selector if unavailable.
   */
  private getUsedSelector(selector: string | string[]): string {
    const matched = this.page.getLastMatchedSelector();
    if (matched) return matched;
    // Fallback for actions that don't track selector
    return Array.isArray(selector) ? selector[0]! : selector;
  }
}

/**
 * Add batch execution capability to Page class
 */
export function addBatchToPage(
  page: Page
): Page & { batch: (steps: Step[], options?: BatchOptions) => Promise<BatchResult> } {
  const executor = new BatchExecutor(page);

  return Object.assign(page, {
    batch: (steps: Step[], options?: BatchOptions) => executor.execute(steps, options),
  });
}
