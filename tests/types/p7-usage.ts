/**
 * Consumer type test: Phase 7 resolution / diagnostics / fuzzy-matching /
 * structural-signature public API.
 *
 * This file is compile-only — it verifies that downstream TS consumers can
 * import and use the Phase 7 surface from the package root without type errors.
 */
import {
  type CandidateStrategy,
  captureStructureSignature,
  DEFAULT_FUZZY_THRESHOLD,
  DEFAULT_MASK_ROLES,
  type DiagnoseExactResult,
  type DiagnoseFuzzyResult,
  type DiagnoseOptions,
  type DiagnoseResult,
  diagnoseElement,
  type FuzzyMatchOptions,
  type InteractiveElement,
  type Page,
  type PageSnapshot,
  type RankCandidatesOptions,
  type RankedCandidate,
  type RichSelectorCandidate,
  rankCandidates,
  rankSelectorCandidates,
  type StructureSignatureOptions,
  scoreElement,
} from '../../src/index.ts';

// Values are importable from the root package.
void rankCandidates;
void rankSelectorCandidates;
void diagnoseElement;
void scoreElement;
void captureStructureSignature;

// Constants carry their literal-ish shapes.
const _threshold: number = DEFAULT_FUZZY_THRESHOLD;
void _threshold;
const _maskRoles: readonly string[] = DEFAULT_MASK_ROLES;
void _maskRoles;

// Options types are assignable.
const _rankOpts: RankCandidatesOptions = {
  strategies: ['testid', 'role_name'],
  minConfidence: 0.5,
  returnAll: true,
  maxResults: 10,
  actionType: 'click',
};
void _rankOpts;

const _strategy: CandidateStrategy = 'css';
void _strategy;

const _fuzzyOpts: FuzzyMatchOptions = { minScore: 0.4 };
void _fuzzyOpts;

const _sigOpts: StructureSignatureOptions = {
  maskRoles: ['status'],
  includeState: true,
  depth: 4,
};
void _sigOpts;

const _diagOpts: DiagnoseOptions = { maxCandidates: 5, includeHidden: true };
void _diagOpts;

// scoreElement takes a query and an interactive element and returns a number.
declare const el: InteractiveElement;
const _score: number = scoreElement('create order', el);
void _score;

// rankCandidates returns RankedCandidate[].
declare const snap: PageSnapshot;
const ranked: RankedCandidate[] = rankCandidates(snap, 'create order', _rankOpts);
const _first: RankedCandidate | undefined = ranked[0];
void _first?.strategy;
void _first?.score;

// rankSelectorCandidates re-exports RichSelectorCandidate as its element input.
declare const rich: RichSelectorCandidate[];
void rankSelectorCandidates;
void rich;

// Page methods resolveAll / diagnose exist on the exported Page class.
declare const page: Page;
const _resolved: Promise<RankedCandidate[]> = page.resolveAll('create order', { limit: 5 });
void _resolved;
const _diag: Promise<DiagnoseResult> = page.diagnose('#submit', _diagOpts);
void _diag;

// DiagnoseResult narrows to exact / fuzzy subtypes.
declare const result: DiagnoseResult;
if (result.matched) {
  const _exact: DiagnoseExactResult = result;
  void _exact.attributes;
} else {
  const _fuzzy: DiagnoseFuzzyResult = result;
  void _fuzzy.candidates;
}

// captureStructureSignature accepts a snapshot (sync) or a page (async).
const _sig: string = captureStructureSignature(snap, _sigOpts);
void _sig;
const _sigAsync: Promise<string> = captureStructureSignature(page);
void _sigAsync;
