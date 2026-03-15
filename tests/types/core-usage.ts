/**
 * Consumer type test: Core library usage
 *
 * This file is compile-only — it verifies that downstream TS consumers
 * can import and use the core API without type errors.
 */
import type {
  ActionOptions,
  Browser,
  PageOptions,
  PageSnapshot,
  SnapshotOptions,
  ViewportOptions,
  WaitForOptions,
} from '../../src/index.ts';

// Verify options types are assignable
const _actionOpts: ActionOptions = { timeout: 5000, optional: true };
void _actionOpts;

const _viewportOpts: ViewportOptions = { width: 1280, height: 720 };
void _viewportOpts;

const _waitOpts: WaitForOptions = { state: 'visible', timeout: 10000 };
void _waitOpts;

const _snapshotOpts: SnapshotOptions = { roles: ['button', 'link'] };
void _snapshotOpts;

// Verify PageSnapshot has expected shape
declare const snapshot: PageSnapshot;
const _text: string = snapshot.text;
void _text;

// Verify Browser and PageOptions are importable
declare const _browser: Browser;
void _browser;

declare const _pageOpts: PageOptions;
void _pageOpts;
