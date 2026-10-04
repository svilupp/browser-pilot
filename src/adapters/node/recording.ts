import * as fs from 'node:fs';
import { join } from 'node:path';
import type { RecordingIo } from '../../actions/types.ts';

/** Node filesystem capability for optional batch recording. */
export const nodeRecordingIo: RecordingIo = {
  readFileSync: (path, encoding) => fs.readFileSync(path, encoding),
  mkdirSync: (path, options) => fs.mkdirSync(path, options),
  writeFileSync: (path, data) => fs.writeFileSync(path, data),
  renameSync: (from, to) => fs.renameSync(from, to),
  existsSync: (path) => fs.existsSync(path),
  statSync: (path) => fs.statSync(path),
  join,
  cwd: () => process.cwd(),
};
