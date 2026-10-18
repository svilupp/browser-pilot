import type { OwnerExtractRequest, OwnerExtractResult } from './extraction.ts';
/** Owner-controlled operations never accept policy or evidence claims from a caller. */
export type OwnerAction =
  | { kind: 'goto'; url: string }
  | { kind: 'click' | 'hover' | 'submit'; selector: string }
  | { kind: 'fill'; selector: string; value: string; verify?: 'exact' | 'normalized' | false }
  | { kind: 'type' | 'select'; selector: string; value: string }
  | { kind: 'check'; selector: string; checked: boolean }
  | { kind: 'press'; selector: string; key: string };
export type OwnerAssurance = 'owner-serialized-prechecked-native' | 'renderer-same-task-dom';
export interface OwnerActionCapabilities {
  version: 1;
  profile: 'strict';
  assurance: OwnerAssurance;
  actions: readonly OwnerAction['kind'][];
  reads: readonly string[];
  images: false;
  evidence: 'structural-with-trusted-text-redaction';
}
export interface OwnerNodeObservation {
  selector: string;
  role: string;
  name: string;
  text: string;
  visible: boolean;
  enabled: boolean;
  boundingBox: { x: number; y: number; width: number; height: number } | null;
}
export interface OwnerObservation {
  pageTargetId: string;
  documentId: string;
  url: string;
  title: string;
  text: string;
  observedAt: number;
  nodes?: readonly OwnerNodeObservation[];
  element?: {
    exists: boolean;
    visible: boolean;
    count: number;
    text: string;
    boundingBox: OwnerNodeObservation['boundingBox'];
  };
}
export interface PreparedAction {
  preparedId: string;
  pageTargetId: string;
  documentId: string;
  elementIdentity?: string;
  policyVersion: string;
  assurance: OwnerAssurance;
  /** Value payloads are excluded; page text requires trusted host redaction. */
  evidence: OwnerObservation & {
    action: OwnerAction['kind'];
    target?: string;
    destination?: string;
  };
}
export interface OwnerApproval {
  approvalId?: string;
  verdict: 'allow' | 'deny' | 'unknown';
  reason: string;
}
export interface OwnerActionReceipt {
  dispatchState: 'not_dispatched' | 'dispatched' | 'unknown';
  retrySafe: boolean;
  inputEventsSent: string[];
  reason?: string;
  assurance: OwnerAssurance;
}
export interface OwnerActionPort {
  capabilities(): Promise<OwnerActionCapabilities>;
  observe(request: {
    pageTargetId: string;
    kind: 'state' | 'snapshot' | 'element';
    selector?: string;
  }): Promise<OwnerObservation>;
  prepare(request: { pageTargetId: string; action: OwnerAction }): Promise<PreparedAction>;
  authorize(request: { preparedId: string }): Promise<OwnerApproval>;
  dispatch(request: { approvalId: string }): Promise<OwnerActionReceipt>;
  extract(request: OwnerExtractRequest): Promise<OwnerExtractResult>;
}
export interface OwnerGrant {
  ownerEpoch: string;
  grantId: string;
  sequence: number;
}
export interface OwnerActionContext {
  grant: OwnerGrant;
  send(method: string, params?: Record<string, unknown>, sessionId?: string): Promise<unknown>;
  assertCurrent?(): void;
}
export interface OwnerActionPolicy {
  id: string;
  version: string;
  mode: 'shadow' | 'enforce';
  allowedActions: readonly OwnerAction['kind'][];
  timeoutMs?: number;
  allowValueReads?: boolean;
  allowedNavigationOrigins?: readonly string[];
  /** Trusted host callback. Page data is evidence, never instructions or policy. */
  evaluate?(
    evidence: Readonly<PreparedAction>,
    signal: AbortSignal
  ): Promise<{ verdict: 'allow' | 'deny' | 'unknown'; reason: string }>;
  /** Required to expose page text. Default is complete text suppression. Never return secrets. */
  redactText?(text: string): string;
  observe?(result: OwnerApproval): void;
}
export interface OwnerActionService {
  readonly rawAllowed: boolean;
  dispatch(method: string, params: unknown, context: OwnerActionContext): Promise<unknown>;
  revoke(grantId: string, cleanupSend?: OwnerActionContext['send']): Promise<void>;
}
