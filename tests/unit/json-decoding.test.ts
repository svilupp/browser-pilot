import { expect, test } from 'bun:test';
import { parseTraceEvent } from '../../src/trace/model.ts';
import {
  decodeObject,
  jsonArray,
  jsonNumber,
  jsonString,
  optionalJson,
  parseJson,
  parseJsonRecord,
} from '../../src/utils/json.ts';

test('JSON boundaries reject malformed object fields and nested array entries', () => {
  const decode = (text: string) =>
    decodeObject(parseJson(text), {
      id: jsonNumber,
      names: jsonArray(jsonString),
      note: optionalJson(jsonString),
    });
  expect(decode('{"id":1,"names":["ready"]}')).toMatchObject({ id: 1, names: ['ready'] });
  expect(Object.hasOwn(decode('{"id":1,"names":[]}'), 'note')).toBe(false);
  for (const text of ['null', '[]', '{"id":"1","names":[]}', '{"id":1,"names":[false]}']) {
    expect(() => decode(text)).toThrow();
  }
  expect(() => parseJsonRecord('[]')).toThrow('Expected a JSON object');
});

test('persisted traces validate their event channel and data before use', () => {
  const event = {
    traceId: 'trace-1',
    ts: '2026-10-18T00:00:00.000Z',
    elapsedMs: 1,
    channel: 'action' as const,
    event: 'action.complete',
    severity: 'info' as const,
    summary: 'Complete',
    data: {},
  };
  expect(parseTraceEvent(JSON.stringify(event))).toEqual(event);
  expect(() => parseTraceEvent(JSON.stringify({ ...event, channel: 'invalid' }))).toThrow();
  expect(() => parseTraceEvent(JSON.stringify({ ...event, data: null }))).toThrow();
});
