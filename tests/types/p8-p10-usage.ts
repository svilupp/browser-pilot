/** Compile-only consumer coverage for BP-07…10 public APIs. */

import type { Browser, Page } from '../../src/index.ts';
import {
  ActionDispatchUncertainError,
  type ActionReceipt,
  type Condition,
  type DispatchState,
  type ExpectNewPageOptions,
  getBuildProvenance,
  type RecordingManifest,
  TargetNotFoundError,
  type TargetProvenance,
  type TextMatchMode,
  type UrlMatchMode,
  validateRecordingManifest,
} from '../../src/index.ts';

const _urlMode: UrlMatchMode = 'origin_path';
const _textMode: TextMatchMode = 'exact';
const _condition: Condition = {
  kind: 'textAppears',
  selector: 'main',
  landmark: 'main',
  text: 'Paid',
  mode: _textMode,
};
const _transition: Condition = { kind: 'urlChanged' };
const _receipt: ActionReceipt = {
  dispatchState: 'uncertain',
  retrySafe: false,
  inputEventsSent: ['mousePressed'],
};
const _dispatchState: DispatchState = _receipt.dispatchState;
const _provenance: TargetProvenance = { targetId: 'target', source: 'popup' };
const _options: ExpectNewPageOptions = {
  openerTargetId: 'launcher',
  url: /popup\.example/,
  timeout: 15000,
};
declare const browser: Browser;
declare const page: Page;
const _popup: Promise<Page> = browser.expectNewPage(() => page.click('#open'), _options);
void _popup;
void _urlMode;
void _condition;
void _transition;
void _dispatchState;
void _provenance;
void TargetNotFoundError;
void ActionDispatchUncertainError;
void getBuildProvenance;
declare const manifest: RecordingManifest;
const _integrity = validateRecordingManifest(manifest);
void _integrity;
