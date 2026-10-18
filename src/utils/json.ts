export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export function stringifyUnknown(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value);
  }
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  try {
    return JSON.stringify(value);
  } catch {
    return Object.prototype.toString.call(value);
  }
}

/** Parse untrusted JSON without allowing JSON.parse's any to escape. */
export function parseJson(text: string): unknown {
  return JSON.parse(text);
}

/** Decode an object boundary before reading fields. */
export function parseJsonRecord(text: string): Record<string, unknown> {
  const value = parseJson(text);
  if (!isRecord(value) || Array.isArray(value)) throw new Error('Expected a JSON object');
  return value;
}

export type JsonDecoder<T> = (value: unknown) => T;

/** Validate each declared field and construct a typed object from untrusted data. */
export function decodeObject<S extends Record<string, JsonDecoder<unknown>>>(
  value: unknown,
  fields: S
): { [K in keyof S]: ReturnType<S[K]> } {
  if (!isRecord(value) || Array.isArray(value)) throw new Error('Expected a JSON object');
  const decoded: Record<string, unknown> = {};
  for (const [key, decode] of Object.entries(fields)) {
    const field = decode(value[key]);
    if (field !== undefined) decoded[key] = field;
  }
  // Each property has been constructed by its declared decoder above.
  return decoded as { [K in keyof S]: ReturnType<S[K]> };
}

export function jsonString(value: unknown): string {
  if (typeof value !== 'string') throw new Error('Expected a JSON string');
  return value;
}

export function jsonNumber(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value))
    throw new Error('Expected a finite JSON number');
  return value;
}

export function jsonBoolean(value: unknown): boolean {
  if (typeof value !== 'boolean') throw new Error('Expected a JSON boolean');
  return value;
}

export function optionalJson<T>(decode: JsonDecoder<T>): JsonDecoder<T | undefined> {
  return (value) => (value === undefined ? undefined : decode(value));
}

export function jsonRecord(value: unknown): Record<string, unknown> {
  if (!isRecord(value) || Array.isArray(value)) throw new Error('Expected a JSON object');
  return value;
}

export function jsonArray<T>(decode: JsonDecoder<T>): JsonDecoder<T[]> {
  return (value) => {
    if (!Array.isArray(value)) throw new Error('Expected a JSON array');
    return value.map(decode);
  };
}

export function jsonTraceSeverity(value: unknown): 'info' | 'warn' | 'error' {
  if (value !== 'info' && value !== 'warn' && value !== 'error')
    throw new Error('Invalid trace severity');
  return value;
}

export function jsonEnum<const T extends readonly (string | number | boolean)[]>(
  values: T
): JsonDecoder<T[number]> {
  return (value) => {
    for (const candidate of values) if (value === candidate) return candidate;
    throw new Error('Unexpected JSON value');
  };
}

export function nullableJson<T>(decode: JsonDecoder<T>): JsonDecoder<T | null> {
  return (value) => (value === null ? null : decode(value));
}

export function jsonMap<T>(decode: JsonDecoder<T>): JsonDecoder<Record<string, T>> {
  return (value) =>
    Object.fromEntries(
      Object.entries(jsonRecord(value)).map(([key, entry]) => [key, decode(entry)])
    );
}

export type DecodedJsonValue =
  | string
  | number
  | boolean
  | null
  | DecodedJsonValue[]
  | { [key: string]: DecodedJsonValue };
export function jsonValue(value: unknown): DecodedJsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') return jsonNumber(value);
  if (Array.isArray(value)) return value.map(jsonValue);
  return jsonMap(jsonValue)(value);
}
