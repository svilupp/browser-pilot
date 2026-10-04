// Node-only self-contained directory export. Canonical v2 readers remain usable.
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import type { RecordingManifest } from './manifest.ts';

export function resolveRecordingImage(
  _artifact: RecordingManifest,
  artifactPath: string,
  file: string
): string {
  if (!file || isAbsolute(file) || file.split(/[\\/]/).includes('..'))
    throw new Error('Recording image reference must be a relative path without traversal');
  const root = fs.realpathSync(dirname(resolve(artifactPath)));
  const image = fs.realpathSync(join(root, file));
  const rel = relative(root, image);
  if (rel.startsWith('..') || isAbsolute(rel))
    throw new Error('Recording image reference escapes artifact directory');
  if (!fs.statSync(image).isFile() || fs.statSync(image).size > 8 * 1024 * 1024)
    throw new Error('Recording image must be a regular file <=8 MiB');
  return image;
}
export function exportRecordingBundle(
  artifact: RecordingManifest,
  source: string,
  destination: string
): { manifest: string; images: number; hashes: Record<string, string> } {
  const root = resolve(destination);
  if (fs.existsSync(root))
    throw new Error('Bundle output directory already exists; choose a fresh path');
  // Validate every input first, so missing files cannot be advertised as complete.
  const inputs = artifact.screenshots
    .filter((s) => s.file)
    .map((s) => ({ s, path: resolveRecordingImage(artifact, source, s.file) }));
  const copy = structuredClone(artifact);
  copy.artifacts.recordingManifest = 'recording.json';
  copy.artifacts.screenshotDir = 'screenshots/';
  fs.mkdirSync(join(root, 'screenshots'), { recursive: true, mode: 0o700 });
  const hashes: Record<string, string> = {};
  for (const [index, { s, path }] of inputs.entries()) {
    const file = `screenshots/${String(index + 1).padStart(6, '0')}.${path.split('.').pop()}`;
    const bytes = fs.readFileSync(path);
    fs.writeFileSync(join(root, file), bytes, { mode: 0o600 });
    hashes[file] = createHash('sha256').update(bytes).digest('hex');
    const shot = copy.screenshots.find((item) => item.id === s.id);
    if (shot) shot.file = file;
  }
  fs.writeFileSync(join(root, 'recording.json'), JSON.stringify(copy, null, 2), { mode: 0o600 });
  fs.writeFileSync(
    join(root, 'bundle.json'),
    JSON.stringify({ version: 1, manifest: 'recording.json', sha256: hashes }, null, 2),
    { mode: 0o600 }
  );
  return { manifest: join(root, 'recording.json'), images: inputs.length, hashes };
}
