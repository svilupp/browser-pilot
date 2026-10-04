import { isRecord } from '../utils/json.ts';
import type { ExceptionDetails, RemoteObject } from './protocol.ts';

export class RuntimeResultError extends Error {
  constructor(
    public readonly code: 'PROTOCOL_RESULT_INVALID' | 'RUNTIME_EXCEPTION',
    message: string,
    public readonly exceptionDetails?: ExceptionDetails
  ) {
    super(message);
    this.name = 'RuntimeResultError';
  }
}
/** Validate protocol shape before a renderer result can become a successful read. */
export function decodeRuntimeResult(value: unknown): RemoteObject {
  if (!isRecord(value))
    throw new RuntimeResultError('PROTOCOL_RESULT_INVALID', 'Missing Runtime result');
  if ('exceptionDetails' in value && value['exceptionDetails'] !== undefined) {
    if (
      !isRecord(value['exceptionDetails']) ||
      typeof value['exceptionDetails']['text'] !== 'string'
    )
      throw new RuntimeResultError(
        'PROTOCOL_RESULT_INVALID',
        'Malformed Runtime result exception details'
      );
    const details = value['exceptionDetails'] as unknown as ExceptionDetails;
    throw new RuntimeResultError(
      'RUNTIME_EXCEPTION',
      details.exception?.description ?? details.text ?? 'Runtime exception',
      details
    );
  }
  if (!isRecord(value['result']))
    throw new RuntimeResultError('PROTOCOL_RESULT_INVALID', 'Malformed Runtime result object');
  const object = value['result'];
  const types = [
    'object',
    'function',
    'undefined',
    'string',
    'number',
    'boolean',
    'symbol',
    'bigint',
  ];
  if (typeof object['type'] !== 'string' || !types.includes(object['type']))
    throw new RuntimeResultError('PROTOCOL_RESULT_INVALID', 'Malformed Runtime result type');
  if ('value' in object) {
    const type = object['type'];
    const actual = typeof object['value'];
    if (
      (['string', 'number', 'boolean', 'undefined'].includes(type) && actual !== type) ||
      (type === 'object' && actual !== 'object')
    )
      throw new RuntimeResultError('PROTOCOL_RESULT_INVALID', 'Malformed Runtime result value');
  }
  return value['result'] as unknown as RemoteObject;
}
