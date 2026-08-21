/**
 * Step validation for batch executor
 *
 * Validates steps before browser connection, catching malformed JSON
 * from AI agents with actionable, specific feedback.
 */

import type { ActionEffect, ActionType } from './types.ts';

// --- Types ---

export interface ValidationError {
  stepIndex: number;
  field: string;
  message: string;
  suggestion?: string;
}

export interface ValidationResult {
  valid: boolean;
  errors: ValidationError[];
  formatted(): string;
}

// --- Fuzzy matching ---

function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0) as number[]);
  for (let i = 0; i <= m; i++) dp[i]![0] = i;
  for (let j = 0; j <= n; j++) dp[0]![j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i]![j] =
        a[i - 1] === b[j - 1]
          ? dp[i - 1]![j - 1]!
          : 1 + Math.min(dp[i - 1]![j]!, dp[i]![j - 1]!, dp[i - 1]![j - 1]!);
    }
  }
  return dp[m]![n]!;
}

// --- Alias maps ---

const ACTION_ALIASES: Record<string, ActionType> = {
  execute: 'evaluate',
  navigate: 'goto',
  input: 'fill',
  tap: 'click',
  go: 'goto',
  run: 'evaluate',
  capture: 'screenshot',
  inspect: 'snapshot',
  enter: 'press',
  keypress: 'press',
  hotkey: 'shortcut',
  keybinding: 'shortcut',
  nav: 'goto',
  open: 'goto',
  visit: 'goto',
  browse: 'goto',
  load: 'goto',
  write: 'fill',
  set: 'fill',
  pick: 'select',
  choose: 'select',
  send: 'press',
  eval: 'evaluate',
  js: 'evaluate',
  script: 'evaluate',
  snap: 'snapshot',
  accessibility: 'snapshot',
  a11y: 'snapshot',
  image: 'screenshot',
  pic: 'screenshot',
  frame: 'switchFrame',
  iframe: 'switchFrame',
  formslist: 'forms',
  newtab: 'newTab',
  opentab: 'newTab',
  createtab: 'newTab',
  closetab: 'closeTab',
  assert_visible: 'assertVisible',
  assert_exists: 'assertExists',
  assert_text: 'assertText',
  assert_url: 'assertUrl',
  assert_value: 'assertValue',
  checkvisible: 'assertVisible',
  checkexists: 'assertExists',
  checktext: 'assertText',
  checkurl: 'assertUrl',
  checkvalue: 'assertValue',
};

const PROPERTY_ALIASES: Record<string, string> = {
  expression: 'value',
  href: 'url',
  target: 'selector',
  element: 'selector',
  code: 'value',
  script: 'value',
  src: 'url',
  link: 'url',
  char: 'key',
  text: 'value',
  query: 'selector',
  el: 'selector',
  elem: 'selector',
  css: 'selector',
  xpath: 'selector',
  input: 'value',
  content: 'value',
  keys: 'key',
  shortcutKey: 'combo',
  hotkey: 'combo',
  keybinding: 'combo',
  button: 'key',
  address: 'url',
  page: 'url',
  path: 'url',
  tabId: 'targetId',
};

// --- Action rules ---

type FieldType =
  | 'string'
  | 'string|string[]'
  | 'number'
  | 'boolean'
  | 'boolean|auto'
  | 'boolean|verifyMode'
  | 'object'
  | 'string|object'
  | 'array';

interface FieldRule {
  type: FieldType;
  enum?: string[];
}

interface ActionRule {
  required: Record<string, FieldRule>;
  optional: Record<string, FieldRule>;
}

