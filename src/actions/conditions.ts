/**
 * Condition evaluation for outcome-based execution
 */

import type { Page } from '../browser/page.ts';
import { captureStructureSignature } from '../browser/signature.ts';
import type { DispatchState } from '../browser/types.ts';
import type { CDPClient } from '../cdp/client.ts';
import type { TargetInfo } from '../cdp/protocol.ts';
import { globToRegex } from '../utils/strings.ts';
import type {
  ActionEffect,
  AssertionScope,
  Condition,
  MatchedCondition,
  OutcomeStatus,
  RetryDecisionReason,
  TextMatchMode,
  UrlMatchMode,
} from './types.ts';

export interface RetryDecision {
  retry: boolean;
  reason: RetryDecisionReason;
}

export interface ShouldRetryOptions {
  effect: ActionEffect;
  dangerous: boolean;
  dispatchState?: DispatchState;
  retrySafe?: boolean;
  /** Zero-based attempt number. */
  attempt: number;
  /** Total number of permitted attempts. */
  maxAttempts: number;
}

/**
 * The single retry-policy decision point for batch actions.
 *
 * A retry is a new dispatch, never a continuation of an uncertain one. The
 * only effectful retry permitted here is one with an explicit, proven
 * not-dispatched receipt and remaining attempts.
 */
export function shouldRetry(options: ShouldRetryOptions): RetryDecision {
  const { effect, dangerous, dispatchState, retrySafe, attempt, maxAttempts } = options;

  if (attempt + 1 >= maxAttempts) {
    return { retry: false, reason: 'max_attempts_reached' };
  }

  if (retrySafe === false) {
    return { retry: false, reason: 'retry_unsafe' };
  }

  if (dispatchState === 'dispatched' || dispatchState === 'uncertain') {
    return {
      retry: false,
      reason: dangerous ? 'dangerous_dispatched' : 'dispatch_already_attempted',
    };
  }

  if (dispatchState === undefined) {
    // Observation-only actions can safely be retried without a dispatch
    // receipt. Effectful actions fail closed when their receipt is missing.
    return effect === 'observe'
      ? { retry: true, reason: 'retry_allowed_pre_dispatch' }
      : { retry: false, reason: 'missing_retry_metadata' };
  }

  if (retrySafe !== true) {
    return {
      retry: false,
      reason: dangerous ? 'dangerous_pre_dispatch_not_explicit' : 'missing_retry_metadata',
    };
  }

  return { retry: true, reason: 'retry_allowed_pre_dispatch' };
}

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

export interface AssertionBeforeState {
  url: string;
  targetIds: string[];
  fields: Record<string, string | null>;
  texts: Record<string, string>;
  capturedAt: string;
}

export function matchUrl(
  actual: string,
  expected: string,
  mode: UrlMatchMode = 'contains'
): boolean {
  if (mode === 'exact') return actual === expected;
  if (mode === 'glob') return globToRegex(expected).test(actual);
  if (mode === 'origin_path') {
    try {
      const normalize = (value: string): string => {
        const parsed = new URL(value);
        const path = parsed.pathname.replace(/\/$/, '') || '/';
        return `${parsed.origin}${path}`;
      };
      return normalize(actual) === normalize(expected);
    } catch {
      return actual === expected;
    }
  }
  return actual.includes(expected);
}

export function matchText(
  actual: string,
  expected: string,
  mode: TextMatchMode = 'contains'
): boolean {
  if (mode === 'exact') return actual === expected;
  if (mode === 'regex') {
    try {
      return new RegExp(expected).test(actual);
    } catch {
      return false;
    }
  }
  return actual.includes(expected);
}

function firstSelector(selector: string | string[] | undefined): string | undefined {
  return Array.isArray(selector) ? selector[0] : selector;
}

function landmarkSelector(landmark: string | undefined): string | undefined {
  if (!landmark) return undefined;
  const value = landmark.trim();
  if (!value) return undefined;
  if (value.startsWith('.') || value.startsWith('#') || value.startsWith('[')) return value;
  const safe = value.replace(/[^a-zA-Z0-9_-]/g, '');
  return safe ? `${safe},[role="${safe}"]` : undefined;
}

function scopeParts(
  scope: AssertionScope | undefined,
  landmark?: string
): {
  selector?: string;
  landmark?: string;
} {
  return {
    selector: firstSelector(scope?.selector),
    landmark: landmarkSelector(landmark ?? scope?.landmark),
  };
}

export async function readScopedText(
  page: Page,
  selector?: string | string[],
  scope?: AssertionScope,
  landmark?: string
): Promise<string> {
  const parts = scopeParts(scope, landmark);
  const targetSelector = firstSelector(selector);
  const scopeSelector = parts.selector;
  if (!parts.landmark && !scopeSelector) return page.text(targetSelector);
  if (typeof page.evaluate !== 'function') return page.text(firstSelector(selector));
  const value = await page.evaluate<unknown>(`(() => {
    const landmarkRoots = ${JSON.stringify(parts.landmark)}
      ? Array.from(document.querySelectorAll(${JSON.stringify(parts.landmark)}))
      : [document];
    const scopeSelector = ${JSON.stringify(scopeSelector ?? null)};
    const roots = scopeSelector
      ? landmarkRoots.flatMap((root) => Array.from(root.querySelectorAll(scopeSelector)))
      : landmarkRoots;
    const targetSelector = ${JSON.stringify(targetSelector ?? null)};
    const elements = targetSelector
      ? roots.flatMap((root) => Array.from(root.querySelectorAll(targetSelector)))
      : roots;
    return elements.map((element) => element.innerText || element.textContent || '').join('\\n').trim();
  })()`);
  return typeof value === 'string' ? value : '';
}

