/**
 * Selector-quality ranker.
 *
 * A single, pure, browser-free ranker that consolidates the several divergent
 * selector-quality ladders that previously lived in `selector-generator.ts`,
 * `recording/script.ts` (`getSelectorCandidates`) and
 * `recording/aggregator.ts` (`selectBestSelectors`). It is the stable public
 * API that `Page.resolveAll` and Flightplan consume.
 *
 * Two entry points:
 *  - {@link rankSelectorCandidates} — pure ranker over ONE element's possible
 *    selectors (no intent, just selector quality).
 *  - {@link rankCandidates} — pure ranker over a whole snapshot vs an intent
 *    string, combining intent match with per-element selector quality.
 *
 * Strategy → source mapping (1:1 with Flightplan's lock `Strategy` enum):
 *  - `testid`                 ← `data-testid` / `data-test` / `data-qa`
 *  - `role_name`              ← accessibility `role` + accessible-name
 *  - `label`                  ← `aria-label` (or accessible-name fallback)
 *  - `scoped_text`            ← visible text scoping
 *  - `structural_fingerprint` ← semantic/structural fingerprint (fingerprint.ts)
 *  - `css`                    ← stable `id` (`#id`) or stable `class` (`.cls`)
 *
 * Quality ladder (base scores, higher = better / more stable). These are
 * monotonic down the ladder, with the two honest `css` variants slotted by how
 * stable they are (id above a bare class):
 *
 *   testid                 0.95
 *   role_name              0.80
 *   label                  0.70
 *   css (id)               0.60
 *   scoped_text            0.55
 *   structural_fingerprint 0.45
 *   css (class)            0.40
 *
 * IMPORTANT honesty rule: `testid` and `css` are emitted ONLY when the backing
 * real DOM attribute is present on `el.attributes`. We never fabricate a
 * `testid`/`css` selector from the synthetic `[data-backend-node-id=...]`
 * selector string. When attributes are absent we only emit the honest
 * `role_name` / `label` / `scoped_text` / `structural_fingerprint` strategies.
 */

import { fingerprintKey, type SemanticFingerprint } from './fingerprint.ts';
import { scoreElement } from './fuzzy-match.ts';
import type { InteractiveElement, PageSnapshot } from './types.ts';

// Re-exported so the browser barrel can surface the recording-side rich
// candidate shape alongside this module's public API.
export type { RichSelectorCandidate } from '../recording/types.ts';

/**
 * Selector strategy identifiers. 1:1 with Flightplan's lock `Strategy` enum.
 */
export type CandidateStrategy =
  | 'testid'
  | 'role_name'
  | 'label'
  | 'scoped_text'
  | 'structural_fingerprint'
  | 'css';

/**
 * A ranked candidate for one element, expressed as a resolvable selector plus
 * the strategy that produced it and a normalized 0..1 quality/match score.
 */
export interface RankedCandidate {
  /** Snapshot ref of the backing element (e.g. "e1"), when available. */
  ref?: string;
  /** Accessibility role of the element. */
  role: string;
  /** Accessible name of the element. */
  name: string;
  /** The selector string produced by {@link RankedCandidate.strategy}. */
  selector: string;
  /** Strategy that produced {@link RankedCandidate.selector}. */
  strategy: CandidateStrategy;
  /** Combined score in 0..1, higher = better. */
  score: number;
}

/**
 * Options for {@link rankCandidates}.
 */
export interface RankCandidatesOptions {
  /** Restrict output to these strategies (drops all others). */
  strategies?: CandidateStrategy[];
  /** Drop candidates whose combined score is below this threshold. */
  minConfidence?: number;
  /**
   * Return every selector candidate for every element (true) versus only the
   * single best-quality candidate per element (false, the default).
   */
  returnAll?: boolean;
  /** Truncate the sorted result to at most this many candidates. */
  maxResults?: number;
  /**
   * Bias role expectations for the intended action, e.g. `'click'` favours
   * button/link/menuitem while `'fill'` favours textbox/searchbox/combobox.
   */
  actionType?: string;
}

// --- Ladder scores -----------------------------------------------------------

const SCORE = {
  testid: 0.95,
  role_name: 0.8,
  label: 0.7,
  css_id: 0.6,
  scoped_text: 0.55,
  structural_fingerprint: 0.45,
  css_class: 0.4,
} as const;

// Weights blending intent match with selector quality in rankCandidates.
const INTENT_WEIGHT = 0.6;
const QUALITY_WEIGHT = 0.4;