const ACTION_RULES: Record<ActionType, ActionRule> = {
  goto: {
    required: { url: { type: 'string' } },
    optional: {
      waitUntil: { type: 'string', enum: ['commit', 'domcontentloaded', 'load', 'networkidle'] },
    },
  },
  click: {
    required: { selector: { type: 'string|string[]' } },
    optional: {
      waitForNavigation: { type: 'boolean|auto' },
      waitUntil: { type: 'string', enum: ['commit', 'domcontentloaded', 'load', 'networkidle'] },
    },
  },
  fill: {
    required: { selector: { type: 'string|string[]' }, value: { type: 'string' } },
    optional: {
      blur: { type: 'boolean' },
      verify: { type: 'boolean|verifyMode' },
    },
  },
  type: {
    required: { selector: { type: 'string|string[]' }, value: { type: 'string' } },
    optional: {
      delay: { type: 'number' },
      blur: { type: 'boolean' },
    },
  },
  select: {
    required: {},
    optional: {
      selector: { type: 'string|string[]' },
      value: { type: 'string|string[]' },
      trigger: { type: 'string|string[]' },
      option: { type: 'string|string[]' },
      match: { type: 'string' },
    },
  },
  check: {
    required: { selector: { type: 'string|string[]' } },
    optional: {},
  },
  uncheck: {
    required: { selector: { type: 'string|string[]' } },
    optional: {},
  },
  submit: {
    required: { selector: { type: 'string|string[]' } },
    optional: {
      method: { type: 'string', enum: ['enter', 'click', 'enter+click'] },
      waitForNavigation: { type: 'boolean|auto' },
      waitUntil: { type: 'string', enum: ['commit', 'domcontentloaded', 'load', 'networkidle'] },
    },
  },
  press: {
    required: { key: { type: 'string' } },
    optional: {
      modifiers: { type: 'string|string[]' },
    },
  },
  shortcut: {
    required: { combo: { type: 'string' } },
    optional: {},
  },
  focus: {
    required: { selector: { type: 'string|string[]' } },
    optional: {},
  },
  hover: {
    required: { selector: { type: 'string|string[]' } },
    optional: {},
  },
  scroll: {
    required: {},
    optional: {
      selector: { type: 'string|string[]' },
      x: { type: 'number' },
      y: { type: 'number' },
      direction: { type: 'string', enum: ['up', 'down', 'left', 'right'] },
      amount: { type: 'number' },
    },
  },
  wait: {
    required: {},
    optional: {
      selector: { type: 'string|string[]' },
      waitFor: {
        type: 'string',
        enum: ['visible', 'hidden', 'attached', 'detached', 'navigation', 'networkIdle', 'ready'],
      },
      waitUntil: { type: 'string', enum: ['commit', 'domcontentloaded', 'load', 'networkidle'] },
    },
  },
  waitForReady: {
    required: {},
    optional: {
      selector: { type: 'string|string[]' },
      any: { type: 'array' },
      all: { type: 'array' },
      loadingHidden: { type: 'string|string[]' },
      predicate: { type: 'string' },
      stableForMs: { type: 'number' },
      domQuietForMs: { type: 'number' },
      pollInterval: { type: 'number' },
    },
  },
  snapshot: {
    required: {},
    optional: {},
  },
  screenshot: {
    required: {},
    optional: {
      format: { type: 'string', enum: ['png', 'jpeg', 'webp'] },
      quality: { type: 'number' },
      fullPage: { type: 'boolean' },
    },
  },
  forms: {
    required: {},
    optional: {},
  },
  evaluate: {
    required: { value: { type: 'string' } },
    optional: {},
  },
  text: {
    required: {},
    optional: {
      selector: { type: 'string|string[]' },
    },
  },
  switchFrame: {
    required: { selector: { type: 'string|string[]' } },
    optional: {},
  },
  newTab: {
    required: {},
    optional: {
      url: { type: 'string' },
      background: { type: 'boolean' },
    },
  },
  closeTab: {
    required: {},
    optional: {
      targetId: { type: 'string' },
    },
  },
  switchToMain: {
    required: {},
    optional: {},
  },
  assertVisible: {
    required: { selector: { type: 'string|string[]' } },
    optional: {},
  },
  assertExists: {
    required: { selector: { type: 'string|string[]' } },
    optional: {},
  },
  assertText: {
    required: {},
    optional: {
      selector: { type: 'string|string[]' },
      expect: { type: 'string' },
      value: { type: 'string' },
      textMode: { type: 'string', enum: ['exact', 'contains', 'regex'] },
      landmark: { type: 'string' },
      scope: { type: 'object' },
    },
  },
  assertUrl: {
    required: {},
    optional: {
      expect: { type: 'string' },
      url: { type: 'string' },
      urlMode: { type: 'string', enum: ['exact', 'origin_path', 'glob', 'contains'] },
    },
  },
  assertValue: {
    required: { selector: { type: 'string|string[]' } },
    optional: {
      expect: { type: 'string' },
      value: { type: 'string' },
      landmark: { type: 'string' },
      scope: { type: 'object' },
    },
  },
  waitForWsMessage: {
    required: { match: { type: 'string' } },
    optional: {
      where: { type: 'object' },
    },
  },
  assertNoConsoleErrors: {
    required: {},
    optional: {
      windowMs: { type: 'number' },
    },
  },
  assertTextChanged: {
    required: { to: { type: 'string' } },
    optional: {
      selector: { type: 'string|string[]' },
      from: { type: 'string' },
      textMode: { type: 'string', enum: ['exact', 'contains', 'regex'] },
      landmark: { type: 'string' },
      scope: { type: 'object' },
    },
  },
  assertPermission: {
    required: {
      name: { type: 'string' },
      state: { type: 'string' },
    },
    optional: {},
  },
  assertMediaTrackLive: {
    required: {
      kind: { type: 'string', enum: ['audio', 'video'] },
    },
    optional: {},
  },
  delta: {
    required: {},
    optional: {},
  },
  review: {
    required: {},
    optional: {},
  },
  chooseOption: {
    required: { value: { type: 'string|string[]' } },
    optional: {
      trigger: { type: 'string|string[]' },
      selector: { type: 'string|string[]' },
      option: { type: 'string|string[]' },
      match: { type: 'string', enum: ['exact', 'contains', 'startsWith'] },
    },
  },
  upload: {
    required: {
      selector: { type: 'string|string[]' },
      files: { type: 'string|string[]' },
    },
    optional: {},
  },
  emit: {
    required: { payload: { type: 'string|object' } },
    optional: {
      channel: { type: 'string', enum: ['ws'] },
      match: { type: 'string' },
      base64: { type: 'boolean' },
      awaitReply: { type: 'object' },
    },
  },
  setCookie: {
    required: { cookie: { type: 'object' } },
    optional: {},
  },
  setHeaders: {
    required: { headers: { type: 'object' } },
    optional: {},
  },
};

