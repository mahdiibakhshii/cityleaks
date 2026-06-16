import * as fs from 'fs';
import * as path from 'path';

/**
 * Crash-safe file writes: write to a unique temp file in the same directory,
 * then atomically rename it over the destination. A rename on the same
 * filesystem is atomic, so a reader (or a crash) never sees a half-written
 * file. This protects both the live persisted data and any backup/sync copy
 * (deploy/sync-data.sh) that reads these files while the server is running.
 *
 * The temp name is unique (pid + timestamp) so concurrent/overlapping saves
 * can't collide on it. The sync tooling only ever copies the named data files,
 * so a stray `*.tmp.*` left behind by a crash is harmless and ignored.
 */
function tmpName(filePath: string): string {
  return `${filePath}.tmp.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}`;
}

export async function writeFileAtomic(
  filePath: string,
  data: string | Buffer | Uint8Array
): Promise<void> {
  await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
  const tmp = tmpName(filePath);
  await fs.promises.writeFile(tmp, data);
  await fs.promises.rename(tmp, filePath);
}

export function writeFileAtomicSync(
  filePath: string,
  data: string | Buffer | Uint8Array
): void {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const tmp = tmpName(filePath);
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, filePath);
}
