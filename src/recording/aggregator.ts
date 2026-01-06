/**
 * Event aggregation for recorded browser actions
 *
 * Transforms raw recorded events into clean Step[] output compatible
 * with page.batch() for replay.
 */

import type { RawRecordedEvent, RichStep, SelectorCandidate } from './types.ts';

/** Debounce window for input events in milliseconds */
const INPUT_DEBOUNCE_MS = 300;

/** Debounce window for navigation events in milliseconds */
const NAVIGATION_DEBOUNCE_MS = 500;

/**
 * Order selectors by quality.
 * Priority: role-name > text > aria-label > testid > stable-attr > id > css-path
 * Returns an array of selector strings ready for multi-selector use.
 */
export function selectBestSelectors(candidates: SelectorCandidate[]): string[] {
  const qualityOrder: Record<string, number> = {
    'role-name': 0,
    text: 1,
    'aria-label': 2,
    testid: 3,
    'stable-attr': 4,
    id: 5,
    'name-attr': 6,
    'css-path': 7,
  };

  // Sort by quality and extract selector strings
  const sorted = [...candidates].sort((a, b) => {
    const aOrder = qualityOrder[a.quality] ?? 8;
    const bOrder = qualityOrder[b.quality] ?? 8;
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
 * Generate a human-readable annotation for a recorded event.
 */
export function generateAnnotation(event: RawRecordedEvent): string {
  const { kind, element, url } = event;
  const name = element?.accessibleName || element?.text || element?.ariaLabel;
  const role = element?.computedRole || element?.role || element?.tag || '';

  switch (kind) {
    case 'click':
      if (name && role) {
        return `Clicked '${name}' ${role}`;
      } else if (name) {
        return `Clicked '${name}'`;
      } else if (role) {
        return `Clicked ${role}`;
      }
      return 'Clicked element';

    case 'dblclick':
      if (name && role) {
        return `Double-clicked '${name}' ${role}`;
      }
      return 'Double-clicked element';

    case 'input':
      if (name) {
        return `Filled '${name}' with value`;
      }
      return 'Filled input with value';

    case 'change':
      if (element?.type === 'checkbox' || element?.type === 'radio') {
        const action = event.checked ? 'Checked' : 'Unchecked';
        if (name) {
          return `${action} '${name}' ${element.type}`;
        }
        return `${action} ${element.type}`;
      }
      if (element?.tag === 'select') {
        if (name) {
          return `Selected option in '${name}'`;
        }
        return 'Selected option';
      }
      if (name) {
        return `Changed '${name}'`;
      }
      return 'Changed element';

    case 'submit':
      if (name) {
        return `Submitted '${name}' form`;
      }
      return 'Submitted form';

    case 'keydown':
      if (event.key === 'Enter') {
        return 'Pressed Enter';
      }
      return `Pressed ${event.key}`;

    case 'navigation':
      return `Navigated to ${url}`;

    default:
      if (name) {
        return `${kind} on '${name}'`;
      }
      return `${kind} on element`;
  }
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
 * Build element metadata for RichStep.
 */
function buildElementMeta(
  event: RawRecordedEvent
): { role?: string | null; name?: string | null; tag?: string } | undefined {
  const el = event.element;
  if (!el) return undefined;

  return {
    role: el.computedRole || el.role,
    name: el.accessibleName || el.text || el.ariaLabel,
    tag: el.tag,
  };
}

/**
 * Convert a raw event to a RichStep for replay with metadata.
 */
function eventToStep(event: RawRecordedEvent): RichStep | null {
  const selectors = selectBestSelectors(event.selectors);
  const elementMeta = buildElementMeta(event);
  const annotation = generateAnnotation(event);

  switch (event.kind) {
    case 'click':
    case 'dblclick':
      // dblclick is treated as click (Step doesn't have dblclick)
      if (selectors.length === 0) return null;
      return {
        action: 'click',
        selector: selectors.length === 1 ? selectors[0] : selectors,
        element: elementMeta,
        annotation,
      };

    case 'input':
      if (selectors.length === 0) return null;
      return {
        action: 'fill',
        selector: selectors.length === 1 ? selectors[0] : selectors,
        value: event.value ?? '',
        element: elementMeta,
        annotation,
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
          element: elementMeta,
          annotation,
        };
      }

      // Checkbox or radio
      if (type === 'checkbox' || type === 'radio') {
        return {
          action: event.checked ? 'check' : 'uncheck',
          selector: selectors.length === 1 ? selectors[0] : selectors,
          element: elementMeta,
          annotation,
        };
      }

      // Other change events (treat as fill)
      return {
        action: 'fill',
        selector: selectors.length === 1 ? selectors[0] : selectors,
        value: event.value ?? '',
        element: elementMeta,
        annotation,
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
          element: elementMeta,
          annotation,
        };
      }
      return null;

    case 'submit':
      if (selectors.length === 0) return null;
      return {
        action: 'submit',
        selector: selectors.length === 1 ? selectors[0] : selectors,
        element: elementMeta,
        annotation,
      };

    case 'navigation':
      return {
        action: 'goto',
        url: event.url,
        annotation,
      };

    default:
      return null;
  }
}

/**
 * Remove redundant steps (e.g., submit after Enter key on same element).
 */
function deduplicateSteps(steps: RichStep[]): RichStep[] {
  const result: RichStep[] = [];

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
 * Aggregate raw recorded events into clean RichStep[] output.
 * This is the main entry point for event processing.
 *
 * @param events - Raw events captured from the browser
 * @param startUrl - Optional starting URL to detect initial navigation
 */
export function aggregateEvents(events: RawRecordedEvent[], startUrl?: string): RichStep[] {
  if (events.length === 0) return [];

  // Step 1: Insert navigation steps for URL changes
  let processed = insertNavigationSteps(events, startUrl);

  // Step 2: Debounce navigation events
  processed = debounceNavigationEvents(processed);

  // Step 3: Debounce input events
  processed = debounceInputEvents(processed);

  // Step 4: Convert to steps
  const steps: RichStep[] = [];
  for (const event of processed) {
    const step = eventToStep(event);
    if (step) {
      steps.push(step);
    }
  }

  // Step 5: Deduplicate
  return deduplicateSteps(steps);
}
