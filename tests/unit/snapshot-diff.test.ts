import { describe, expect, it } from 'bun:test';
import { diffSnapshots, formatDiffPretty } from '../../src/browser/snapshot-diff.ts';
import type { PageSnapshot, SnapshotNode } from '../../src/browser/types.ts';

function createSnapshot(
  elements: SnapshotNode[],
  url = 'https://example.com',
  title = 'Test'
): PageSnapshot {
  return {
    url,
    title,
    timestamp: new Date().toISOString(),
    accessibilityTree: elements,
    interactiveElements: [],
    text: '',
  };
}

describe('diffSnapshots', () => {
  it('detects added elements', () => {
    const before = createSnapshot([{ ref: 'e1', role: 'button', name: 'Submit' }]);
    const after = createSnapshot([
      { ref: 'e1', role: 'button', name: 'Submit' },
      { ref: 'e2', role: 'link', name: 'New Link' },
    ]);

    const diff = diffSnapshots(before, after);

    expect(diff.summary.added).toBe(1);
    expect(diff.changes.added.length).toBe(1);
    expect(diff.changes.added[0]?.name).toBe('New Link');
  });

  it('detects removed elements', () => {
    const before = createSnapshot([
      { ref: 'e1', role: 'button', name: 'Submit' },
      { ref: 'e2', role: 'dialog', name: 'Cookie Banner' },
    ]);
    const after = createSnapshot([{ ref: 'e1', role: 'button', name: 'Submit' }]);

    const diff = diffSnapshots(before, after);

    expect(diff.summary.removed).toBe(1);
    expect(diff.changes.removed.length).toBe(1);
    expect(diff.changes.removed[0]?.name).toBe('Cookie Banner');
  });

  it('detects changed elements', () => {
    const before = createSnapshot([{ ref: 'e1', role: 'button', name: 'Submit', disabled: false }]);
    const after = createSnapshot([{ ref: 'e1', role: 'button', name: 'Submit', disabled: true }]);

    const diff = diffSnapshots(before, after);

    expect(diff.summary.changed).toBe(1);
    expect(diff.changes.changed.length).toBe(1);
    expect(diff.changes.changed[0]?.changedFields).toContain('disabled');
  });

  it('matches elements by key despite different refs', () => {
    // Refs are not stable across snapshots - matching should work by role+name+position
    const before = createSnapshot([{ ref: 'e1', role: 'button', name: 'Submit', disabled: false }]);
    const after = createSnapshot([
      { ref: 'e5', role: 'button', name: 'Submit', disabled: true }, // Different ref
    ]);

    const diff = diffSnapshots(before, after);

    // Should detect as changed, not as added+removed
    expect(diff.summary.added).toBe(0);
    expect(diff.summary.removed).toBe(0);
    expect(diff.summary.changed).toBe(1);
  });

  it('tracks unchanged elements', () => {
    const before = createSnapshot([
      { ref: 'e1', role: 'button', name: 'Submit' },
      { ref: 'e2', role: 'textbox', name: 'Email' },
    ]);
    const after = createSnapshot([
      { ref: 'e1', role: 'button', name: 'Submit' },
      { ref: 'e2', role: 'textbox', name: 'Email' },
    ]);

    const diff = diffSnapshots(before, after);

    expect(diff.summary.unchanged).toBe(2);
    expect(diff.summary.added).toBe(0);
    expect(diff.summary.removed).toBe(0);
    expect(diff.summary.changed).toBe(0);
  });

  it('handles nested children correctly', () => {
    const before = createSnapshot([
      {
        ref: 'e1',
        role: 'form',
        name: 'Login',
        children: [{ ref: 'e2', role: 'textbox', name: 'Username' }],
      },
    ]);
    const after = createSnapshot([
      {
        ref: 'e1',
        role: 'form',
        name: 'Login',
        children: [
          { ref: 'e2', role: 'textbox', name: 'Username' },
          { ref: 'e3', role: 'textbox', name: 'Password' },
        ],
      },
    ]);

    const diff = diffSnapshots(before, after);

    expect(diff.summary.added).toBe(1);
    expect(diff.changes.added[0]?.name).toBe('Password');
  });

  it('detects value changes', () => {
    const before = createSnapshot([{ ref: 'e1', role: 'textbox', name: 'Email', value: '' }]);
    const after = createSnapshot([
      { ref: 'e1', role: 'textbox', name: 'Email', value: 'test@example.com' },
    ]);

    const diff = diffSnapshots(before, after);

    expect(diff.summary.changed).toBe(1);
    expect(diff.changes.changed[0]?.changedFields).toContain('value');
  });

  it('includes metadata in diff result', () => {
    const before = createSnapshot([], 'https://before.com', 'Before Page');
    const after = createSnapshot([], 'https://after.com', 'After Page');

    const diff = diffSnapshots(before, after);

    expect(diff.metadata.before.url).toBe('https://before.com');
    expect(diff.metadata.before.title).toBe('Before Page');
    expect(diff.metadata.after.url).toBe('https://after.com');
    expect(diff.metadata.after.title).toBe('After Page');
    expect(diff.metadata.generatedAt).toBeTruthy();
  });

  it('handles empty snapshots', () => {
    const before = createSnapshot([]);
    const after = createSnapshot([]);

    const diff = diffSnapshots(before, after);

    expect(diff.summary.added).toBe(0);
    expect(diff.summary.removed).toBe(0);
    expect(diff.summary.changed).toBe(0);
    expect(diff.summary.unchanged).toBe(0);
  });
});

describe('formatDiffPretty', () => {
  it('shows added elements with + prefix', () => {
    const before = createSnapshot([]);
    const after = createSnapshot([{ ref: 'e1', role: 'button', name: 'Submit' }]);

    const diff = diffSnapshots(before, after);
    const formatted = formatDiffPretty(diff);

    expect(formatted).toContain('+ [e1] button "Submit" (new)');
  });

  it('shows removed elements with - prefix', () => {
    const before = createSnapshot([{ ref: 'e1', role: 'dialog', name: 'Modal' }]);
    const after = createSnapshot([]);

    const diff = diffSnapshots(before, after);
    const formatted = formatDiffPretty(diff);

    expect(formatted).toContain('- [e1] dialog "Modal" (removed)');
  });

  it('shows changed elements with ~ prefix and field changes', () => {
    const before = createSnapshot([{ ref: 'e1', role: 'button', name: 'Submit', disabled: false }]);
    const after = createSnapshot([{ ref: 'e1', role: 'button', name: 'Submit', disabled: true }]);

    const diff = diffSnapshots(before, after);
    const formatted = formatDiffPretty(diff);

    expect(formatted).toContain('~');
    expect(formatted).toContain('disabled');
  });

  it('shows summary with counts', () => {
    const before = createSnapshot([{ ref: 'e1', role: 'button', name: 'Old' }]);
    const after = createSnapshot([{ ref: 'e2', role: 'link', name: 'New' }]);

    const diff = diffSnapshots(before, after);
    const formatted = formatDiffPretty(diff);

    expect(formatted).toContain('Summary:');
    expect(formatted).toContain('added');
    expect(formatted).toContain('removed');
  });

  it('shows "No changes detected" when no differences', () => {
    const before = createSnapshot([{ ref: 'e1', role: 'button', name: 'Same' }]);
    const after = createSnapshot([{ ref: 'e1', role: 'button', name: 'Same' }]);

    const diff = diffSnapshots(before, after);
    const formatted = formatDiffPretty(diff);

    expect(formatted).toContain('No changes detected');
  });
});
