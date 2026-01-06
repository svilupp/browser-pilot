/**
 * Event aggregation for recorded browser actions
 *
 * Transforms raw recorded events into clean Step[] output compatible
 * with page.batch() for replay.
 */

import type { Step } from '../actions/types.ts';
import type { RawRecordedEvent, SelectorCandidate } from './types.ts';

/** Debounce window for input events in milliseconds */
const INPUT_DEBOUNCE_MS = 300;

/** Debounce window for navigation events in milliseconds */
const NAVIGATION_DEBOUNCE_MS = 500;

/**
 * Order selectors by quality (stable-attr > id > css-path).
 * Returns an array of selector strings ready for multi-selector use.
 */
export function selectBestSelectors(candidates: SelectorCandidate[]): string[] {
  const qualityOrder: Record<string, number> = {
    'stable-attr': 0,
    id: 1,
    'css-path': 2,
  };

  // Sort by quality and extract selector strings
  const sorted = [...candidates].sort((a, b) => {
    const aOrder = qualityOrder[a.quality] ?? 3;
    const bOrder = qualityOrder[b.quality] ?? 3;
    return aOrder - bOrder;
  });

  // Remove duplicates while preserving order
  const seen = new Set<string>();
  const result: string[] = [];
  for (const candidate of sorted) {
    if (!seen.has(candidate.selector)) {
      seen.add(candidate.selector);
      result.push(candidate.selector);
    }
  }

  return result;
}

/**
 * Debounce input events: multiple inputs to same element within
 * the debounce window become a single event with the final value.
 */
export function debounceInputEvents(events: RawRecordedEvent[]): RawRecordedEvent[] {
  const result: RawRecordedEvent[] = [];

  for (let i = 0; i < events.length; i++) {
    const event = events[i]!;

    // Only debounce input events
    if (event.kind !== 'input') {
      result.push(event);
      continue;
    }

    // Find the primary selector for comparison
    const primarySelector = event.selectors[0]?.selector;
    if (!primarySelector) {
      result.push(event);
      continue;
    }

    // Look ahead for more input events to the same element within debounce window
    let finalEvent = event;
    let j = i + 1;

    while (j < events.length) {
      const nextEvent = events[j]!;

      // Stop if too much time has passed
      if (nextEvent.timestamp - finalEvent.timestamp > INPUT_DEBOUNCE_MS) {
        break;
      }

      // Stop if it's not an input event
      if (nextEvent.kind !== 'input') {
        break;
      }

      // Check if it's the same element
      const nextPrimarySelector = nextEvent.selectors[0]?.selector;
      if (nextPrimarySelector !== primarySelector) {
        break;
      }

      // This is a follow-up input to the same element - use it as final
      finalEvent = nextEvent;
      j++;
    }

    // Skip to after the last merged event
    i = j - 1;
    result.push(finalEvent);
  }

  return result;
}

/**
 * Debounce navigation events: rapid URL changes produce a single goto.
 */
function debounceNavigationEvents(events: RawRecordedEvent[]): RawRecordedEvent[] {
  const result: RawRecordedEvent[] = [];

  for (let i = 0; i < events.length; i++) {
    const event = events[i]!;

    // Only debounce navigation events
    if (event.kind !== 'navigation') {
      result.push(event);
      continue;
    }

    // Look ahead for more navigation events within debounce window
    let finalEvent = event;
    let j = i + 1;

    while (j < events.length) {
      const nextEvent = events[j]!;

      // Stop if too much time has passed
      if (nextEvent.timestamp - finalEvent.timestamp > NAVIGATION_DEBOUNCE_MS) {
        break;
      }

      // Stop if it's not a navigation event
      if (nextEvent.kind !== 'navigation') {
        break;
      }

      // This is a follow-up navigation - use it as final
      finalEvent = nextEvent;
      j++;
    }

    // Skip to after the last merged event
    i = j - 1;
    result.push(finalEvent);
  }

  return result;
}

/**
 * Insert goto steps when URL changes between events.
 * If startUrl is provided, also inserts a goto for the first event if its URL differs.
 */