const VALID_ACTIONS = Object.keys(ACTION_RULES) as ActionType[];
const VALID_ACTIONS_LIST = VALID_ACTIONS.join(', ');

/** All known step fields (action + common fields + action-specific) */
const KNOWN_STEP_FIELDS = new Set([
  'action',
  'selector',
  'url',
  'background',
  'value',
  'targetId',
  'key',
  'combo',
  'modifiers',
  'waitFor',
  'timeout',
  'optional',
  'method',
  'blur',
  'verify',
  'delay',
  'waitForNavigation',
  'waitUntil',
  'trigger',
  'option',
  'match',
  'where',
  'x',
  'y',
  'direction',
  'amount',
  'format',
  'quality',
  'fullPage',
  'expect',
  'retry',
  'retryDelay',
  'from',
  'to',
  'name',
  'state',
  'kind',
  'windowMs',
  'expectAny',
  'expectAll',
  'failIf',
  'dangerous',
  'effect',
  'anchor',
  'files',
  'any',
  'all',
  'loadingHidden',
  'predicate',
  'stableForMs',
  'domQuietForMs',
  'pollInterval',
  'urlMode',
  'textMode',
  'landmark',
  'scope',
  'checked',
  'enabled',
  'targetCount',
  'transition',
  'channel',
  'payload',
  'base64',
  'awaitReply',
  'cookie',
  'headers',
]);

// --- Action resolution ---

function resolveAction(name: string): { action: ActionType; suggestion?: string } | null {
  // Exact match
  if (VALID_ACTIONS.includes(name as ActionType)) {
    return { action: name as ActionType };
  }

  // Alias match
  const lower = name.toLowerCase();
  if (ACTION_ALIASES[lower]) {
    return {
      action: ACTION_ALIASES[lower],
      suggestion: `Did you mean "${ACTION_ALIASES[lower]}"?`,
    };
  }

  // Levenshtein match (threshold: distance <= 2)
  let best: ActionType | null = null;
  let bestDist = Infinity;
  for (const valid of VALID_ACTIONS) {
    const dist = levenshtein(lower, valid);
    if (dist < bestDist) {
      bestDist = dist;
      best = valid;
    }
  }
  if (best && bestDist <= 2) {
    return { action: best, suggestion: `Did you mean "${best}"?` };
  }

  return null;
}

