/**
 * Provider type definitions
 */

export interface ProviderSession {
  /** WebSocket URL to connect to CDP */
  wsUrl: string;
  /** Provider-specific session ID (for resumption) */
  sessionId?: string;
  /** Additional metadata from the provider */
  metadata?: Record<string, unknown>;
  /** Close the provider session */
  close(): Promise<void>;
}

export interface Provider {
  /** Provider name identifier */
  readonly name: string;
  /** Create a new browser session */
  createSession(options?: CreateSessionOptions): Promise<ProviderSession>;
  /** Resume an existing session by ID */
  resumeSession?(sessionId: string): Promise<ProviderSession>;
}

export interface CreateSessionOptions {
  /** Viewport width */
  width?: number;
  /** Viewport height */
  height?: number;
  /** Enable recording (if provider supports) */
  recording?: boolean;
  /** Proxy configuration */
  proxy?: ProxyConfig;
  /** Additional provider-specific options */
  [key: string]: unknown;
}

export interface ProxyConfig {
  server: string;
  username?: string;
  password?: string;
}

export interface ConnectOptions {
  /** Provider type */
  provider: 'browserbase' | 'browserless' | 'generic';
  /** API key for hosted providers */
  apiKey?: string;
  /** Project ID (for BrowserBase) */
  projectId?: string;
  /** Direct WebSocket URL (for generic provider) */
  wsUrl?: string;
  /** Session creation options */
  session?: CreateSessionOptions;
  /** Enable debug logging */
  debug?: boolean;
  /** Connection timeout in ms */
  timeout?: number;
}
