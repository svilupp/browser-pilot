/**
 * Condition evaluation for outcome-based execution
 */

import type { Page } from '../browser/page.ts';
import type { CDPClient } from '../cdp/client.ts';
import { globToRegex } from '../utils/strings.ts';
import type { Condition, MatchedCondition, OutcomeStatus } from './types.ts';

/**
 * Tracks network responses during step execution for networkResponse conditions
 */
export class NetworkResponseTracker {
  private responses: Array<{ url: string; status: number }> = [];
  private listening = false;
  private handler: ((params: Record<string, unknown>) => void) | null = null;

  start(cdp: CDPClient): void {
    if (this.listening) return;
    this.listening = true;
    this.handler = (params: Record<string, unknown>) => {
      const response = params['response'] as { url: string; status: number } | undefined;
      if (response) {
        this.responses.push({ url: response.url, status: response.status });
      }
    };
    cdp.on('Network.responseReceived', this.handler);
  }

  stop(cdp: CDPClient): void {
    if (this.handler) {
      cdp.off('Network.responseReceived', this.handler);
      this.handler = null;
    }
    this.listening = false;
  }

  getResponses(): Array<{ url: string; status: number }> {
    return this.responses;
  }

  reset(): void {
    this.responses = [];
  }
}

/**
 * Capture a state signature for stateSignatureChanges condition.
 * Uses page URL + visible text content hash as a lightweight fingerprint.
 */
export async function captureStateSignature(page: Page): Promise<string> {
  try {
    const url = await page.url();
    const text = await page.text();
    // Simple hash: URL + first 2000 chars of text content
    const truncated = text.slice(0, 2000);
    return `${url}|${simpleHash(truncated)}`;
  } catch {
    return '';
  }
}

function simpleHash(str: string): string {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash + char) | 0;
  }
  return hash.toString(36);
}

/**
 * Evaluate a single condition against the current page state
 */
export async function evaluateCondition(
  condition: Condition,
  page: Page,
  context: {
    networkTracker?: NetworkResponseTracker;
    beforeSignature?: string;
  } = {}
): Promise<MatchedCondition> {
  switch (condition.kind) {
    case 'urlMatches': {
      try {
        const currentUrl = await page.url();
        const regex = globToRegex(condition.pattern);
        const matched = regex.test(currentUrl);
        return {
          condition,
          matched,
          detail: matched
            ? `URL "${currentUrl}" matches "${condition.pattern}"`
            : `URL "${currentUrl}" does not match "${condition.pattern}"`,
        };
      } catch {
        return { condition, matched: false, detail: 'Failed to get current URL' };
      }
    }

    case 'elementVisible': {
      try {
        const selectors = Array.isArray(condition.selector)
          ? condition.selector
          : [condition.selector];
        for (const sel of selectors) {
          const visible = await page.waitFor(sel, {
            timeout: 2000,
            optional: true,
            state: 'visible',
          });
          if (visible) {
            return { condition, matched: true, detail: `Element "${sel}" is visible` };
          }
        }
        return { condition, matched: false, detail: 'No matching visible element found' };
      } catch {
        return { condition, matched: false, detail: 'Visibility check failed' };
      }
    }

    case 'elementHidden': {
      try {
        const selectors = Array.isArray(condition.selector)
          ? condition.selector
          : [condition.selector];
        for (const sel of selectors) {
          const visible = await page.waitFor(sel, {
            timeout: 500,
            optional: true,
            state: 'visible',
          });
          if (visible) {
            return { condition, matched: false, detail: `Element "${sel}" is still visible` };
          }
        }
        return { condition, matched: true, detail: 'Element is hidden or not found' };
      } catch {
        return { condition, matched: true, detail: 'Element is hidden (check threw)' };
      }
    }

    case 'textAppears': {
      try {
        const selector = Array.isArray(condition.selector)
          ? condition.selector[0]
          : condition.selector;
        const text = await page.text(selector);
        const matched = text.includes(condition.text);
        return {
          condition,
          matched,
          detail: matched
            ? `Text "${condition.text}" found`
            : `Text "${condition.text}" not found in page content`,
        };
      } catch {
        return { condition, matched: false, detail: 'Failed to get page text' };
      }
    }

    case 'textChanges': {
      try {
        const selector = Array.isArray(condition.selector)
          ? condition.selector[0]
          : condition.selector;
        const text = await page.text(selector);
        if (condition.to !== undefined) {
          const matched = text.includes(condition.to);
          return {
            condition,
            matched,
            detail: matched
              ? `Text changed to include "${condition.to}"`
              : `Text does not include "${condition.to}"`,
          };
        }
        // Without `to`, we can only check if state signature changed
        // This is a loose check - if there's no `to`, we return true
        // (the stateSignatureChanges condition is more appropriate for general change detection)
        return { condition, matched: true, detail: 'textChanges without `to` defaults to true' };
      } catch {
        return { condition, matched: false, detail: 'Failed to get text for change detection' };
      }
    }

    case 'networkResponse': {
      const tracker = context.networkTracker;
      if (!tracker) {
        return { condition, matched: false, detail: 'No network tracker active' };
      }
      const regex = globToRegex(condition.urlPattern);
      const responses = tracker.getResponses();
      for (const resp of responses) {
        if (regex.test(resp.url)) {
          if (condition.status !== undefined && resp.status !== condition.status) {
            continue;
          }
          return {
            condition,
            matched: true,
            detail: `Network response ${resp.url} (${resp.status}) matches pattern "${condition.urlPattern}"`,
          };
        }
      }
      return {
        condition,
        matched: false,
        detail: `No network response matching "${condition.urlPattern}" (saw ${responses.length} responses)`,
      };
    }

    case 'stateSignatureChanges': {
      if (!context.beforeSignature) {
        return { condition, matched: false, detail: 'No before-signature captured' };
      }
      const afterSignature = await captureStateSignature(page);
      const matched = afterSignature !== context.beforeSignature;
      return {
        condition,
        matched,
        detail: matched ? 'Page state changed' : 'Page state unchanged',
      };
    }

    default: {
      const _exhaustive: never = condition;
      return { condition: _exhaustive, matched: false, detail: 'Unknown condition kind' };
    }
  }
}

