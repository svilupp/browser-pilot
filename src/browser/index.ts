/**
 * Browser module exports
 */

export {
  Browser,
  type BrowserOptions,
  connect,
  type NewPageOptions,
  type PageOptions,
} from './browser.ts';
export { type ComboboxConfig, type ComboboxResult, chooseOption } from './combobox.ts';
export {
  computeDelta,
  type DeltaChange,
  type DeltaResult,
  extractPageState,
  type PageState,
} from './delta.ts';
export {
  type DiagnoseExactResult,
  type DiagnoseFuzzyResult,
  type DiagnoseOptions,
  type DiagnoseResult,
  diagnoseElement,
} from './diagnose.ts';
export {
  buildFingerprintMap,
  createFingerprint,
  fingerprintKey,
  fingerprintSimilarity,
  recoverStaleRef,
  type SemanticFingerprint,
} from './fingerprint.ts';
export {
  DEFAULT_FUZZY_THRESHOLD,
  type FuzzyMatch,
  type FuzzyMatchOptions,
  fuzzyMatchElements,
  jaroWinkler,
  scoreElement,
  stringSimilarity,
} from './fuzzy-match.ts';
export { detectOverlay, type OverlayInfo } from './overlay-detect.ts';
export { Page, type PageInitOptions } from './page.ts';
export {
  extractReview,
  type KeyValuePair,
  type ReviewResult,
  type SummaryCard,
  type TableData,
} from './review.ts';
export {
  type SubmitAndVerifyOptions,
  type SubmitAndVerifyResult,
  submitAndVerify,
} from './safe-submit.ts';
export {
  type GeneratedSelector,
  generateSelectorStrings,
  generateSelectors,
} from './selector-generator.ts';
export {
  type CandidateStrategy,
  DEFAULT_TESTID_ATTRIBUTES,
  isDestructiveName,
  type RankCandidatesOptions,
  type RankedCandidate,
  type RichSelectorCandidate,
  rankCandidates,
  rankSelectorCandidates,
} from './selector-rank.ts';
export {
  captureStructureSignature,
  DEFAULT_MASK_ROLES,
  type StructureSignatureOptions,
} from './signature.ts';
export {
  classifyStaleError,
  type StaleErrorClassification,
  type StaleErrorKind,
  type StaleRecoveryDiagnostics,
} from './stale-errors.ts';
export {
  createTargetFingerprint,
  type PinRecoveryResult,
  recoverPinnedTarget,
  type TargetFingerprint,
} from './target-pin.ts';
export * from './types.ts';
export { type UploadConfig, type UploadResult, uploadFiles } from './upload.ts';
