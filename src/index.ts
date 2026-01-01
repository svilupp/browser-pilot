/**
 * browser-pilot - Lightweight CDP-based browser automation
 *
 * A browser automation library built on Chrome DevTools Protocol
 * that works in Node.js, Bun, and Cloudflare Workers.
 */

// Actions & Batch Execution
export {
  type ActionType,
  addBatchToPage,
  BatchExecutor,
  type BatchOptions,
  type BatchResult,
  type Step,
  type StepResult,
} from './actions/index.ts';
// Browser & Page
export {
  type ActionOptions,
  type ActionResult,
  Browser,
  type BrowserOptions,
  type CustomSelectConfig,
  connect,
  type Download,
  type ElementInfo,
  ElementNotFoundError,
  type FileInput,
  type FillOptions,
  type InteractiveElement,
  NavigationError,
  type NetworkIdleOptions,
  Page,
  type PageSnapshot,
  type SnapshotNode,
  type SubmitOptions,
  TimeoutError,
  type TypeOptions,
  type WaitForOptions,
} from './browser/index.ts';

// CDP Client (for advanced usage)
export {
  type CDPClient,
  type CDPClientOptions,
  CDPError,
  createCDPClient,
} from './cdp/index.ts';

// Providers
export {
  BrowserBaseProvider,
  BrowserlessProvider,
  type ConnectOptions,
  type CreateSessionOptions,
  createProvider,
  discoverTargets,
  GenericProvider,
  getBrowserWebSocketUrl,
  type Provider,
  type ProviderSession,
} from './providers/index.ts';
// Tracing
export {
  disableTracing,
  enableTracing,
  getTracer,
  type TraceCategory,
  type TraceEvent,
  type TraceLevel,
  Tracer,
  type TracerOptions,
} from './trace/index.ts';
// Waiting utilities
export {
  type WaitOptions,
  type WaitResult,
  type WaitState,
  waitForAnyElement,
  waitForElement,
  waitForNavigation,
  waitForNetworkIdle,
} from './wait/index.ts';
