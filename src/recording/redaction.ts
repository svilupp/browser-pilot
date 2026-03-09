/**
 * Shared redaction helpers for recording and screenshot trails.
 */

export const REDACTED_VALUE = '[REDACTED]';

export const SENSITIVE_AUTOCOMPLETE_TOKENS = [
  'current-password',
  'new-password',
  'one-time-code',
  'cc-number',
  'cc-csc',
  'cc-exp',
  'cc-exp-month',
  'cc-exp-year',
] as const;

export interface ActionTargetMetadata {
  tagName?: string;
  inputType?: string;
  autocomplete?: string;
  sensitiveValue?: boolean;
}

function autocompleteTokens(autocomplete?: string): string[] {
  if (!autocomplete) return [];
  return autocomplete
    .toLowerCase()
    .split(/\s+/)
    .map((token) => token.trim())
    .filter(Boolean);
}

export function isSensitiveFieldMetadata(metadata?: ActionTargetMetadata | null): boolean {
  if (!metadata) return false;
  if (metadata.sensitiveValue) return true;

  const inputType = metadata.inputType?.toLowerCase();
  if (inputType === 'password' || inputType === 'hidden') {
    return true;
  }

  const sensitiveAutocompleteTokens = new Set(SENSITIVE_AUTOCOMPLETE_TOKENS);
  return autocompleteTokens(metadata.autocomplete).some((token) =>
    sensitiveAutocompleteTokens.has(token as (typeof SENSITIVE_AUTOCOMPLETE_TOKENS)[number])
  );
}

export function redactValueForRecording(
  value: string | undefined,
  metadata?: ActionTargetMetadata | null
): string | undefined {
  if (value === undefined) return undefined;
  return isSensitiveFieldMetadata(metadata) ? REDACTED_VALUE : value;
}
