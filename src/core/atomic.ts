/**
 * Atomic JSON files (PRD 8.1): temp file in the same directory (`.name.<pid>.tmp`), rename,
 * cleanup on failure, explicit chmod after the rename. A reader only ever sees a whole file.
 *
 * Ported from Brightspace-Bar `session-capture/src/atomic-write.mjs`. Directory creation is
 * deliberately not done here: `paths.ensureDirs()` owns the layout and its 0700 modes.
 */
import { chmodSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/** session.json, credentials.json, cache/*.json: owner read/write only. */
export const SECRET_FILE_MODE = 0o600;

export interface AtomicWriteOptions {
  /** File mode applied at creation and again after the rename; default 0600. */
  mode?: number;
}

export function writeJsonAtomic(
  file: string,
  value: unknown,
  options: AtomicWriteOptions = {},
): void {
  const mode = options.mode ?? SECRET_FILE_MODE;
  const dir = path.dirname(file);
  const temp = path.join(dir, `.${path.basename(file)}.${process.pid}.tmp`);
  try {
    writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { mode });
    renameSync(temp, file);
  } catch (err) {
    rmSync(temp, { force: true });
    throw err;
  }
  if (process.platform !== 'win32') chmodSync(file, mode);
}

/** Parsed JSON, or `undefined` when the file is missing, unreadable or not valid JSON. */
export function readJsonFile(file: string): unknown {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return undefined;
  }
}
