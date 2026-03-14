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
  type RecordOptions,
  type Step,
  type StepResult,
  type ValidationError,
  type ValidationResult,
  validateSteps,
} from './actions/index.ts';
// Audio I/O
export {
  type AudioChunk,
  type AudioFlagOptions,
  AudioInput,
  type AudioInputState,
  AudioOutput,
  bufferToBase64,
  type CaptureOptions,
  type CaptureResult,
  calculateRMS,
  generateSilence,
  generateTone,
  getAudioChromeFlags,
  grantAudioPermissions,
  isTranscriptionAvailable,
  type PlayOptions,
  parseWavHeader,
  pcmToWav,
  type RoundTripOptions,
  type RoundTripResult,
  type TranscribeOptions,
  type TranscribeResult,
  transcribe,
} from './audio/index.ts';
// Browser & Page
export {
  type ActionOptions,
  type ActionResult,
  Browser,
  type BrowserOptions,
  type ConsoleHandler,
  type ConsoleMessage,
  type ConsoleMessageType,
  type CustomSelectConfig,
  connect,
  type Dialog,
  type DialogHandler,
  type DialogType,
  type Download,
  type ElementInfo,
  ElementNotFoundError,
  type EmulationState,
  type ErrorHandler,
  type FileInput,
  type FillOptions,
  type FormField,
  type FormOption,
  type GeolocationOptions,
  type InteractiveElement,
  NavigationError,
  type NetworkIdleOptions,
  Page,
  type PageError,
  type PageOptions,
  type PageSnapshot,
  type SnapshotNode,
  type SnapshotOptions,
  type SubmitOptions,
  TimeoutError,
  type TypeOptions,
  type UserAgentMetadata,
  type UserAgentOptions,
  type ViewportOptions,
  type WaitForOptions,
} from './browser/index.ts';
// CDP Client (for advanced usage)
export {
  type CDPClient,
  type CDPClientOptions,
  CDPError,
  createCDPClient,
} from './cdp/index.ts';
// Emulation
export { type DeviceDescriptor, type DeviceName, devices } from './emulation/index.ts';
// Network Interception
export {
  type ContinueRequestOptions,
  type FailRequestOptions,
  type FulfillRequestOptions,
  type InterceptedRequest,
  type RequestActions,
  type RequestHandler,
  RequestInterceptor,
  type RequestPattern,
  type ResourceType,
  type RouteOptions,
} from './network/index.ts';
// Providers
export {
  BrowserBaseProvider,
  BrowserEndpointResolutionError,
  BrowserlessProvider,
  buildLocalBrowserScanTargets,
  type ChromeChannel,
  type ConnectOptions,
  type CreateSessionOptions,
  createProvider,
  discoverLocalBrowsers,
  discoverTargets,
  GenericProvider,
  getBrowserWebSocketUrl,
  type Provider,
  type ProviderSession,
  parseDevToolsActivePortFile,
  type ResolvedBrowserEndpoint,
  resolveBrowserEndpoint,
  resolveChromeUserDataDirs,
} from './providers/index.ts';
// Storage (Cookies)
export type {
  ClearCookiesOptions,
  Cookie,
  DeleteCookieOptions,
  SetCookieOptions,
} from './storage/index.ts';
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
