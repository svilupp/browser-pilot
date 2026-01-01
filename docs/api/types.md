# Types Reference

Complete TypeScript type definitions for browser-pilot.

## Connection Types

```typescript
interface ConnectOptions {
  provider: 'browserbase' | 'browserless' | 'generic';
  apiKey?: string;
  projectId?: string;
  wsUrl?: string;
  session?: CreateSessionOptions;
  debug?: boolean;
  timeout?: number;
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
}

interface FillOptions extends ActionOptions {
  clear?: boolean;
}

interface TypeOptions extends ActionOptions {
  delay?: number;
}

interface SubmitOptions extends ActionOptions {
  method?: 'enter' | 'click' | 'enter+click';
  waitForNavigation?: boolean;
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
  | 'focus'
  | 'hover'
  | 'scroll'
  | 'wait'
  | 'snapshot'
  | 'screenshot'
  | 'evaluate';

interface Step {
  action: ActionType;
  selector?: string | string[];
  url?: string;
  value?: string | string[];
  key?: string;
  waitFor?: 'visible' | 'hidden' | 'attached' | 'detached' | 'navigation' | 'networkIdle';
  timeout?: number;
  optional?: boolean;
  method?: 'enter' | 'click' | 'enter+click';
  clear?: boolean;
  delay?: number;
  trigger?: string | string[];
  option?: string | string[];
  match?: 'text' | 'value' | 'contains';
  x?: number;
  y?: number;
  format?: 'png' | 'jpeg' | 'webp';
  quality?: number;
  fullPage?: boolean;
}

interface BatchOptions {
  timeout?: number;
  onFail?: 'stop' | 'continue';
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
}

interface BatchResult {
  success: boolean;
  stoppedAtIndex?: number;
  steps: StepResult[];
  totalDurationMs: number;
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
}

interface WaitResult {
  success: boolean;
  selector?: string;
  waitedMs: number;
}
```

## CDP Types

```typescript
interface CDPClient {
  send<T>(method: string, params?: object): Promise<T>;
  on(event: string, handler: (params: unknown) => void): void;
  off(event: string, handler: (params: unknown) => void): void;
  close(): Promise<void>;
  attachToTarget(targetId: string): Promise<string>;
  readonly isConnected: boolean;
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
