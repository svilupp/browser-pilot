import { describe, expect, test } from 'bun:test';
import {
  createTargetFingerprint,
  recoverPinnedTarget,
  type TargetInfo,
} from '../../src/browser/target-pin.ts';

function makeTarget(overrides: Partial<TargetInfo> = {}): TargetInfo {
  return {
    targetId: 'target-1',
    type: 'page',
    url: 'https://example.com',
    title: 'Example',
    attached: false,
    ...overrides,
  };
}

describe('createTargetFingerprint', () => {
  test('creates correct structure', () => {
    const fp = createTargetFingerprint('t1', 'https://example.com', 'Example');
    expect(fp.originalTargetId).toBe('t1');
    expect(fp.url).toBe('https://example.com');
    expect(fp.title).toBe('Example');
    expect(typeof fp.pinnedAt).toBe('number');
    expect(fp.pinnedAt).toBeGreaterThan(0);
  });
});

describe('recoverPinnedTarget', () => {
  test('exact match by target ID', () => {
    const pin = createTargetFingerprint('t1', 'https://example.com', 'Example');
    const targets = [makeTarget({ targetId: 't1' })];
    const result = recoverPinnedTarget(pin, targets);
    expect(result).not.toBeNull();
    expect(result!.targetId).toBe('t1');
    expect(result!.method).toBe('exact');
    expect(result!.confidence).toBe(1.0);
  });

  test('URL match when target ID differs', () => {
    const pin = createTargetFingerprint('t1', 'https://example.com', 'Old Title');
    const targets = [
      makeTarget({ targetId: 't2', url: 'https://example.com', title: 'New Title' }),
    ];
    const result = recoverPinnedTarget(pin, targets);
    expect(result).not.toBeNull();
    expect(result!.targetId).toBe('t2');
    expect(result!.method).toBe('url_match');
    expect(result!.confidence).toBeGreaterThanOrEqual(0.6);
  });

  test('title match when URL and ID differ', () => {
    const pin = createTargetFingerprint('t1', 'https://old.com', 'My App');
    const targets = [makeTarget({ targetId: 't2', url: 'https://new.com', title: 'My App' })];
    // Title-only score is 0.3, so use a lower threshold
    const result = recoverPinnedTarget(pin, targets, 0.25);
    expect(result).not.toBeNull();
    expect(result!.method).toBe('title_match');
  });

  test('no match below threshold returns null', () => {
    const pin = createTargetFingerprint('t1', 'https://example.com', 'Example');
    const targets = [
      makeTarget({ targetId: 't2', url: 'https://totally-different.com', title: 'Other' }),
    ];
    const result = recoverPinnedTarget(pin, targets);
    expect(result).toBeNull();
  });

  test('empty target list returns null', () => {
    const pin = createTargetFingerprint('t1', 'https://example.com', 'Example');
    const result = recoverPinnedTarget(pin, []);
    expect(result).toBeNull();
  });

  test('prefers exact match over URL match', () => {
    const pin = createTargetFingerprint('t1', 'https://example.com', 'Example');
    const targets = [
      makeTarget({ targetId: 't2', url: 'https://example.com', title: 'Example' }),
      makeTarget({ targetId: 't1', url: 'https://other.com', title: 'Other' }),
    ];
    const result = recoverPinnedTarget(pin, targets);
    expect(result).not.toBeNull();
    expect(result!.targetId).toBe('t1');
    expect(result!.method).toBe('exact');
  });

  test('prefers URL match over title match', () => {
    const pin = createTargetFingerprint('t1', 'https://example.com', 'Example');
    const targets = [
      makeTarget({ targetId: 't3', url: 'https://other.com', title: 'Example' }),
      makeTarget({ targetId: 't2', url: 'https://example.com', title: 'Different' }),
    ];
    const result = recoverPinnedTarget(pin, targets);
    expect(result).not.toBeNull();
    expect(result!.targetId).toBe('t2');
    expect(result!.method).toBe('url_match');
  });

  test('non-page types get penalized', () => {
    const pin = createTargetFingerprint('t1', 'https://example.com', 'Example');
    const pageTarget = makeTarget({
      targetId: 't2',
      url: 'https://example.com',
      title: 'Example',
      type: 'page',
    });
    const workerTarget = makeTarget({
      targetId: 't3',
      url: 'https://example.com',
      title: 'Example',
      type: 'service_worker',
    });

    // Worker alone should still match but with lower confidence
    const workerResult = recoverPinnedTarget(pin, [workerTarget]);
    expect(workerResult).not.toBeNull();
    expect(workerResult!.confidence).toBeLessThan(0.9);

    // Page should win over worker when both present
    const result = recoverPinnedTarget(pin, [workerTarget, pageTarget]);
    expect(result).not.toBeNull();
    expect(result!.targetId).toBe('t2');
  });

  test('same origin partial URL match scores above zero', () => {
    const pin = createTargetFingerprint('t1', 'https://example.com/page1', 'Page 1');
    const targets = [
      makeTarget({ targetId: 't2', url: 'https://example.com/page2', title: 'Page 2' }),
    ];
    // Same origin (0.3) but below default threshold (0.4), so null with default threshold
    const resultDefault = recoverPinnedTarget(pin, targets);
    expect(resultDefault).toBeNull();
    // But with a lower threshold it matches
    const result = recoverPinnedTarget(pin, targets, 0.2);
    expect(result).not.toBeNull();
    expect(result!.method).toBe('best_guess');
    expect(result!.confidence).toBeGreaterThanOrEqual(0.3);
  });
});
