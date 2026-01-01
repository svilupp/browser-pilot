/**
 * Network interception types
 */

export type ResourceType =
  | 'Document'
  | 'Stylesheet'
  | 'Image'
  | 'Media'
  | 'Font'
  | 'Script'
  | 'TextTrack'
  | 'XHR'
  | 'Fetch'
  | 'Prefetch'
  | 'EventSource'
  | 'WebSocket'
  | 'Manifest'
  | 'SignedExchange'
  | 'Ping'
  | 'CSPViolationReport'
  | 'Preflight'
  | 'Other';

export interface RequestPattern {
  /** URL pattern (glob or regex string) */
  urlPattern?: string;
  /** Resource type to match */
  resourceType?: ResourceType;
  /** Request stage to intercept */
  requestStage?: 'Request' | 'Response';
}

export interface InterceptedRequest {
  /** Unique request ID */
  requestId: string;
  /** Request URL */
  url: string;
  /** HTTP method */
  method: string;
  /** Request headers */
  headers: Record<string, string>;
  /** POST data if present */
  postData?: string;
  /** Resource type */
  resourceType: ResourceType;
  /** Frame ID that initiated the request */
  frameId: string;
  /** Whether this is a navigation request */
  isNavigationRequest: boolean;
  /** Response status (only if intercepting response) */
  responseStatusCode?: number;
  /** Response headers (only if intercepting response) */
  responseHeaders?: Record<string, string>;
}

export interface ContinueRequestOptions {
  /** Override URL */
  url?: string;
  /** Override method */
  method?: string;
  /** Override headers */
  headers?: Record<string, string>;
  /** Override POST data */
  postData?: string;
}

export interface FulfillRequestOptions {
  /** Response status code */
  status: number;
  /** Response headers */
  headers?: Record<string, string>;
  /** Response body (string or base64 for binary) */
  body?: string;
  /** Whether body is base64 encoded */
  isBase64Encoded?: boolean;
}

export interface FailRequestOptions {
  /** Error reason */
  reason:
    | 'Failed'
    | 'Aborted'
    | 'TimedOut'
    | 'AccessDenied'
    | 'ConnectionClosed'
    | 'ConnectionReset'
    | 'ConnectionRefused'
    | 'ConnectionAborted'
    | 'ConnectionFailed'
    | 'NameNotResolved'
    | 'InternetDisconnected'
    | 'AddressUnreachable'
    | 'BlockedByClient'
    | 'BlockedByResponse';
}

export type RequestHandler = (
  request: InterceptedRequest,
  actions: RequestActions
) => void | Promise<void>;

export interface RequestActions {
  /** Continue request, optionally modifying it */
  continue(options?: ContinueRequestOptions): Promise<void>;
  /** Fulfill request with custom response */
  fulfill(options: FulfillRequestOptions): Promise<void>;
  /** Fail/abort the request */
  fail(options?: FailRequestOptions): Promise<void>;
}

export interface RouteOptions {
  /** Response status code */
  status?: number;
  /** Response headers */
  headers?: Record<string, string>;
  /** Response body */
  body?: string | object;
  /** Content type (auto-sets header) */
  contentType?: string;
}
