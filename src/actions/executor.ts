/**
 * Batch action executor
 */

import type { Page } from '../browser/page.ts';
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
        });
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);

        results.push({
          index: i,
          action: step.action,
          selector: step.selector,
          success: false,
          durationMs: Date.now() - stepStart,
          error: errorMessage,
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
  ): Promise<{ selectorUsed?: string; value?: unknown }> {
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
        if (step.waitForNavigation) {
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
          clear: step.clear ?? true,
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
        if (step.x !== undefined || step.y !== undefined) {
          await this.page.scroll('body', { x: step.x, y: step.y, timeout, optional });
          return {};
        }
        if (!step.selector) throw new Error('scroll requires selector or coordinates');
        await this.page.scroll(step.selector, { timeout, optional });
        return { selectorUsed: this.getUsedSelector(step.selector) };
      }

      case 'wait': {
        if (step.waitFor === 'navigation') {
          await this.page.waitForNavigation({ timeout, optional });
          return {};
        }
        if (step.waitFor === 'networkIdle') {
          await this.page.waitForNetworkIdle({ timeout, optional });
          return {};
        }
        if (!step.selector)
          throw new Error('wait requires selector (or waitFor: navigation/networkIdle)');
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

      default:
        throw new Error(`Unknown action: ${(step as Step).action}`);
    }
  }

  /**
   * Get the first selector if multiple were provided
   * (actual used selector tracking would need to be implemented in Page)
   */
  private getUsedSelector(selector: string | string[]): string {
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