// How much an action-type role match/mismatch nudges the combined score.
const ACTION_MATCH_BONUS = 0.1;
const ACTION_MISMATCH_PENALTY = 0.1;

/** Roles a `click`-like action is expected to target. */
const CLICK_ROLES = new Set([
  'button',
  'link',
  'menuitem',
  'menuitemcheckbox',
  'menuitemradio',
  'tab',
  'checkbox',
  'radio',
  'switch',
  'option',
]);

/** Roles a `fill`/`type`-like action is expected to target. */
const FILL_ROLES = new Set(['textbox', 'searchbox', 'combobox', 'spinbutton']);

/** Roles a `select`-like action is expected to target. */
const SELECT_ROLES = new Set(['combobox', 'listbox']);

// --- Small helpers ------------------------------------------------------------

function clamp01(n: number): number {
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

/** Read a non-empty real DOM attribute off the element, if present. */
function attr(el: InteractiveElement, key: string): string | undefined {
  const value = el.attributes?.[key];
  return value && value.length > 0 ? value : undefined;
}

/** Escape double quotes for use inside a `[attr="..."]` selector value. */
function escapeAttrValue(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

/**
 * Whether an `id` looks stable enough to build a `#id` selector from.
 * Mirrors the heuristics in `recording/script.ts` (`getIdSelector`): reject
 * ids that start with a digit or a colon, or that are excessively long, plus
 * ids that look like a random/hashed token.
 */
function isStableId(id: string): boolean {
  if (!id || id.length > 100) return false;
  if (/^[0-9]/.test(id) || /^:/.test(id) || id.includes(':')) return false;
  // Reject long hex-ish / random tokens (e.g. "a1b2c3d4e5f6").
  if (/^[0-9a-f]{8,}$/i.test(id)) return false;
  return true;
}

/**
 * Pick the first stable class from a space-separated `class` string.
 * Mirrors the heuristics in `recording/script.ts` (`buildCssPath`): skip
 * emotion/styled hashes (`css-*`), leading `_`, leading digit, and
 * over-long classes.
 */
function pickStableClass(classAttr: string): string | undefined {
  const classes = classAttr.split(/\s+/).filter((c) => c.length > 0);
  for (const cls of classes) {
    if (cls.length >= 40) continue;
    if (/^css-/.test(cls) || /^_/.test(cls) || /^[0-9]/.test(cls)) continue;
    // Reject long hex-ish / random-looking tokens.
    if (/^[0-9a-f]{8,}$/i.test(cls)) continue;
    return cls;
  }
  return undefined;
}

/** Build a semantic fingerprint descriptor string for a single element. */
function structuralFingerprintSelector(el: InteractiveElement): string {
  const stableAttrs: Record<string, string> = {};
  for (const key of ['id', 'name', 'type'] as const) {
    const value = attr(el, key);
    if (value) stableAttrs[key] = value;
  }

  const fp: SemanticFingerprint = {
    role: el.role.toLowerCase(),
    name: el.name,
    valueShape: el.value !== undefined ? 'text' : '',
    label: el.name,
    stableAttrs,
    nearestHeading: '',
    siblingIndex: 0,
    sectionPath: [],
  };

  return `fingerprint:${fingerprintKey(fp)}`;
}

/** Which roles this action type is expected to target, if any. */
function expectedRolesFor(actionType: string | undefined): Set<string> | null {
  if (!actionType) return null;
  switch (actionType.toLowerCase()) {
    case 'click':
    case 'dblclick':
    case 'check':
    case 'uncheck':
      return CLICK_ROLES;
    case 'fill':
    case 'type':
      return FILL_ROLES;
    case 'select':
      return SELECT_ROLES;
    default:
      return null;
  }
}

/** Additive score delta from an action-type role expectation. */
function actionTypeDelta(actionType: string | undefined, role: string): number {
  const expected = expectedRolesFor(actionType);
  if (!expected) return 0;
  return expected.has(role.toLowerCase()) ? ACTION_MATCH_BONUS : -ACTION_MISMATCH_PENALTY;
}

// --- Public: per-element ranker ----------------------------------------------

/**
 * Rank the possible selectors for a single {@link InteractiveElement} by
 * quality, best first. Pure and browser-free.
 *
 * `testid` and `css` are emitted only when the backing real DOM attribute is
 * present on `el.attributes`; otherwise only the honest accessibility-derived
 * strategies are returned. See the module doc-comment for the score ladder.
 */
export function rankSelectorCandidates(
  el: InteractiveElement
): { strategy: CandidateStrategy; selector: string; score: number }[] {
  const out: { strategy: CandidateStrategy; selector: string; score: number }[] = [];

  // 1. testid — only from a genuine data-testid/data-test/data-qa attribute.
  for (const key of ['data-testid', 'data-test', 'data-qa'] as const) {
    const value = attr(el, key);
    if (value) {
      out.push({
        strategy: 'testid',
        selector: `[${key}="${escapeAttrValue(value)}"]`,
        score: SCORE.testid,
      });
      break; // one testid selector is enough
    }
  }

  // 2. role_name — role + accessible name (always available when role present).
  if (el.role) {
    const selector = el.name ? `role:${el.role}:"${escapeAttrValue(el.name)}"` : `role:${el.role}`;
    out.push({ strategy: 'role_name', selector, score: SCORE.role_name });
  }

  // 3. label — real aria-label attribute, or derived from accessible name.
  const labelValue = attr(el, 'aria-label') ?? (el.name || undefined);
  if (labelValue) {
    out.push({
      strategy: 'label',
      selector: `[aria-label="${escapeAttrValue(labelValue)}"]`,
      score: SCORE.label,
    });
  }

  // 4. css (id) — only from a genuine, stable id attribute.
  const id = attr(el, 'id');
  if (id && isStableId(id)) {
    out.push({ strategy: 'css', selector: `#${id}`, score: SCORE.css_id });
  }

  // 5. scoped_text — visible text scoping (needs an accessible name).
  if (el.name) {
    out.push({
      strategy: 'scoped_text',
      selector: `text:"${escapeAttrValue(el.name)}"`,
      score: SCORE.scoped_text,
    });
  }

  // 6. structural_fingerprint — semantic/structural descriptor.
  if (el.role) {
    out.push({
      strategy: 'structural_fingerprint',
      selector: structuralFingerprintSelector(el),
      score: SCORE.structural_fingerprint,
    });
  }

  // 7. css (class) — only from a genuine, stable class attribute.
  const classAttr = attr(el, 'class');
  if (classAttr) {
    const cls = pickStableClass(classAttr);
    if (cls) {
      out.push({ strategy: 'css', selector: `.${cls}`, score: SCORE.css_class });
    }
  }

  return out.sort((a, b) => b.score - a.score);
}

// --- Public: snapshot ranker --------------------------------------------------

/**
 * Rank every interactive element in a snapshot against an `intent` string,
 * combining fuzzy intent match (role + name + selector) with per-element
 * selector quality. Pure scoring over the snapshot — executes nothing.
 *
 * Returned candidates are sorted by combined score descending. See
 * {@link RankCandidatesOptions} for filtering/shaping behaviour.
 */
export function rankCandidates(
  snapshot: PageSnapshot,
  intent: string,
  opts: RankCandidatesOptions = {}
): RankedCandidate[] {
  const { strategies, minConfidence, returnAll = false, maxResults, actionType } = opts;
  const strategyFilter = strategies && strategies.length > 0 ? new Set(strategies) : null;

  const results: RankedCandidate[] = [];

  for (const el of snapshot.interactiveElements) {
    const intentScore = scoreElement(intent, el); // 0..1
    const delta = actionTypeDelta(actionType, el.role);

    let selectorCandidates = rankSelectorCandidates(el);
    if (strategyFilter) {
      selectorCandidates = selectorCandidates.filter((c) => strategyFilter.has(c.strategy));
    }
    if (selectorCandidates.length === 0) continue;

    // best-per-element (default) vs all candidates for the element.
    const chosen = returnAll ? selectorCandidates : selectorCandidates.slice(0, 1);

    for (const candidate of chosen) {
      const score = clamp01(intentScore * INTENT_WEIGHT + candidate.score * QUALITY_WEIGHT + delta);
      results.push({
        ref: el.ref,
        role: el.role,
        name: el.name,
        selector: candidate.selector,
        strategy: candidate.strategy,
        score,
      });
    }
  }

  results.sort((a, b) => b.score - a.score);

  let output = results;
  if (minConfidence !== undefined) {
    output = output.filter((r) => r.score >= minConfidence);
  }
  if (maxResults !== undefined) {
    output = output.slice(0, maxResults);
  }
  return output;
}
