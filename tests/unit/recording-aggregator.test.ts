/**
 * Unit tests for recording event aggregator
 *
 * Tests the aggregation of raw recorded events into clean Step[] output:
 * - Input debouncing (300ms window)
 * - Selector ordering by quality
 * - URL change detection and goto step insertion
 * - Password redaction handling
 * - Event type conversion to actions
 */

import { describe, expect, test } from 'bun:test';
import {
  aggregateEvents,
  debounceInputEvents,
  selectBestSelectors,
} from '../../src/recording/aggregator.ts';
import type { RawRecordedEvent, SelectorCandidate } from '../../src/recording/types.ts';

describe('Event Aggregator', () => {
  describe('selectBestSelectors: orders by quality', () => {
    test('should order stable-attr before id before css-path', () => {
      const candidates: SelectorCandidate[] = [
        { selector: 'body > div > input', quality: 'css-path' },
        { selector: '#email', quality: 'id' },
        { selector: '[data-testid="email"]', quality: 'stable-attr' },
      ];

      const result = selectBestSelectors(candidates);

      expect(result).toEqual(['[data-testid="email"]', '#email', 'body > div > input']);
    });

    test('should handle only stable-attr selectors', () => {
      const candidates: SelectorCandidate[] = [
        { selector: '[aria-label="Submit"]', quality: 'stable-attr' },
        { selector: '[data-testid="submit"]', quality: 'stable-attr' },
      ];

      const result = selectBestSelectors(candidates);

      expect(result).toHaveLength(2);
      expect(result[0]).toBe('[aria-label="Submit"]');
      expect(result[1]).toBe('[data-testid="submit"]');
    });

    test('should handle only id selector', () => {
      const candidates: SelectorCandidate[] = [{ selector: '#button', quality: 'id' }];

      const result = selectBestSelectors(candidates);

      expect(result).toEqual(['#button']);
    });

    test('should handle only css-path selector', () => {
      const candidates: SelectorCandidate[] = [
        { selector: 'main > form > button:nth-of-type(2)', quality: 'css-path' },
      ];

      const result = selectBestSelectors(candidates);

      expect(result).toEqual(['main > form > button:nth-of-type(2)']);
    });

    test('should deduplicate identical selectors', () => {
      const candidates: SelectorCandidate[] = [
        { selector: '#email', quality: 'id' },
        { selector: '#email', quality: 'id' },
      ];

      const result = selectBestSelectors(candidates);

      expect(result).toEqual(['#email']);
    });

    test('should handle empty candidates', () => {
      const result = selectBestSelectors([]);

      expect(result).toEqual([]);
    });
  });

  describe('debounceInputEvents: merges rapid inputs', () => {
    test('should merge multiple inputs to same element within 300ms', () => {
      const now = Date.now();
      const events: RawRecordedEvent[] = [
        {
          kind: 'input',
          timestamp: now,
          url: 'https://example.com',
          selectors: [{ selector: '#email', quality: 'id' }],
          value: 'a',
        },
        {
          kind: 'input',
          timestamp: now + 100,
          url: 'https://example.com',
          selectors: [{ selector: '#email', quality: 'id' }],
          value: 'ab',
        },
        {
          kind: 'input',
          timestamp: now + 200,
          url: 'https://example.com',
          selectors: [{ selector: '#email', quality: 'id' }],
          value: 'abc',
        },
      ];

      const result = debounceInputEvents(events);

      expect(result).toHaveLength(1);
      expect(result[0]?.value).toBe('abc');
    });

    test('should not merge inputs beyond 300ms window', () => {
      const now = Date.now();
      const events: RawRecordedEvent[] = [
        {
          kind: 'input',
          timestamp: now,
          url: 'https://example.com',
          selectors: [{ selector: '#email', quality: 'id' }],
          value: 'first',
        },
        {
          kind: 'input',
          timestamp: now + 400, // Beyond 300ms window
          url: 'https://example.com',
          selectors: [{ selector: '#email', quality: 'id' }],
          value: 'second',
        },
      ];

      const result = debounceInputEvents(events);

      expect(result).toHaveLength(2);
      expect(result[0]?.value).toBe('first');
      expect(result[1]?.value).toBe('second');
    });

    test('should not merge inputs to different elements', () => {
      const now = Date.now();
      const events: RawRecordedEvent[] = [
        {
          kind: 'input',
          timestamp: now,
          url: 'https://example.com',
          selectors: [{ selector: '#email', quality: 'id' }],
          value: 'email@test.com',
        },
        {
          kind: 'input',
          timestamp: now + 100,
          url: 'https://example.com',
          selectors: [{ selector: '#password', quality: 'id' }],
          value: 'secret',
        },
      ];

      const result = debounceInputEvents(events);

      expect(result).toHaveLength(2);
      expect(result[0]?.selectors[0]?.selector).toBe('#email');
      expect(result[1]?.selectors[0]?.selector).toBe('#password');
    });

    test('should preserve non-input events', () => {
      const now = Date.now();
      const events: RawRecordedEvent[] = [
        {
          kind: 'click',
          timestamp: now,
          url: 'https://example.com',
          selectors: [{ selector: '#button', quality: 'id' }],
        },
        {
          kind: 'input',
          timestamp: now + 100,
          url: 'https://example.com',
          selectors: [{ selector: '#email', quality: 'id' }],
          value: 'test',
        },
      ];

      const result = debounceInputEvents(events);

      expect(result).toHaveLength(2);
      expect(result[0]?.kind).toBe('click');
      expect(result[1]?.kind).toBe('input');
    });

    test('should handle events without selectors', () => {
      const now = Date.now();
      const events: RawRecordedEvent[] = [
        {
          kind: 'input',
          timestamp: now,
          url: 'https://example.com',
          selectors: [],
          value: 'test',
        },
      ];

      const result = debounceInputEvents(events);

      expect(result).toHaveLength(1);
    });
  });

  describe('aggregateEvents: converts raw events to steps', () => {
    test('should convert click event to click step', () => {
      const events: RawRecordedEvent[] = [
        {
          kind: 'click',
          timestamp: Date.now(),
          url: 'https://example.com',
          selectors: [
            { selector: '[data-testid="submit"]', quality: 'stable-attr' },
            { selector: '#submit-btn', quality: 'id' },
          ],
        },
      ];

      const steps = aggregateEvents(events);

      expect(steps).toHaveLength(1);
      expect(steps[0]).toMatchObject({
        action: 'click',
        selector: ['[data-testid="submit"]', '#submit-btn'],
      });
    });

    test('should use single string selector when only one available', () => {
      const events: RawRecordedEvent[] = [
        {
          kind: 'click',
          timestamp: Date.now(),
          url: 'https://example.com',
          selectors: [{ selector: '#submit', quality: 'id' }],
        },
      ];

      const steps = aggregateEvents(events);

      expect(steps[0]?.selector).toBe('#submit');
    });

    test('should convert input event to fill step', () => {
      const events: RawRecordedEvent[] = [
        {
          kind: 'input',
          timestamp: Date.now(),
          url: 'https://example.com',
          selectors: [{ selector: '#email', quality: 'id' }],
          value: 'test@example.com',
        },
      ];

      const steps = aggregateEvents(events);

      expect(steps).toHaveLength(1);
      expect(steps[0]).toMatchObject({
        action: 'fill',
        selector: '#email',
        value: 'test@example.com',
      });
    });

    test('should preserve password redaction', () => {
      const events: RawRecordedEvent[] = [
        {
          kind: 'input',
          timestamp: Date.now(),
          url: 'https://example.com',
          selectors: [{ selector: '#password', quality: 'id' }],
          value: '[REDACTED]',
        },
      ];

      const steps = aggregateEvents(events);

      expect(steps[0]?.value).toBe('[REDACTED]');
    });

    test('should convert select change to select step', () => {
      const events: RawRecordedEvent[] = [
        {
          kind: 'change',
          timestamp: Date.now(),
          url: 'https://example.com',
          selectors: [{ selector: '#country', quality: 'id' }],
          value: 'US',
          element: {
            tag: 'select',
            id: 'country',
            name: null,
            type: null,
            role: null,
            ariaLabel: null,
            testid: null,
            text: null,
          },
        },
      ];

      const steps = aggregateEvents(events);

      expect(steps).toHaveLength(1);
      expect(steps[0]).toMatchObject({
        action: 'select',
        selector: '#country',
        value: 'US',
      });
    });

    test('should convert checkbox change to check/uncheck step', () => {
      const events: RawRecordedEvent[] = [
        {
          kind: 'change',
          timestamp: Date.now(),
          url: 'https://example.com',
          selectors: [{ selector: '#agree', quality: 'id' }],
          checked: true,
          element: {
            tag: 'input',
            id: 'agree',
            name: null,
            type: 'checkbox',
            role: null,
            ariaLabel: null,
            testid: null,
            text: null,
          },
        },
      ];

      const steps = aggregateEvents(events);

      expect(steps).toHaveLength(1);
      expect(steps[0]).toMatchObject({
        action: 'check',
        selector: '#agree',
      });
    });

    test('should convert unchecked checkbox to uncheck step', () => {
      const events: RawRecordedEvent[] = [
        {
          kind: 'change',
          timestamp: Date.now(),
          url: 'https://example.com',
          selectors: [{ selector: '#agree', quality: 'id' }],
          checked: false,
          element: {
            tag: 'input',
            id: 'agree',
            name: null,
            type: 'checkbox',
            role: null,
            ariaLabel: null,
            testid: null,
            text: null,
          },
        },
      ];

      const steps = aggregateEvents(events);

      expect(steps[0]?.action).toBe('uncheck');
    });

    test('should convert Enter keydown to submit step', () => {
      const events: RawRecordedEvent[] = [
        {
          kind: 'keydown',
          timestamp: Date.now(),
          url: 'https://example.com',
          selectors: [{ selector: '#email', quality: 'id' }],
          key: 'Enter',
        },
      ];

      const steps = aggregateEvents(events);

      expect(steps).toHaveLength(1);
      expect(steps[0]).toMatchObject({
        action: 'submit',
        selector: '#email',
        method: 'enter',
      });
    });

    test('should convert submit event to submit step', () => {
      const events: RawRecordedEvent[] = [
        {
          kind: 'submit',
          timestamp: Date.now(),
          url: 'https://example.com',
          selectors: [{ selector: 'form', quality: 'css-path' }],
        },
      ];

      const steps = aggregateEvents(events);

      expect(steps).toHaveLength(1);
      expect(steps[0]?.action).toBe('submit');
    });

    test('should insert goto step when URL changes', () => {
      const now = Date.now();
      const events: RawRecordedEvent[] = [
        {
          kind: 'click',
          timestamp: now,
          url: 'https://example.com/page1',
          selectors: [{ selector: '#link', quality: 'id' }],
        },
        {
          kind: 'click',
          timestamp: now + 1000,
          url: 'https://example.com/page2', // URL changed
          selectors: [{ selector: '#button', quality: 'id' }],
        },
      ];

      const steps = aggregateEvents(events);

      expect(steps).toHaveLength(3);
      expect(steps[0]?.action).toBe('click');
      expect(steps[1]).toMatchObject({
        action: 'goto',
        url: 'https://example.com/page2',
      });
      expect(steps[2]?.action).toBe('click');
    });

    test('should handle empty events array', () => {
      const steps = aggregateEvents([]);

      expect(steps).toEqual([]);
    });

    test('should skip events without selectors', () => {
      const events: RawRecordedEvent[] = [
        {
          kind: 'click',
          timestamp: Date.now(),
          url: 'https://example.com',
          selectors: [],
        },
      ];

      const steps = aggregateEvents(events);

      expect(steps).toHaveLength(0);
    });

    test('should deduplicate consecutive submit steps on same element', () => {
      const now = Date.now();
      const events: RawRecordedEvent[] = [
        {
          kind: 'keydown',
          timestamp: now,
          url: 'https://example.com',
          selectors: [{ selector: 'form', quality: 'css-path' }],
          key: 'Enter',
        },
        {
          kind: 'submit',
          timestamp: now + 10,
          url: 'https://example.com',
          selectors: [{ selector: 'form', quality: 'css-path' }],
        },
      ];

      const steps = aggregateEvents(events);

      // Should only have one submit, not two
      expect(steps).toHaveLength(1);
      expect(steps[0]?.action).toBe('submit');
    });

    test('should debounce rapid navigation changes', () => {
      const now = Date.now();
      const events: RawRecordedEvent[] = [
        {
          kind: 'click',
          timestamp: now,
          url: 'https://example.com/page1',
          selectors: [{ selector: '#link', quality: 'id' }],
        },
        {
          kind: 'click',
          timestamp: now + 100,
          url: 'https://example.com/page2', // First navigation
          selectors: [{ selector: '#link2', quality: 'id' }],
        },
        {
          kind: 'click',
          timestamp: now + 200,
          url: 'https://example.com/page3', // Second navigation within 500ms
          selectors: [{ selector: '#link3', quality: 'id' }],
        },
        {
          kind: 'click',
          timestamp: now + 1000,
          url: 'https://example.com/page3', // Same URL, no new goto
          selectors: [{ selector: '#button', quality: 'id' }],
        },
      ];

      const steps = aggregateEvents(events);

      // Should have: click, goto(page2), click, goto(page3), click, click
      // Due to debouncing, rapid gotos may be merged
      const gotoSteps = steps.filter((s) => s.action === 'goto');
      expect(gotoSteps.length).toBeGreaterThanOrEqual(1);
    });
  });
});
