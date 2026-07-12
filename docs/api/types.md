# Types Reference

Complete TypeScript type definitions for browser-pilot.

## Connection Types

```typescript
interface ConnectOptions {
  provider: 'browserbase' | 'browserless' | 'browser-use' | 'generic';
  apiKey?: string;
  projectId?: string;
  wsUrl?: string;
  session?: CreateSessionOptions;
  debug?: boolean;
  timeout?: number;
  proxyCountryCode?: string | null;
  profileId?: string;
  cloudTimeout?: number;
}

interface CreateSessionOptions {
  width?: number;
  height?: number;
  recording?: boolean;
  proxy?: ProxyConfig;
  [key: string]: unknown;
}

interface ProxyConfig {
  server: string;
  username?: string;
  password?: string;
}
```

## Provider Types

```typescript
interface Provider {
  readonly name: string;
  createSession(options?: CreateSessionOptions): Promise<ProviderSession>;
  resumeSession?(sessionId: string): Promise<ProviderSession>;
}

interface ProviderSession {
  wsUrl: string;
  sessionId?: string;
  metadata?: Record<string, unknown>;
  close(): Promise<void>;
}
```

## Action Options

```typescript
interface ActionOptions {
  timeout?: number;
  optional?: boolean;
  waitUntil?: 'commit' | 'domcontentloaded' | 'load' | 'networkidle';
}

interface FillOptions extends ActionOptions {
  blur?: boolean;
  verify?: boolean;
}

interface TypeOptions extends ActionOptions {
  delay?: number;
}

interface SubmitOptions extends ActionOptions {
  method?: 'enter' | 'click' | 'enter+click';
  waitForNavigation?: boolean | 'auto';
}

interface WaitForOptions extends ActionOptions {
  state?: 'visible' | 'hidden' | 'attached' | 'detached';
}

interface NetworkIdleOptions extends ActionOptions {
  idleTime?: number;
}

interface CustomSelectConfig {
  trigger: string | string[];
  option: string | string[];
  value: string;
  match?: 'text' | 'value' | 'contains';
}
```

## Batch Types

