/**
 * Version from package.json; commit/date from dist/buildinfo.json, which `npm run build`
 * generates (scripts/buildinfo.mjs) next to this module. In dev (tsx from src/) the file is
 * absent and both fall back to "unknown". Never throws, even when git is missing.
 */
import { readFileSync } from 'node:fs';

export interface BuildInfo {
  version: string;
  commit: string;
  date: string;
}

let cached: BuildInfo | undefined;

function readJson(url: URL): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(readFileSync(url, 'utf8'));
    return typeof parsed === 'object' && parsed !== null
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

function str(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.length > 0 ? value : fallback;
}

export function getBuildInfo(): BuildInfo {
  if (!cached) {
    // Both src/buildinfo.ts and dist/buildinfo.js sit one level below the package root.
    const pkg = readJson(new URL('../package.json', import.meta.url));
    const generated = readJson(new URL('./buildinfo.json', import.meta.url));
    cached = {
      version: str(pkg?.version, '0.0.0'),
      commit: str(generated?.commit, 'unknown'),
      date: str(generated?.date, 'unknown'),
    };
  }
  return cached;
}

/** "<version> (<commit> <date>)": feeds `schema.build` and human `bs version`. */
export function buildString(): string {
  const { version, commit, date } = getBuildInfo();
  return `${version} (${commit} ${date})`;
}
