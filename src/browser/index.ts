/**
 * Browser module exports
 */

export { Browser, type BrowserOptions, connect, type PageOptions } from './browser.ts';
export { type ComboboxConfig, type ComboboxResult, chooseOption } from './combobox.ts';
export {
  computeDelta,
  type DeltaChange,
  type DeltaResult,
  extractPageState,
  type PageState,
} from './delta.ts';
export {
  buildFingerprintMap,
  createFingerprint,
  fingerprintKey,
  fingerprintSimilarity,
  recoverStaleRef,
  type SemanticFingerprint,
} from './fingerprint.ts';
export { detectOverlay, type OverlayInfo } from './overlay-detect.ts';
export { Page } from './page.ts';
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
  createTargetFingerprint,
  type PinRecoveryResult,
  recoverPinnedTarget,
  type TargetFingerprint,
} from './target-pin.ts';
export * from './types.ts';
export { type UploadConfig, type UploadResult, uploadFiles } from './upload.ts';
