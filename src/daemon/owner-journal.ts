import { closeSync, existsSync, fsyncSync, openSync, unlinkSync, writeFileSync } from 'node:fs';

/** An unfinished owner survives daemon death. Recovery is an explicit operator decision. */
export class OwnerJournal {
  readonly unfinished: boolean;
  constructor(private readonly path: string) {
    this.unfinished = existsSync(path);
  }
  claim(ownerEpoch: string, grantId: string): void {
    const fd = openSync(this.path, 'wx', 0o600);
    try {
      writeFileSync(fd, JSON.stringify({ ownerEpoch, grantId }));
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  }
  clear(): void {
    try {
      unlinkSync(this.path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
}
