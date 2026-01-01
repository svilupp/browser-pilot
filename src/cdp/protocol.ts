/**
 * CDP Protocol type definitions
 * Minimal subset of Chrome DevTools Protocol types needed for browser automation
 */

// CDP Message Types
export interface CDPRequest {
  id: number;
  method: string;
  params?: Record<string, unknown>;
  sessionId?: string;
}

export interface CDPResponse {
  id: number;
  result?: unknown;
  error?: CDPErrorData;
  sessionId?: string;
}

export interface CDPEvent {
  method: string;
  params?: Record<string, unknown>;
  sessionId?: string;
}

export interface CDPErrorData {
  code: number;
  message: string;
  data?: string;
}

export type CDPMessage = CDPResponse | CDPEvent;

// CDP Error class
export class CDPError extends Error {
  code: number;
  data?: string;

  constructor(error: CDPErrorData) {
    super(error.message);
    this.name = 'CDPError';
    this.code = error.code;
    this.data = error.data;
  }
}

// Target Types
export interface TargetInfo {
  targetId: string;
  type: string;
  title: string;
  url: string;
  attached: boolean;
  canAccessOpener: boolean;
  browserContextId?: string;
}

// DOM Types
export interface DOMNode {
  nodeId: number;
  backendNodeId: number;
  nodeType: number;
  nodeName: string;
  localName: string;
  nodeValue: string;
  childNodeCount?: number;
  children?: DOMNode[];
  attributes?: string[];
  documentURL?: string;
  baseURL?: string;
  publicId?: string;
  systemId?: string;
  internalSubset?: string;
  xmlVersion?: string;
  name?: string;
  value?: string;
  pseudoType?: string;
  shadowRootType?: string;
  frameId?: string;
  contentDocument?: DOMNode;
  shadowRoots?: DOMNode[];
  templateContent?: DOMNode;
  pseudoElements?: DOMNode[];
  importedDocument?: DOMNode;
  distributedNodes?: BackendNode[];
  isSVG?: boolean;
}

export interface BackendNode {
  nodeType: number;
  nodeName: string;
  backendNodeId: number;
}

// Accessibility Types
export interface AXNode {
  nodeId: string;
  ignored: boolean;
  ignoredReasons?: AXProperty[];
  role?: AXValue;
  chromeRole?: AXValue;
  name?: AXValue;
  description?: AXValue;
  value?: AXValue;
  properties?: AXProperty[];
  parentId?: string;
  childIds?: string[];
  backendDOMNodeId?: number;
  frameId?: string;
}

export interface AXValue {
  type: string;
  value?: unknown;
  relatedNodes?: AXRelatedNode[];
  sources?: AXValueSource[];
}

export interface AXRelatedNode {
  backendDOMNodeId: number;
  idref?: string;
  text?: string;
}

export interface AXValueSource {
  type: string;
  value?: AXValue;
  attribute?: string;
  attributeValue?: AXValue;
  superseded?: boolean;
  nativeSource?: string;
  nativeSourceValue?: AXValue;
  invalid?: boolean;
  invalidReason?: string;
}

export interface AXProperty {
  name: string;
  value: AXValue;
}

// Runtime Types
export interface RemoteObject {
  type: string;
  subtype?: string;
  className?: string;
  value?: unknown;
  unserializableValue?: string;
  description?: string;
  objectId?: string;
  preview?: ObjectPreview;
  customPreview?: CustomPreview;
}

export interface ObjectPreview {
  type: string;
  subtype?: string;
  description?: string;
  overflow: boolean;
  properties: PropertyPreview[];
  entries?: EntryPreview[];
}

export interface PropertyPreview {
  name: string;
  type: string;
  value?: string;
  valuePreview?: ObjectPreview;
  subtype?: string;
}

export interface EntryPreview {
  key?: ObjectPreview;
  value: ObjectPreview;
}

export interface CustomPreview {
  header: string;
  bodyGetterId?: string;
}

export interface ExceptionDetails {
  exceptionId: number;
  text: string;
  lineNumber: number;
  columnNumber: number;
  scriptId?: string;
  url?: string;
  stackTrace?: StackTrace;
  exception?: RemoteObject;
  executionContextId?: number;
}

export interface StackTrace {
  description?: string;
  callFrames: CallFrame[];
  parent?: StackTrace;
  parentId?: StackTraceId;
}

export interface CallFrame {
  functionName: string;
  scriptId: string;
  url: string;
  lineNumber: number;
  columnNumber: number;
}

export interface StackTraceId {
  id: string;
  debuggerId?: string;
}

// Input Types
export type MouseButton = 'none' | 'left' | 'middle' | 'right' | 'back' | 'forward';
export type MouseEventType = 'mousePressed' | 'mouseReleased' | 'mouseMoved' | 'mouseWheel';
export type KeyEventType = 'keyDown' | 'keyUp' | 'rawKeyDown' | 'char';

// Page Types
export interface FrameTree {
  frame: FrameInfo;
  childFrames?: FrameTree[];
}

export interface FrameInfo {
  id: string;
  parentId?: string;
  loaderId: string;
  name?: string;
  url: string;
  urlFragment?: string;
  domainAndRegistry: string;
  securityOrigin: string;
  mimeType: string;
  unreachableUrl?: string;
  adFrameStatus?: AdFrameStatus;
  secureContextType: string;
  crossOriginIsolatedContextType: string;
  gatedAPIFeatures: string[];
}

export interface AdFrameStatus {
  adFrameType: string;
  explanations?: string[];
}

// Screenshot Types
export interface Viewport {
  x: number;
  y: number;
  width: number;
  height: number;
  scale: number;
}

// Box Model
export interface BoxModel {
  content: number[];
  padding: number[];
  border: number[];
  margin: number[];
  width: number;
  height: number;
  shapeOutside?: ShapeOutsideInfo;
}

export interface ShapeOutsideInfo {
  bounds: number[];
  shape: unknown[];
  marginShape: unknown[];
}