```typescript
type ActionType =
  | 'goto'
  | 'click'
  | 'fill'
  | 'type'
  | 'select'
  | 'check'
  | 'uncheck'
  | 'submit'
  | 'press'
  | 'shortcut'
  | 'focus'
  | 'hover'
  | 'scroll'
  | 'wait'
  | 'waitForReady'
  | 'snapshot'
  | 'forms'
  | 'screenshot'
  | 'evaluate'
  | 'text'
  | 'newTab'
  | 'closeTab'
  | 'switchFrame'
  | 'switchToMain'
  | 'assertVisible'
  | 'assertExists'
  | 'assertText'
  | 'assertUrl'
  | 'assertValue'
  | 'waitForWsMessage'
  | 'assertNoConsoleErrors'
  | 'assertTextChanged'
  | 'assertPermission'
  | 'assertMediaTrackLive'
  | 'chooseOption'
  | 'upload'
  | 'review'
  | 'delta';

interface Step {
  action: ActionType;
  selector?: string | string[];
  url?: string;
  value?: string | string[];
  targetId?: string;
  key?: string;
  combo?: string;
  modifiers?: Array<'Control' | 'Shift' | 'Alt' | 'Meta'>;
  waitFor?: 'visible' | 'hidden' | 'attached' | 'detached' | 'navigation' | 'networkIdle' | 'ready';
  waitUntil?: 'commit' | 'domcontentloaded' | 'load' | 'networkidle';
  timeout?: number;
  optional?: boolean;
  method?: 'enter' | 'click' | 'enter+click';
  blur?: boolean;
  delay?: number;
  waitForNavigation?: boolean | 'auto';
  trigger?: string | string[];
  option?: string | string[];
  match?: 'text' | 'value' | 'contains';
  x?: number;
  y?: number;
  direction?: 'up' | 'down' | 'left' | 'right';
  amount?: number;
  format?: 'png' | 'jpeg' | 'webp';
  quality?: number;
  fullPage?: boolean;
  expect?: string;
  urlMode?: 'exact' | 'origin_path' | 'glob' | 'contains';
  textMode?: 'exact' | 'contains' | 'regex';
  landmark?: string;
  scope?: { selector?: string | string[]; landmark?: string };
  checked?: boolean;
  enabled?: boolean;
  targetCount?: number;
  transition?: 'urlChanged' | 'fieldChanged';
  retry?: number;
  retryDelay?: number;
  files?: string[];
  expectAny?: Condition[];
  expectAll?: Condition[];
  failIf?: Condition[];
  dangerous?: boolean;
  any?: ReadyCondition[];
  all?: ReadyCondition[];
  loadingHidden?: string | string[];
  predicate?: string;
  stableForMs?: number;
  domQuietForMs?: number;
  pollInterval?: number;
  effect?: 'observe' | 'idempotent' | 'at_most_once';
  anchor?: string;
}

interface RecordOptions {
  outputDir?: string;
  sessionId?: string;
  format?: 'png' | 'jpeg' | 'webp';
  quality?: number;
  highlights?: boolean;
  skipActions?: ActionType[];
}

/** Session-level recording settings, stored in session metadata via `bp connect --record`.
 *  When enabled, all `bp exec` calls in the session capture screenshots automatically.
 *  Frames accumulate across exec calls in one recording.json manifest. */
interface RecordSettings {
  enabled: boolean;
  format?: 'png' | 'jpeg' | 'webp';
  quality?: number;
  highlights?: boolean;
}

interface BatchOptions {
  timeout?: number;
  onFail?: 'stop' | 'continue';
  record?: RecordOptions;
}

interface StepResult {
  index: number;
  action: ActionType;
  selector?: string | string[];
  selectorUsed?: string;
  success: boolean;
  durationMs: number;
  error?: string;
  failedSelectors?: Array<{ selector: string; reason: string }>;
  result?: unknown;
  text?: string;
  hints?: Array<{
    selector: string;
    reason: string;
    confidence: 'high' | 'medium' | 'low';
    element: { ref: string; role: string; name: string; disabled?: boolean };
  }>;
  failureReason?:
    | 'missing'
    | 'hidden'
    | 'covered'
    | 'disabled'
    | 'readonly'
    | 'detached'
    | 'replaced'
    | 'notEditable'
    | 'timeout'
    | 'navigation'
    | 'cdpError'
    | 'unknown';
  coveringElement?: { tag: string; id?: string; className?: string };
  suggestion?: string;
  timestamp?: number;
  coordinates?: { x: number; y: number };
  boundingBox?: { x: number; y: number; width: number; height: number };
  screenshotPath?: string;
  outcomeStatus?: OutcomeStatus;
  matchedConditions?: MatchedCondition[];
  retrySafe?: boolean;
  effect?: 'observe' | 'idempotent' | 'at_most_once';
  actionId?: string;
  executionId?: string;
  attempt?: number;
  targetId?: string;
  targetProvenance?: Record<string, unknown>;
  receipt?: ActionReceipt;
  dispatchState?: 'not_dispatched' | 'dispatched' | 'uncertain';
  attempts?: number;
  retryDecisionReason?: RetryDecisionReason;
}

interface BatchResult {
  success: boolean;
  stoppedAtIndex?: number;
  steps: StepResult[];
  totalDurationMs: number;
  recordingManifest?: string;
}
```

## Outcome Types

