import { expect, test } from 'bun:test';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseRecordArgs } from '../../src/cli/commands/record.ts';
import { exportRecordingBundle } from '../../src/recording/bundle.ts';
import { createRecordingManifest } from '../../src/recording/manifest.ts';
import { recordingReadiness } from '../../src/recording/readiness.ts';

test('record capture validates policies and resource bounds', () => {
  expect(
    parseRecordArgs([
      '--segment',
      'new',
      '--screenshots',
      'markers',
      '--privacy',
      'standard',
      '--observe',
      '--max-mb',
      '2',
      '--drain-timeout',
      '20',
    ])
  ).toMatchObject({
    segment: 'new',
    screenshots: 'markers',
    privacy: 'standard',
    observe: true,
    maxMb: 2,
    drainTimeout: 20,
  });
  for (const args of [
    ['--max-mb', '0'],
    ['--timeout', 'bad'],
    ['--drain-timeout', '-1'],
    ['--screenshots', 'fullpage'],
    ['--privacy', 'none'],
    ['--segment', 'replace'],
  ])
    expect(() => parseRecordArgs(args)).toThrow();
});

test('portable bundles copy images, fence paths and fail before advertising missing screenshots', () => {
  const root = fs.mkdtempSync(join(tmpdir(), 'bp-bundle-'));
  try {
    const source = join(root, 'recording.json');
    const artifact = createRecordingManifest({
      recordedAt: new Date().toISOString(),
      sessionId: 'fixture',
      startUrl: 'https://example.com',
      endUrl: 'https://example.com',
      steps: [
        { action: 'fill', selector: '#secret', value: '[REDACTED]' },
        { action: 'click', selector: '#buy' },
      ],
      frames: [
        {
          seq: 1,
          timestamp: 1,
          action: 'click',
          success: true,
          durationMs: 1,
          screenshot: 'shot.png',
        },
      ],
      traceEvents: [],
      notes: [],
    });
    fs.writeFileSync(source, JSON.stringify(artifact));
    fs.writeFileSync(
      join(root, 'shot.png'),
      Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aZxkAAAAASUVORK5CYII=',
        'base64'
      )
    );
    const bundle = exportRecordingBundle(artifact, source, join(root, 'bundle'));
    expect(bundle.images).toBe(1);
    const moved = join(root, 'moved');
    fs.renameSync(join(root, 'bundle'), moved);
    fs.unlinkSync(join(root, 'shot.png'));
    const copy = JSON.parse(fs.readFileSync(join(moved, 'recording.json'), 'utf8'));
    expect(fs.existsSync(join(moved, copy.screenshots[0].file))).toBe(true);
    expect(Object.values(bundle.hashes)[0]).toHaveLength(64);
    expect(() => exportRecordingBundle(artifact, source, join(root, 'missing'))).toThrow();
    expect(fs.existsSync(join(root, 'missing'))).toBe(false);
    for (const path of ['../outside.png', '/tmp/outside.png']) {
      artifact.screenshots[0]!.file = path;
      expect(() => exportRecordingBundle(artifact, source, join(root, 'escape'))).toThrow();
    }
    fs.symlinkSync(join(moved, 'screenshots'), join(root, 'linked'));
    artifact.screenshots[0]!.file = `linked/${fs.readdirSync(join(moved, 'screenshots'))[0]}`;
    // Inside-directory symlinks are supported; escaping ones are rejected.
    fs.symlinkSync('/etc/passwd', join(root, 'escaped.png'));
    artifact.screenshots[0]!.file = 'escaped.png';
    expect(() => exportRecordingBundle(artifact, source, join(root, 'escape'))).toThrow();
    const readiness = recordingReadiness(copy);
    expect(readiness.safeToReplay).toBe(false);
    expect(readiness.redactedInputs).toHaveLength(1);
    expect(readiness.hazardousActions).toHaveLength(1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