export async function readScopedElementState(
  page: Page,
  selector: string | string[],
  landmark?: string
): Promise<{ value: string | null; checked: boolean | null; disabled: boolean; text: string }> {
  const parts = scopeParts(undefined, landmark);
  const candidate = firstSelector(selector);
  if (typeof page.evaluate !== 'function') {
    return { value: null, checked: null, disabled: false, text: await page.text(candidate) };
  }
  const value = await page.evaluate<unknown>(`(() => {
    const roots = ${JSON.stringify(parts.landmark)}
      ? Array.from(document.querySelectorAll(${JSON.stringify(parts.landmark)}))
      : [document];
    const selector = ${JSON.stringify(candidate)};
    const element = roots.flatMap((root) => Array.from(root.querySelectorAll(selector)))[0];
    if (!element) return null;
    const input = element;
    const ariaChecked = input.getAttribute('aria-checked');
    return {
      value: 'value' in input ? String(input.value ?? '') : null,
      checked: 'checked' in input ? Boolean(input.checked) : ariaChecked === 'true' ? true : ariaChecked === 'false' ? false : null,
      disabled: Boolean(input.disabled) || input.getAttribute('aria-disabled') === 'true',
      text: String(input.innerText || input.textContent || '').trim(),
    };
  })()`);
  if (!value || typeof value !== 'object')
    return { value: null, checked: null, disabled: false, text: '' };
  const state = value as Record<string, unknown>;
  return {
    value: typeof state['value'] === 'string' ? state['value'] : null,
    checked: typeof state['checked'] === 'boolean' ? state['checked'] : null,
    disabled: state['disabled'] === true,
    text: typeof state['text'] === 'string' ? state['text'] : '',
  };
}

async function getTargetInfos(page: Page): Promise<TargetInfo[]> {
  try {
    const result = await page.cdpClient.send<{ targetInfos?: TargetInfo[] }>(
      'Target.getTargets',
      undefined,
      null
    );
    return result.targetInfos ?? [];
  } catch {
    return [];
  }
}

function conditionSelectors(condition: Condition): string[] {
  if (condition.kind === 'fieldChanged' || condition.kind === 'fieldValue') {
    return Array.isArray(condition.selector) ? condition.selector : [condition.selector];
  }
  if (condition.kind === 'textChanges' && condition.selector) {
    return Array.isArray(condition.selector) ? condition.selector : [condition.selector];
  }
  return [];
}