```typescript
type OutcomeStatus = 'success' | 'failed' | 'ambiguous' | 'unsafe_to_retry';
type ActionEffect = 'observe' | 'idempotent' | 'at_most_once';
type RetryDecisionReason =
  | 'not_needed_success'
  | 'max_attempts_reached'
  | 'retry_allowed_pre_dispatch'
  | 'dispatch_already_attempted'
  | 'dangerous_dispatched'
  | 'retry_unsafe'
  | 'missing_retry_metadata'
  | 'dangerous_pre_dispatch_not_explicit';

type Condition =
  | { kind: 'urlMatches'; pattern: string; mode?: 'exact' | 'origin_path' | 'glob' | 'contains'; match?: 'exact' | 'origin_path' | 'glob' | 'contains' }
  | { kind: 'elementVisible'; selector: string | string[] }
  | { kind: 'elementHidden'; selector: string | string[] }
  | { kind: 'textAppears'; selector?: string | string[]; text: string; mode?: 'exact' | 'contains' | 'regex'; match?: 'exact' | 'contains' | 'regex'; scope?: AssertionScope; landmark?: string }
  | { kind: 'textChanges'; selector?: string | string[]; from?: string; to?: string; mode?: 'exact' | 'contains' | 'regex'; match?: 'exact' | 'contains' | 'regex'; scope?: AssertionScope; landmark?: string }
  | { kind: 'networkResponse'; urlPattern: string; status?: number }
  | { kind: 'stateSignatureChanges'; mode?: 'text' | 'structure' }
  | { kind: 'selectedTab'; selector?: string | string[]; name?: string; landmark?: string }
  | { kind: 'fieldValue'; selector: string | string[]; value: string; landmark?: string }
  | { kind: 'checkbox'; selector: string | string[]; checked: boolean; landmark?: string }
  | { kind: 'switch'; selector: string | string[]; checked: boolean; landmark?: string }
  | { kind: 'elementEnabled'; selector: string | string[]; enabled?: boolean; landmark?: string }
  | { kind: 'targetCount'; count: number; type?: string }
  | { kind: 'newTarget'; targetId?: string; openerTargetId?: string; url?: string; type?: string }
  | { kind: 'urlChanged'; from?: string; mode?: 'exact' | 'origin_path' | 'glob' | 'contains' }
  | { kind: 'fieldChanged'; selector: string | string[]; from?: string; to?: string; landmark?: string };

interface AssertionScope {
  selector?: string | string[];
  landmark?: string;
}

type ReadyCondition =
  | string
  | { selector?: string | string[]; url?: string; predicate?: string | (() => unknown) };

interface ActionReceipt {
  dispatchState: 'not_dispatched' | 'dispatched' | 'uncertain';
  retrySafe: boolean;
  inputEventsSent: string[];
  navigationObserved?: boolean;
  staleRecovery?: Record<string, unknown>;
  executionId?: string;
  actionId?: string;
  attempt?: number;
  targetId?: string;
}

interface ReadinessDiagnostics {
  ready: boolean;
  waitedMs: number;
  lastMilestone?: 'commit' | 'domcontentloaded' | 'load' | 'networkidle';
  unmetConditions: string[];
  checkedAt: string;
}

interface MatchedCondition {
  condition: Condition;
  matched: boolean;
  detail?: string;
}
```

## Review Types

```typescript
interface ReviewResult {
  url: string;
  title: string;
  headings: string[];
  forms: Array<{ label?: string; value: unknown; type: string; disabled: boolean }>;
  alerts: string[];
  summaryCards: SummaryCard[];
  tables: TableData[];
  keyValues: KeyValuePair[];
  statusLabels: string[];
}

interface DeltaResult {
  changes: DeltaChange[];
  before: PageState;
  after: PageState;
  hasChanges: boolean;
}

interface WorkflowSummary {
  success: boolean;
  totalSteps: number;
  succeededSteps: number;
  failedSteps: number;
  totalDurationMs: number;
  steps: WorkflowStepSummary[];
  verdict: string;
  workflowRetrySafe: boolean;
}
```

## Snapshot Types

```typescript
interface PageSnapshot {
  url: string;
  title: string;
  timestamp: string;
  accessibilityTree: SnapshotNode[];
  interactiveElements: InteractiveElement[];
  text: string;
}

interface SnapshotNode {
  role: string;
  name?: string;
  value?: string;
  ref: string;
  children?: SnapshotNode[];
  disabled?: boolean;
  checked?: boolean;
}

interface InteractiveElement {
  ref: string;
  role: string;
  name: string;
  selector: string;
  disabled?: boolean;
  checked?: boolean;
  value?: string;
  attributes?: Record<string, string>;
}
```

## File Types

```typescript
interface FileInput {
  name: string;
  mimeType: string;
  buffer: ArrayBuffer | string;
}

interface Download {
  filename: string;
  content(): Promise<ArrayBuffer>;
}
```