function suggestProperty(name: string): string | undefined {
  // Alias match
  if (PROPERTY_ALIASES[name]) {
    return PROPERTY_ALIASES[name];
  }

  // Levenshtein match against known fields
  let best: string | null = null;
  let bestDist = Infinity;
  for (const known of KNOWN_STEP_FIELDS) {
    if (known === 'action') continue;
    const dist = levenshtein(name, known);
    if (dist < bestDist) {
      bestDist = dist;
      best = known;
    }
  }
  if (best && bestDist <= 2) {
    return best;
  }
  return undefined;
}

// --- Type checking ---

function checkFieldType(value: unknown, rule: FieldRule): string | null {
  switch (rule.type) {
    case 'string':
      if (typeof value !== 'string') return `expected string, got ${typeof value}`;
      if (rule.enum && !rule.enum.includes(value)) {
        return `must be one of: ${rule.enum.join(', ')}`;
      }
      return null;
    case 'string|string[]':
      if (typeof value !== 'string' && !Array.isArray(value)) {
        return `expected string or string[], got ${typeof value}`;
      }
      if (Array.isArray(value) && value.some((v) => typeof v !== 'string')) {
        return 'array elements must be strings';
      }
      return null;
    case 'number':
      if (typeof value !== 'number') return `expected number, got ${typeof value}`;
      return null;
    case 'boolean':
      if (typeof value !== 'boolean') return `expected boolean, got ${typeof value}`;
      return null;
    case 'boolean|auto':
      if (typeof value !== 'boolean' && value !== 'auto') {
        return `expected boolean or "auto", got ${typeof value}`;
      }
      return null;
    case 'boolean|verifyMode':
      if (typeof value !== 'boolean' && value !== 'exact' && value !== 'normalized') {
        return `expected boolean, "exact", or "normalized", got ${typeof value}`;
      }
      return null;
    case 'object':
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return `expected object, got ${Array.isArray(value) ? 'array' : typeof value}`;
      }
      return null;
    case 'string|object':
      if (typeof value === 'string') return null;
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return `expected string or object, got ${Array.isArray(value) ? 'array' : typeof value}`;
      }
      return null;
    case 'array':
      if (!Array.isArray(value)) return `expected array, got ${typeof value}`;
      return null;
    default: {
      const _exhaustive: never = rule.type;
      return `unknown type: ${_exhaustive}`;
    }
  }
}

// --- Main validation ---