/**
 * Evaluate outcome conditions after a step has executed.
 *
 * Evaluation order:
 * 1. failIf conditions (any match = 'failed')
 * 2. expectAll conditions (all must match for success)
 * 3. expectAny conditions (any match = success)
 * 4. If no conditions matched and step mechanically succeeded, outcome is 'ambiguous'
 *
 * dangerous steps that result in 'ambiguous' get 'unsafe_to_retry'
 */
export async function evaluateOutcome(
  page: Page,
  options: {
    expectAny?: Condition[];
    expectAll?: Condition[];
    failIf?: Condition[];
    dangerous?: boolean;
    networkTracker?: NetworkResponseTracker;
    beforeSignature?: string;
  }
): Promise<{
  outcomeStatus: OutcomeStatus;
  matchedConditions: MatchedCondition[];
  retrySafe: boolean;
}> {
  const {
    expectAny,
    expectAll,
    failIf,
    dangerous = false,
    networkTracker,
    beforeSignature,
  } = options;
  const allMatched: MatchedCondition[] = [];
  const context = { networkTracker, beforeSignature };

  // 1. Check failIf conditions first (any match = failure)
  if (failIf && failIf.length > 0) {
    for (const condition of failIf) {
      const result = await evaluateCondition(condition, page, context);
      allMatched.push(result);
      if (result.matched) {
        return {
          outcomeStatus: 'failed',
          matchedConditions: allMatched,
          retrySafe: !dangerous,
        };
      }
    }
  }

  // 2. Check expectAll conditions (all must match)
  if (expectAll && expectAll.length > 0) {
    let allPassed = true;
    for (const condition of expectAll) {
      const result = await evaluateCondition(condition, page, context);
      allMatched.push(result);
      if (!result.matched) {
        allPassed = false;
      }
    }
    if (!allPassed) {
      const status: OutcomeStatus = dangerous ? 'unsafe_to_retry' : 'ambiguous';
      return {
        outcomeStatus: status,
        matchedConditions: allMatched,
        retrySafe: !dangerous,
      };
    }
    // If no expectAny, expectAll passing is sufficient for success
    if (!expectAny || expectAny.length === 0) {
      return {
        outcomeStatus: 'success',
        matchedConditions: allMatched,
        retrySafe: true,
      };
    }
  }

  // 3. Check expectAny conditions (any match = success)
  if (expectAny && expectAny.length > 0) {
    let anyPassed = false;
    for (const condition of expectAny) {
      const result = await evaluateCondition(condition, page, context);
      allMatched.push(result);
      if (result.matched) {
        anyPassed = true;
        // Don't break - evaluate all for reporting
      }
    }
    if (anyPassed) {
      return {
        outcomeStatus: 'success',
        matchedConditions: allMatched,
        retrySafe: true,
      };
    }
    const status: OutcomeStatus = dangerous ? 'unsafe_to_retry' : 'ambiguous';
    return {
      outcomeStatus: status,
      matchedConditions: allMatched,
      retrySafe: !dangerous,
    };
  }

  // 4. If expectAll passed but no expectAny was specified, already returned success above
  // If we reach here, no conditions were specified - shouldn't happen if called correctly
  return {
    outcomeStatus: 'success',
    matchedConditions: allMatched,
    retrySafe: true,
  };
}
