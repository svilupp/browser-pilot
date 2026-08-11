/** Type-safe extraction of a string from an unknown value. */
export function readString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/** Type-safe extraction of a string with a fallback default. */
export function readStringOr(value: unknown, fallback = ''): string {
  return readString(value) ?? fallback;
}

/** Format a CDP console argument entry for display. */
export function formatConsoleArg(entry: Record<string, unknown>): string {
  return readString(entry['value']) ?? readString(entry['description']) ?? '';
}

/** Convert a simple glob pattern to a RegExp. Supports * only. */
export function globToRegex(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  const withWildcards = escaped.replace(/\*/g, '.*');
  return new RegExp(`^${withWildcards}$`, 's');
}