export function validateSteps(steps: unknown[]): ValidationResult {
  const errors: ValidationError[] = [];

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];

    // Check step is an object
    if (!step || typeof step !== 'object' || Array.isArray(step)) {
      errors.push({
        stepIndex: i,
        field: 'step',
        message: 'step must be a JSON object.',
      });
      continue;
    }

    const obj = step as Record<string, unknown>;

    // Check action field exists
    if (!('action' in obj)) {
      errors.push({
        stepIndex: i,
        field: 'action',
        message: 'missing required "action" field.',
      });
      continue;
    }

    const actionName = obj['action'];
    if (typeof actionName !== 'string') {
      errors.push({
        stepIndex: i,
        field: 'action',
        message: `"action" must be a string, got ${typeof actionName}.`,
      });
      continue;
    }

    // Resolve action name
    const resolved = resolveAction(actionName);
    if (!resolved) {
      errors.push({
        stepIndex: i,
        field: 'action',
        message: `unknown action "${actionName}".`,
        suggestion: `Valid actions: ${VALID_ACTIONS_LIST}`,
      });
      continue;
    }

    // If it was an alias/typo, report as error with suggestion
    if (resolved.suggestion) {
      errors.push({
        stepIndex: i,
        field: 'action',
        message: `unknown action "${actionName}". ${resolved.suggestion}`,
        suggestion: resolved.suggestion,
      });
      continue;
    }

    const action = resolved.action;
    const rule = ACTION_RULES[action];

    // Detect unknown properties
    for (const key of Object.keys(obj)) {
      if (key === 'action') continue;
      if (KNOWN_STEP_FIELDS.has(key)) continue;

      const canonical = PROPERTY_ALIASES[key];
      if (canonical) {
        if (!(canonical in obj)) {
          obj[canonical] = obj[key];
        }
        delete obj[key];
        continue;
      }

      const suggestion = suggestProperty(key);
      errors.push({
        stepIndex: i,
        field: key,
        message: suggestion
          ? `unknown property "${key}". Did you mean "${suggestion}"?`
          : `unknown property "${key}".`,
        suggestion: suggestion ? `Did you mean "${suggestion}"?` : undefined,
      });
    }

    // Check required params
    for (const [field, fieldRule] of Object.entries(rule.required)) {
      if (!(field in obj) || obj[field] === undefined) {
        errors.push({
          stepIndex: i,
          field,
          message: `missing required "${field}" (${fieldRule.type}).`,
        });
      } else {
        const typeErr = checkFieldType(obj[field], fieldRule);
        if (typeErr) {
          errors.push({
            stepIndex: i,
            field,
            message: `"${field}" ${typeErr}.`,
          });
        }
      }
    }

    // Type-check optional params that are present
    for (const [field, fieldRule] of Object.entries(rule.optional)) {
      if (field in obj && obj[field] !== undefined) {
        const typeErr = checkFieldType(obj[field], fieldRule);
        if (typeErr) {
          errors.push({
            stepIndex: i,
            field,
            message: `"${field}" ${typeErr}.`,
          });
        }
      }
    }

    // Type-check common optional fields
    if ('timeout' in obj && obj['timeout'] !== undefined) {
      if (typeof obj['timeout'] !== 'number') {
        errors.push({
          stepIndex: i,
          field: 'timeout',
          message: `"timeout" expected number, got ${typeof obj['timeout']}.`,
        });
      }
    }
    if ('optional' in obj && obj['optional'] !== undefined) {
      if (typeof obj['optional'] !== 'boolean') {
        errors.push({
          stepIndex: i,
          field: 'optional',
          message: `"optional" expected boolean, got ${typeof obj['optional']}.`,
        });
      }
    }
    if ('retry' in obj && obj['retry'] !== undefined) {
      if (typeof obj['retry'] !== 'number') {
        errors.push({
          stepIndex: i,
          field: 'retry',
          message: `"retry" expected number, got ${typeof obj['retry']}.`,
        });
      } else if (obj['action'] === 'emit' && obj['retry'] > 0) {
        // An emitted frame is an at_most_once side effect on someone's server.
        // Rejecting the field is safer than silently ignoring it.
        errors.push({
          stepIndex: i,
          field: 'retry',
          message:
            '"retry" is not allowed on emit: a re-sent frame duplicates a server-side action. Handle failure explicitly instead.',
        });
      }
    }
    if ('retryDelay' in obj && obj['retryDelay'] !== undefined) {
      if (typeof obj['retryDelay'] !== 'number') {
        errors.push({
          stepIndex: i,
          field: 'retryDelay',
          message: `"retryDelay" expected number, got ${typeof obj['retryDelay']}.`,
        });
      }
    }
    if ('dangerous' in obj && obj['dangerous'] !== undefined) {
      if (typeof obj['dangerous'] !== 'boolean') {
        errors.push({
          stepIndex: i,
          field: 'dangerous',
          message: `"dangerous" expected boolean, got ${typeof obj['dangerous']}.`,
        });
      }
    }
    if ('effect' in obj && obj['effect'] !== undefined) {
      const validEffects: ActionEffect[] = ['observe', 'idempotent', 'at_most_once'];
      if (
        typeof obj['effect'] !== 'string' ||
        !validEffects.includes(obj['effect'] as ActionEffect)
      ) {
        errors.push({
          stepIndex: i,
          field: 'effect',
          message: `"effect" must be one of: ${validEffects.join(', ')}.`,
        });
      }
    }
    if (
      'anchor' in obj &&
      obj['anchor'] !== undefined &&
      (typeof obj['anchor'] !== 'string' || obj['anchor'].trim() === '')
    ) {
      errors.push({
        stepIndex: i,
        field: 'anchor',
        message: '"anchor" must be a non-empty string when provided.',
      });
    }
    for (const [field, allowed] of [
      ['urlMode', ['exact', 'origin_path', 'glob', 'contains']],
      ['textMode', ['exact', 'contains', 'regex']],
    ] as const) {
      if (
        field in obj &&
        obj[field] !== undefined &&
        !(allowed as readonly string[]).includes(String(obj[field]))
      ) {
        errors.push({
          stepIndex: i,
          field,
          message: `"${field}" must be one of: ${(allowed as readonly string[]).join(', ')}.`,
        });
      }
    }
    for (const condField of ['expectAny', 'expectAll', 'failIf'] as const) {
      if (condField in obj && obj[condField] !== undefined) {
        if (!Array.isArray(obj[condField])) {
          errors.push({
            stepIndex: i,
            field: condField,
            message: `"${condField}" expected array, got ${typeof obj[condField]}.`,
          });
        } else {
          const conditions = obj[condField] as unknown[];
          for (let ci = 0; ci < conditions.length; ci++) {
            const cond = conditions[ci];
            if (!cond || typeof cond !== 'object' || Array.isArray(cond)) {
              errors.push({
                stepIndex: i,
                field: condField,
                message: `"${condField}[${ci}]" must be a condition object.`,
              });
              continue;
            }
            const condObj = cond as Record<string, unknown>;
            if (!('kind' in condObj) || typeof condObj['kind'] !== 'string') {
              errors.push({
                stepIndex: i,
                field: condField,
                message: `"${condField}[${ci}]" missing required "kind" field.`,
              });
            } else {
              const validKinds = [
                'urlMatches',
                'elementVisible',
                'elementHidden',
                'textAppears',
                'textChanges',
                'networkResponse',
                'stateSignatureChanges',
                'selectedTab',
                'fieldValue',
                'checkbox',
                'switch',
                'elementEnabled',
                'targetCount',
                'newTarget',
                'urlChanged',
                'fieldChanged',
              ];
              if (!validKinds.includes(condObj['kind'])) {
                errors.push({
                  stepIndex: i,
                  field: condField,
                  message: `"${condField}[${ci}].kind" must be one of: ${validKinds.join(', ')}. Got "${condObj['kind']}".`,
                });
              }
            }
          }
        }
      }
    }

    // Custom validation for assertText: needs expect or value
    if (action === 'assertText') {
      if (!('expect' in obj) && !('value' in obj)) {
        errors.push({
          stepIndex: i,
          field: 'expect',
          message: 'assertText requires "expect" or "value" containing the expected text.',
        });
      }
    }

    // Custom validation for assertUrl: needs expect or url
    if (action === 'assertUrl') {
      if (!('expect' in obj) && !('url' in obj)) {
        errors.push({
          stepIndex: i,
          field: 'expect',
          message: 'assertUrl requires "expect" or "url" containing the expected URL substring.',
        });
      }
    }

    // Custom validation for assertValue: needs expect or value
    if (action === 'assertValue') {
      if (!('expect' in obj) && !('value' in obj)) {
        errors.push({
          stepIndex: i,
          field: 'expect',
          message: 'assertValue requires "expect" or "value" containing the expected value.',
        });
      }
    }

    // Custom validation for select: needs either selector+value or trigger+option+value
    if (action === 'select') {
      const hasNative = 'selector' in obj && 'value' in obj;
      const hasCustom = 'trigger' in obj && 'option' in obj && 'value' in obj;
      if (!hasNative && !hasCustom) {
        errors.push({
          stepIndex: i,
          field: 'selector',
          message:
            'select requires either (selector + value) for native select, or (trigger + option + value) for custom select.',
        });
      }
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    formatted() {
      if (errors.length === 0) return '';
      const lines = [`Validation failed (${errors.length} error${errors.length > 1 ? 's' : ''}):`];
      for (const err of errors) {
        const stepLabel =
          err.field === 'action' || err.field === 'step'
            ? `Step ${err.stepIndex}`
            : `Step ${err.stepIndex}`;
        lines.push('');
        lines.push(`  ${stepLabel}: ${err.message}`);
        if (err.suggestion && !err.message.includes(err.suggestion)) {
          lines.push(`    ${err.suggestion}`);
        }
        // Show the step JSON for context
        const step = steps[err.stepIndex];
        if (step && typeof step === 'object') {
          lines.push(`    Got: ${JSON.stringify(step)}`);
        }
      }
      // Suggest bp eval when evaluate action has errors
      const hasEvaluateError = errors.some((err) => {
        const step = steps[err.stepIndex];
        return (
          step &&
          typeof step === 'object' &&
          (step as Record<string, unknown>)['action'] === 'evaluate'
        );
      });
      if (hasEvaluateError) {
        lines.push('');
        lines.push(
          "Tip: For JavaScript evaluation, use 'bp eval' instead — no JSON wrapping needed:"
        );
        lines.push("  bp eval 'your.expression.here'");
      }

      lines.push('');
      lines.push(`Valid actions: ${VALID_ACTIONS_LIST}`);
      return lines.join('\n');
    },
  };
}