/** Capture values used by transition conditions before a step dispatches. */
export async function captureBeforeState(
  page: Page,
  conditions: Condition[]
): Promise<AssertionBeforeState> {
  const url = await page.url().catch(() => '');
  const targets = await getTargetInfos(page);
  const fields: Record<string, string | null> = {};
  const texts: Record<string, string> = {};
  for (const condition of conditions) {
    for (const selector of conditionSelectors(condition)) {
      if (condition.kind === 'textChanges') {
        texts[selector] = await readScopedText(
          page,
          selector,
          condition.scope,
          condition.landmark
        ).catch(() => '');
      } else {
        fields[selector] = (
          await readScopedElementState(
            page,
            selector,
            condition.kind === 'fieldChanged' || condition.kind === 'fieldValue'
              ? condition.landmark
              : undefined
          ).catch(() => ({ value: null, checked: null, disabled: false, text: '' }))
        ).value;
      }
    }
  }
  return {
    url,
    targetIds: targets.filter((target) => target.type === 'page').map((target) => target.targetId),
    fields,
    texts,
    capturedAt: new Date().toISOString(),
  };
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
    beforeStructureSignature?: string;
    beforeState?: AssertionBeforeState;
  } = {}
): Promise<MatchedCondition> {
  switch (condition.kind) {
    case 'urlMatches': {
      try {
        const currentUrl = await page.url();
        // Existing outcome conditions used glob semantics. Keep that default;
        // callers opt into exact/origin_path/contains explicitly.
        const matched = matchUrl(
          currentUrl,
          condition.pattern,
          condition.mode ?? condition.match ?? 'glob'
        );
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
        const text = await readScopedText(
          page,
          condition.selector,
          condition.scope,
          condition.landmark
        );
        const matched = matchText(text, condition.text, condition.mode ?? condition.match);
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
        const selector = firstSelector(condition.selector);
        const text = await readScopedText(page, selector, condition.scope, condition.landmark);
        if (condition.to !== undefined) {
          const matched =
            matchText(text, condition.to, condition.mode ?? condition.match) &&
            (condition.from === undefined ||
              context.beforeState?.texts[selector ?? ''] === condition.from);
          return {
            condition,
            matched,
            detail: matched
              ? `Text changed to include "${condition.to}"`
              : `Text does not include "${condition.to}"`,
          };
        }
        const before = context.beforeState?.texts[selector ?? ''];
        const matched = before === undefined ? true : before !== text;
        return {
          condition,
          matched,
          detail:
            before === undefined
              ? 'textChanges without `to` defaults to true'
              : 'Text changed from captured state',
        };
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
      const isStructure = condition.mode === 'structure';
      // Compare like-for-like: a structural condition must diff against the
      // structural before-signature (and text against the text one). Comparing
      // a structural "after" to a text "before" would always report a change.
      const beforeSignature = isStructure
        ? context.beforeStructureSignature
        : context.beforeSignature;
      if (!beforeSignature) {
        return { condition, matched: false, detail: 'No before-signature captured' };
      }
      const afterSignature = isStructure
        ? await captureStructureSignature(page)
        : await captureStateSignature(page);
      const matched = afterSignature !== beforeSignature;
      return {
        condition,
        matched,
        detail: matched ? 'Page state changed' : 'Page state unchanged',
      };
    }

    case 'selectedTab': {
      const selector =
        condition.selector ?? '[role="tab"][aria-selected="true"], [aria-current="page"]';
      const visible = await page.waitFor(firstSelector(selector)!, {
        timeout: 2000,
        optional: true,
        state: 'visible',
      });
      if (!visible) return { condition, matched: false, detail: 'No selected tab is visible' };
      if (condition.name) {
        const text = await readScopedText(page, selector, undefined, condition.landmark);
        const matched = text.trim() === condition.name;
        return {
          condition,
          matched,
          detail: matched
            ? `Selected tab is "${condition.name}"`
            : `Selected tab is not "${condition.name}"`,
        };
      }
      return { condition, matched: true, detail: 'Selected tab is visible' };
    }

    case 'fieldValue': {
      const actual = await readScopedElementState(page, condition.selector, condition.landmark);
      const matched = actual.value === condition.value;
      return {
        condition,
        matched,
        detail: matched
          ? 'Field value matches exactly'
          : `Field value is ${JSON.stringify(actual.value)}`,
      };
    }

    case 'checkbox':
    case 'switch': {
      const actual = await readScopedElementState(page, condition.selector, condition.landmark);
      const matched = actual.checked === condition.checked;
      return {
        condition,
        matched,
        detail: matched
          ? `${condition.kind} state matches`
          : `${condition.kind} is ${String(actual.checked)}`,
      };
    }

    case 'elementEnabled': {
      const actual = await readScopedElementState(page, condition.selector, condition.landmark);
      const expected = condition.enabled ?? true;
      const matched = !actual.disabled === expected;
      return {
        condition,
        matched,
        detail: matched
          ? `Element is ${expected ? 'enabled' : 'disabled'}`
          : `Element is ${actual.disabled ? 'disabled' : 'enabled'}`,
      };
    }

    case 'targetCount': {
      const targets = await getTargetInfos(page);
      const count = targets.filter((target) => target.type === (condition.type ?? 'page')).length;
      const matched = count === condition.count;
      return {
        condition,
        matched,
        detail: `Target count is ${count}; expected ${condition.count}`,
      };
    }

    case 'newTarget': {
      const targets = await getTargetInfos(page);
      const before = new Set(context.beforeState?.targetIds ?? []);
      const candidate = targets.find(
        (target) =>
          !before.has(target.targetId) &&
          (!condition.targetId || target.targetId === condition.targetId) &&
          (!condition.openerTargetId || target.openerId === condition.openerTargetId) &&
          (!condition.type || target.type === condition.type) &&
          (!condition.url || target.url.includes(condition.url))
      );
      return {
        condition,
        matched: candidate !== undefined,
        detail: candidate
          ? `New target ${candidate.targetId} exists`
          : 'No matching new target exists',
      };
    }

    case 'urlChanged': {
      const current = await page.url().catch(() => '');
      const before = context.beforeState?.url;
      const matched =
        before !== undefined &&
        current !== before &&
        (condition.from === undefined || matchUrl(before, condition.from, condition.mode));
      return {
        condition,
        matched,
        detail: matched
          ? `URL changed from ${before} to ${current}`
          : 'URL did not change from captured state',
      };
    }

    case 'fieldChanged': {
      const selector = firstSelector(condition.selector) ?? '';
      const actual = await readScopedElementState(page, selector, condition.landmark);
      const before = context.beforeState?.fields[selector];
      const matched =
        before !== undefined &&
        before !== actual.value &&
        (condition.from === undefined || before === condition.from) &&
        (condition.to === undefined || actual.value === condition.to);
      return {
        condition,
        matched,
        detail: matched
          ? `Field ${selector} changed`
          : `Field ${selector} did not change from captured state`,
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
    beforeStructureSignature?: string;
    beforeState?: AssertionBeforeState;
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
    beforeStructureSignature,
    beforeState,
  } = options;
  const allMatched: MatchedCondition[] = [];
  const context = { networkTracker, beforeSignature, beforeStructureSignature, beforeState };

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
