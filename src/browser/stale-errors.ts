/** Central classification for Chrome errors caused by detached DOM or contexts. */

export type StaleErrorKind = 'detached' | 'replaced' | 'context';

export interface StaleErrorClassification {
  stale: boolean;
  kind?: StaleErrorKind;
  message: string;
}

const DETACHED_PATTERNS = [
  /could not find node with given id/i,
  /node with given id does not belong to the document/i,
  /node .*does not belong to the document/i,
  /no node with given id found/i,
  /node is detached from (?:the )?document/i,
  /detached from (?:the )?document/i,
];

const REPLACED_PATTERNS = [
  /could not find object with given id/i,
  /object with given id/i,
  /argument should belong to the same javascript world/i,
  /node was replaced/i,
];

const CONTEXT_PATTERNS = [
  /cannot find context with specified id/i,
  /cannot find context with given id/i,
  /execution context was destroyed/i,
  /no execution context with given id/i,
  /context .*destroyed/i,
];

/** Classify stale/detached/context failures without scattering string checks. */
export function classifyStaleError(error: unknown): StaleErrorClassification {
  const message = error instanceof Error ? error.message : String(error ?? '');
  if (DETACHED_PATTERNS.some((pattern) => pattern.test(message))) {
    return { stale: true, kind: 'detached', message };
  }
  if (REPLACED_PATTERNS.some((pattern) => pattern.test(message))) {
    return { stale: true, kind: 'replaced', message };
  }
  if (CONTEXT_PATTERNS.some((pattern) => pattern.test(message))) {
    return { stale: true, kind: 'context', message };
  }
  return { stale: false, message };
}

export interface StaleRecoveryDiagnostics {
  oldRef: string;
  newRef: string;
  confidence: number;
  ambiguityMargin: number;
  oldFingerprint: unknown;
  newFingerprint: unknown;
  alternatives: Array<{ ref: string; confidence: number }>;
}
