import { mkdirSync, openSync, closeSync } from 'node:fs';
import { join } from 'node:path';

/**
 * True the first time `kind` is asked for in a session (a marker file under .yandecode/hints),
 * so a hint is shown once without every hook process opening a database.
 */
export function firstTimeInSession(yandecodeDir: string, sessionId: string, kind: string): boolean {
  const dir = join(yandecodeDir, 'hints');
  mkdirSync(dir, { recursive: true });
  const safe = `${sessionId}.${kind}`.replace(/[^\w.-]/g, '_');
  try {
    closeSync(openSync(join(dir, safe), 'wx'));
    return true;
  } catch {
    return false;
  }
}