function insertNavigationSteps(events: RawRecordedEvent[], startUrl?: string): RawRecordedEvent[] {
  const result: RawRecordedEvent[] = [];
  let lastUrl: string | null = startUrl || null;

  for (const event of events) {
    // Check if URL changed
    if (lastUrl !== null && event.url !== lastUrl) {
      // Insert a navigation event
      result.push({
        kind: 'navigation',
        timestamp: event.timestamp,
        url: event.url,
        selectors: [],
      });
    }

    result.push(event);
    lastUrl = event.url;
  }

  return result;
}

/**
 * Convert a raw event to a Step for replay.
 */
function eventToStep(event: RawRecordedEvent): Step | null {
  const selectors = selectBestSelectors(event.selectors);

  switch (event.kind) {
    case 'click':
    case 'dblclick':
      // dblclick is treated as click (Step doesn't have dblclick)
      if (selectors.length === 0) return null;
      return {
        action: 'click',
        selector: selectors.length === 1 ? selectors[0] : selectors,
      };

    case 'input':
      if (selectors.length === 0) return null;
      return {
        action: 'fill',
        selector: selectors.length === 1 ? selectors[0] : selectors,
        value: event.value ?? '',
      };

    case 'change': {
      if (selectors.length === 0) return null;
      const element = event.element;
      const tag = element?.tag;
      const type = element?.type?.toLowerCase();

      // Select element
      if (tag === 'select') {
        return {
          action: 'select',
          selector: selectors.length === 1 ? selectors[0] : selectors,
          value: event.value ?? '',
        };
      }

      // Checkbox or radio
      if (type === 'checkbox' || type === 'radio') {
        return {
          action: event.checked ? 'check' : 'uncheck',
          selector: selectors.length === 1 ? selectors[0] : selectors,
        };
      }

      // Other change events (treat as fill)
      return {
        action: 'fill',
        selector: selectors.length === 1 ? selectors[0] : selectors,
        value: event.value ?? '',
      };
    }

    case 'keydown':
      // Enter key press - treat as submit
      if (event.key === 'Enter') {
        if (selectors.length === 0) return null;
        return {
          action: 'submit',
          selector: selectors.length === 1 ? selectors[0] : selectors,
          method: 'enter',
        };
      }
      return null;

    case 'submit':
      if (selectors.length === 0) return null;
      return {
        action: 'submit',
        selector: selectors.length === 1 ? selectors[0] : selectors,
      };

    case 'navigation':
      return {
        action: 'goto',
        url: event.url,
      };

    default:
      return null;
  }
}

/**
 * Remove redundant steps (e.g., submit after Enter key on same element).
 */
function deduplicateSteps(steps: Step[]): Step[] {
  const result: Step[] = [];

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i]!;
    const prevStep = result[result.length - 1];

    // Skip submit if previous step was already a submit on same selector
    if (
      step.action === 'submit' &&
      prevStep?.action === 'submit' &&
      JSON.stringify(step.selector) === JSON.stringify(prevStep.selector)
    ) {
      continue;
    }

    result.push(step);
  }

  return result;
}

/**
 * Aggregate raw recorded events into clean Step[] output.
 * This is the main entry point for event processing.
 *
 * @param events - Raw events captured from the browser
 * @param startUrl - Optional starting URL to detect initial navigation
 */
export function aggregateEvents(events: RawRecordedEvent[], startUrl?: string): Step[] {
  if (events.length === 0) return [];

  // Step 1: Insert navigation steps for URL changes
  let processed = insertNavigationSteps(events, startUrl);

  // Step 2: Debounce navigation events
  processed = debounceNavigationEvents(processed);

  // Step 3: Debounce input events
  processed = debounceInputEvents(processed);

  // Step 4: Convert to steps
  const steps: Step[] = [];
  for (const event of processed) {
    const step = eventToStep(event);
    if (step) {
      steps.push(step);
    }
  }

  // Step 5: Deduplicate
  return deduplicateSteps(steps);
}