## Wait Types

```typescript
type WaitState = 'visible' | 'hidden' | 'attached' | 'detached';

interface WaitOptions {
  state?: WaitState;
  timeout?: number;
  pollInterval?: number;
}

type NavigationMilestone = 'commit' | 'domcontentloaded' | 'load' | 'networkidle';

interface WaitForReadyOptions extends ActionOptions {
  any?: ReadyCondition[];
  all?: ReadyCondition[];
  loadingHidden?: string | string[];
  url?: string;
  predicate?: string | (() => unknown);
  stableForMs?: number;
  domQuietForMs?: number;
  pollInterval?: number;
}

interface WaitResult {
  success: boolean;
  selector?: string;
  waitedMs: number;
  milestone?: NavigationMilestone;
  diagnostics?: ReadinessDiagnostics;
}
```

## CDP Types

```typescript
interface CDPClient {
  send<T>(method: string, params?: Record<string, unknown>, sessionId?: string | null, options?: { timeout?: number }): Promise<T>;
  on(event: string, handler: (params: Record<string, unknown>) => void): void;
  off(event: string, handler: (params: Record<string, unknown>) => void): void;
  onSessionEvent(sessionId: string, event: string, handler: (params: Record<string, unknown>) => void): () => void;
  onAny(handler: (method: string, params: Record<string, unknown>, sessionId?: string) => void): void;
  offAny(handler: (method: string, params: Record<string, unknown>, sessionId?: string) => void): void;
  onTargetAttached(handler: (info: TargetAttachedInfo) => void): () => void;
  close(): Promise<void>;
  attachToTarget(targetId: string): Promise<string>;
  runIfWaitingForDebugger(sessionId: string): Promise<void>;
  readonly sessions: ReadonlySet<string>;
  hasSession(sessionId: string): boolean;
  readonly sessionId: string | undefined;
  setSessionId(sessionId: string | undefined): void;
  setAutoAttach(options?: { sessionId?: string | null }): Promise<void>;
  readonly isConnected: boolean;
}

interface TargetAttachedInfo {
  sessionId: string;
  targetInfo: Record<string, unknown>;
  waitingForDebugger: boolean;
}

interface CDPClientOptions {
  debug?: boolean;
  timeout?: number;
}
```

## Tracing Types

```typescript
type TraceLevel = 'debug' | 'info' | 'warn' | 'error';
type TraceCategory = 'cdp' | 'action' | 'wait' | 'navigation';

interface TraceEvent {
  timestamp: string;
  level: TraceLevel;
  category: TraceCategory;
  action?: string;
  selector?: string | string[];
  selectorUsed?: string;
  durationMs?: number;
  success?: boolean;
  error?: string;
  failedSelectors?: Array<{ selector: string; reason: string }>;
}

interface TracerOptions {
  enabled: boolean;
  output: 'console' | 'callback';
  callback?: (event: TraceEvent) => void;
}
```

## Element Types

```typescript
interface ElementInfo {
  nodeId: number;
  backendNodeId: number;
  selector: string;
  waitedMs: number;
}

interface ActionResult {
  success: boolean;
  selector?: string;
  waitedMs: number;
  error?: string;
}
```

## Error Types

```typescript
class ElementNotFoundError extends Error {
  selector: string | string[];
}

class TimeoutError extends Error {
  timeout: number;
}

class NavigationError extends Error {
  url: string;
}

class CDPError extends Error {
  code: number;
  data?: unknown;
}
```

## Import Examples

```typescript
// Import specific types
import type {
  ConnectOptions,
  Page,
  Browser,
  Step,
  BatchResult,
  PageSnapshot,
} from 'browser-pilot';

// Import specific exports
import {
  connect,
  createCDPClient,
  ElementNotFoundError,
  TimeoutError,
} from 'browser-pilot';

// Import from submodules
import type { CDPClient } from 'browser-pilot/cdp';
import type { Provider, ProviderSession } from 'browser-pilot/providers';
import type { Step, BatchResult } from 'browser-pilot/actions';
```
