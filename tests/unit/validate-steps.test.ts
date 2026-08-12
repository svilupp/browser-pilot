import { describe, expect, test } from 'bun:test';
import { validateSteps } from '../../src/actions/validate.ts';

describe('validateSteps', () => {
  describe('action name resolution', () => {
    test('valid action passes', () => {
      const result = validateSteps([{ action: 'click', selector: '#btn' }]);
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    test('all valid actions pass with required params', () => {
      const steps = [
        { action: 'goto', url: 'https://example.com' },
        { action: 'click', selector: '#btn' },
        { action: 'fill', selector: '#input', value: 'hello' },
        { action: 'type', selector: '#input', value: 'hello' },
        { action: 'select', selector: '#sel', value: 'opt1' },
        { action: 'check', selector: '#cb' },
        { action: 'uncheck', selector: '#cb' },
        { action: 'submit', selector: 'form' },
        { action: 'press', key: 'Enter' },
        { action: 'focus', selector: '#input' },
        { action: 'hover', selector: '#btn' },
        { action: 'scroll', direction: 'down' },
        { action: 'wait', timeout: 1000 },
        { action: 'snapshot' },
        { action: 'forms' },
        { action: 'screenshot' },
        { action: 'evaluate', value: 'document.title' },
        { action: 'text' },
        { action: 'newTab' },
        { action: 'newTab', background: false },
        { action: 'closeTab' },
        { action: 'switchFrame', selector: '#frame' },
        { action: 'switchToMain' },
      ];
      const result = validateSteps(steps);
      expect(result.valid).toBe(true);
    });

    test('alias suggests correct action', () => {
      const result = validateSteps([{ action: 'execute', value: '1+1' }]);
      expect(result.valid).toBe(false);
      expect(result.errors[0]!.message).toContain('Did you mean "evaluate"');
    });

    test('navigate → goto alias', () => {
      const result = validateSteps([{ action: 'navigate', url: 'https://example.com' }]);
      expect(result.valid).toBe(false);
      expect(result.errors[0]!.message).toContain('Did you mean "goto"');
    });

    test('typo suggests via Levenshtein', () => {
      const result = validateSteps([{ action: 'clik', selector: '#btn' }]);
      expect(result.valid).toBe(false);
      expect(result.errors[0]!.message).toContain('Did you mean "click"');
    });

    test('unknown action lists all valid actions', () => {
      const result = validateSteps([{ action: 'dance' }]);
      expect(result.valid).toBe(false);
      expect(result.errors[0]!.suggestion).toContain('goto');
      expect(result.errors[0]!.suggestion).toContain('evaluate');
    });
  });

  describe('required params', () => {
    test('goto needs url', () => {
      const result = validateSteps([{ action: 'goto' }]);
      expect(result.valid).toBe(false);
      expect(result.errors[0]!.field).toBe('url');
      expect(result.errors[0]!.message).toContain('missing required "url"');
    });

    test('click needs selector', () => {
      const result = validateSteps([{ action: 'click' }]);
      expect(result.valid).toBe(false);
      expect(result.errors[0]!.field).toBe('selector');
    });

    test('fill needs selector and value', () => {
      const result = validateSteps([{ action: 'fill' }]);
      expect(result.valid).toBe(false);
      expect(result.errors).toHaveLength(2);
      const fields = result.errors.map((e) => e.field);
      expect(fields).toContain('selector');
      expect(fields).toContain('value');
    });

    test('fill accepts verify as boolean, exact, or normalized', () => {
      expect(
        validateSteps([{ action: 'fill', selector: '#input', value: 'hi', verify: true }]).valid
      ).toBe(true);
      expect(
        validateSteps([{ action: 'fill', selector: '#input', value: 'hi', verify: false }]).valid
      ).toBe(true);
      expect(
        validateSteps([{ action: 'fill', selector: '#input', value: 'hi', verify: 'exact' }]).valid
      ).toBe(true);
      expect(
        validateSteps([{ action: 'fill', selector: '#input', value: 'hi', verify: 'normalized' }])
          .valid
      ).toBe(true);
    });

    test('fill rejects invalid verify value', () => {
      const result = validateSteps([
        { action: 'fill', selector: '#input', value: 'hi', verify: 'loose' as unknown as boolean },
      ]);
      expect(result.valid).toBe(false);
      expect(result.errors[0]!.field).toBe('verify');
    });

    test('press needs key', () => {
      const result = validateSteps([{ action: 'press' }]);
      expect(result.valid).toBe(false);
      expect(result.errors[0]!.field).toBe('key');
    });

    test('evaluate needs value', () => {
      const result = validateSteps([{ action: 'evaluate' }]);
      expect(result.valid).toBe(false);
      expect(result.errors[0]!.field).toBe('value');
    });

    test('switchFrame needs selector', () => {
      const result = validateSteps([{ action: 'switchFrame' }]);
      expect(result.valid).toBe(false);
      expect(result.errors[0]!.field).toBe('selector');
    });
  });

  describe('complex actions', () => {
    test('select with native selector+value passes', () => {
      const result = validateSteps([{ action: 'select', selector: '#sel', value: 'opt' }]);
      expect(result.valid).toBe(true);
    });

    test('select with custom trigger+option+value passes', () => {
      const result = validateSteps([
        { action: 'select', trigger: '.dropdown', option: '.item', value: 'opt' },
      ]);
      expect(result.valid).toBe(true);
    });

    test('select without required combo fails', () => {
      const result = validateSteps([{ action: 'select' }]);
      expect(result.valid).toBe(false);
      expect(result.errors[0]!.message).toContain('select requires either');
    });

    test('scroll with direction passes', () => {
      const result = validateSteps([{ action: 'scroll', direction: 'down', amount: 500 }]);
      expect(result.valid).toBe(true);
    });

    test('scroll with coordinates passes', () => {
      const result = validateSteps([{ action: 'scroll', x: 0, y: 100 }]);
      expect(result.valid).toBe(true);
    });

    test('scroll with selector passes', () => {
      const result = validateSteps([{ action: 'scroll', selector: '#content' }]);
      expect(result.valid).toBe(true);
    });

    test('wait with no params passes (simple delay)', () => {
      const result = validateSteps([{ action: 'wait' }]);
      expect(result.valid).toBe(true);
    });

    test('wait with selector and waitFor passes', () => {
      const result = validateSteps([{ action: 'wait', selector: '#loader', waitFor: 'hidden' }]);
      expect(result.valid).toBe(true);
    });

    test('wait with navigation waitFor passes', () => {
      const result = validateSteps([{ action: 'wait', waitFor: 'navigation' }]);
      expect(result.valid).toBe(true);
    });

    test('submit with auto navigation wait passes', () => {
      const result = validateSteps([
        { action: 'submit', selector: '#form', waitForNavigation: 'auto' },
      ]);
      expect(result.valid).toBe(true);
    });
  });

  describe('unknown properties', () => {
    test('expression → value auto-resolves', () => {
      const step = { action: 'evaluate', expression: 'document.title' } as Record<string, unknown>;
      const result = validateSteps([step]);
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
      expect(step['value']).toBe('document.title');
      expect('expression' in step).toBe(false);
    });

    test('href → url auto-resolves', () => {
      const step = { action: 'goto', href: 'https://example.com' } as Record<string, unknown>;
      const result = validateSteps([step]);
      expect(result.valid).toBe(true);
      expect(step['url']).toBe('https://example.com');
      expect('href' in step).toBe(false);
    });

    test('target → selector auto-resolves', () => {
      const step = { action: 'click', target: '#submit' } as Record<string, unknown>;
      const result = validateSteps([step]);
      expect(result.valid).toBe(true);
      expect(step['selector']).toBe('#submit');
    });

    test('canonical field wins on alias conflict', () => {
      const step = {
        action: 'evaluate',
        value: 'document.body',
        expression: 'document.title',
      } as Record<string, unknown>;
      const result = validateSteps([step]);
      expect(result.valid).toBe(true);
      expect(step['value']).toBe('document.body');
      expect('expression' in step).toBe(false);
    });

    test('typo selctor → selector via Levenshtein', () => {
      const result = validateSteps([{ action: 'click', selctor: '#btn' }]);
      expect(result.valid).toBe(false);
      const propErr = result.errors.find((e) => e.field === 'selctor');
      expect(propErr!.message).toContain('Did you mean "selector"');
    });

    test('completely unknown property has no suggestion', () => {
      const result = validateSteps([{ action: 'click', selector: '#btn', foobar: true }]);
      expect(result.valid).toBe(false);
      const propErr = result.errors.find((e) => e.field === 'foobar');
      expect(propErr!.message).toContain('unknown property "foobar"');
      expect(propErr!.suggestion).toBeUndefined();
    });
  });

  describe('type checks', () => {
    test('selector as number fails', () => {
      const result = validateSteps([{ action: 'click', selector: 123 }]);
      expect(result.valid).toBe(false);
      expect(result.errors[0]!.message).toContain('expected string or string[]');
    });

    test('timeout as string fails', () => {
      const result = validateSteps([{ action: 'click', selector: '#btn', timeout: '5000' }]);
      expect(result.valid).toBe(false);
      expect(result.errors[0]!.message).toContain('expected number');
    });

    test('value as number fails for fill', () => {
      const result = validateSteps([{ action: 'fill', selector: '#input', value: 42 }]);
      expect(result.valid).toBe(false);
      expect(result.errors[0]!.message).toContain('expected string');
    });

    test('invalid enum value for format fails', () => {
      const result = validateSteps([{ action: 'screenshot', format: 'gif' }]);
      expect(result.valid).toBe(false);
      expect(result.errors[0]!.message).toContain('must be one of');
    });

    test('invalid enum value for direction fails', () => {
      const result = validateSteps([{ action: 'scroll', direction: 'diagonal' }]);
      expect(result.valid).toBe(false);
      expect(result.errors[0]!.message).toContain('must be one of');
    });

    test('invalid enum value for waitFor fails', () => {
      const result = validateSteps([{ action: 'wait', selector: '#el', waitFor: 'gone' }]);
      expect(result.valid).toBe(false);
      expect(result.errors[0]!.message).toContain('must be one of');
    });

    test('selector as string[] passes', () => {
      const result = validateSteps([{ action: 'click', selector: ['#btn', '.fallback'] }]);
      expect(result.valid).toBe(true);
    });

    test('optional as non-boolean fails', () => {
      const result = validateSteps([{ action: 'snapshot', optional: 'yes' }]);
      expect(result.valid).toBe(false);
      expect(result.errors[0]!.message).toContain('expected boolean');
    });

    test('submit waitForNavigation rejects invalid strings', () => {
      const result = validateSteps([
        { action: 'submit', selector: '#form', waitForNavigation: 'later' },
      ]);
      expect(result.valid).toBe(false);
      expect(result.errors[0]!.message).toContain('expected boolean or "auto"');
    });
  });

  describe('edge cases', () => {
    test('empty array is valid', () => {
      const result = validateSteps([]);
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    test('non-object step fails', () => {
      const result = validateSteps(['click #btn']);
      expect(result.valid).toBe(false);
      expect(result.errors[0]!.message).toContain('must be a JSON object');
    });

    test('null step fails', () => {
      const result = validateSteps([null]);
      expect(result.valid).toBe(false);
      expect(result.errors[0]!.message).toContain('must be a JSON object');
    });

    test('missing action field', () => {
      const result = validateSteps([{ selector: '#btn' }]);
      expect(result.valid).toBe(false);
      expect(result.errors[0]!.message).toContain('missing required "action"');
    });

    test('action as number fails', () => {
      const result = validateSteps([{ action: 42 }]);
      expect(result.valid).toBe(false);
      expect(result.errors[0]!.message).toContain('must be a string');
    });

    test('array step fails', () => {
      const result = validateSteps([[{ action: 'click' }]]);
      expect(result.valid).toBe(false);
      expect(result.errors[0]!.message).toContain('must be a JSON object');
    });
  });

  describe('formatted output', () => {
    test('includes step index and JSON context', () => {
      const result = validateSteps([{ action: 'fill', selector: '#email' }]);
      const output = result.formatted();
      expect(output).toContain('Step 0');
      expect(output).toContain('missing required "value"');
      expect(output).toContain('Got:');
      expect(output).toContain('"action":"fill"');
    });

    test('includes valid actions list', () => {
      const result = validateSteps([{ action: 'dance' }]);
      const output = result.formatted();
      expect(output).toContain('Valid actions:');
      expect(output).toContain('goto');
      expect(output).toContain('evaluate');
    });

    test('reports error count', () => {
      const result = validateSteps([{ action: 'fill' }]);
      const output = result.formatted();
      expect(output).toContain('2 errors');
    });

    test('valid result returns empty string', () => {
      const result = validateSteps([{ action: 'snapshot' }]);
      expect(result.formatted()).toBe('');
    });

    test('multiple steps with errors show correct indices', () => {
      const result = validateSteps([
        { action: 'execute', value: '1+1' },
        { action: 'fill', selector: '#email' },
      ]);
      const output = result.formatted();
      expect(output).toContain('Step 0');
      expect(output).toContain('Step 1');
    });
  });
});
