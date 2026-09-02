/**
 * The live E2E harness (PRD 12 "Live", bs-bo2).
 *
 * Everything under `test/live/` talks to the real tenant, so it is kept out of `npm test`'s glob
 * (`test/!(live)/**` in package.json) and behind `BS_LIVE`. This module is the only place that
 * decides how a live test starts, how it drives the CLI, and how it reads what came back; the
 * suites are then just assertions. It is itself hermetic — nothing here opens a socket at import
 * time — which is what lets `test/live-harness/*.test.ts` unit-test it inside `npm test`.
 *
 * Two rules shape the design:
 *
 * - **Drive the built binary, not the module.** `runBs()` spawns `node dist/bin/bs.js`, so a live
 *   run exercises the real entry point, the real exit codes and the real stdout/stderr split. An
 *   in-process `run()` would prove the library works and say nothing about the shipped CLI.
 * - **Fail fast and say why.** A missing build, a missing `BS_ROOT` or a `BS_ROOT` with no
 *   `session.json` are operator mistakes, not test failures to debug: they throw immediately with
 *   the command that fixes them.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = path.resolve(fileURLToPath(new URL('../../', import.meta.url)));
export const BS_BIN = path.join(REPO_ROOT, 'dist', 'bin', 'bs.js');

/** Values of `BS_LIVE` that mean "off" even though the variable is present. */
const OFF = new Set(['', '0', 'false', 'no', 'off']);

export interface LiveGate {
  enabled: boolean;
  /** Always populated: it is the `skip` message when disabled and a note when enabled. */
  reason: string;
}

/**
 * The gate every live file consults at module scope. Absent (or explicitly off) means the file
 * registers one skipped test and touches nothing — `npm test` must stay hermetic even if the
 * glob is ever widened by accident.
 */
export function liveGate(env: NodeJS.ProcessEnv = process.env): LiveGate {
  const value = env.BS_LIVE;
  if (value === undefined || OFF.has(value.trim().toLowerCase())) {
    return {
      enabled: false,
      reason: 'BS_LIVE is not set — the live suite needs a tenant (run: npm run test:live)',
    };
  }
  return { enabled: true, reason: `BS_LIVE=${value}` };
}

export const HINT_ROOT =
  'Point BS_ROOT at a state directory that already holds a session, e.g.\n' +
  '  BS_ROOT="$HOME/Library/Application Support/bs" npm run test:live';

/**
 * Resolves the root the live suite runs against, or throws with the fix. Checked here rather than
 * per test so a misconfigured run costs one clear error instead of thirty confusing ones.
 */
export function requireLiveRoot(env: NodeJS.ProcessEnv = process.env): string {
  const root = env.BS_ROOT?.trim();
  if (!root) {
    throw new Error(`BS_ROOT is required for the live suite but is not set.\n${HINT_ROOT}`);
  }
  const session = path.join(root, 'session.json');
  if (!existsSync(session)) {
    throw new Error(
      `BS_ROOT has no session.json, so there is nothing to run tier 0 against.\n` +
        `  looked for: ${session}\n` +
        `  fix:        bs auth login --root ${JSON.stringify(root)}   (tier 2, one MFA tap)`,
    );
  }
  return path.resolve(root);
}

/** Throws unless `npm run build` has produced the binary the suite drives. */
export function requireBuild(bin: string = BS_BIN): string {
  if (!existsSync(bin)) {
    throw new Error(`the built CLI is missing at ${bin}.\n  fix: npm run build`);
  }
  return bin;
}

export interface CliRun {
  argv: readonly string[];
  code: number;
  stdout: string;
  stderr: string;
  /** Milliseconds from spawn to exit; handy in `t.diagnostic()` lines. */
  ms: number;
}

export interface RunOptions {
  root?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}

/** Generous by default: a cold fan-out (`bs upcoming`) walks every active course. */
export const DEFAULT_RUN_TIMEOUT_MS = 120_000;

/**
 * One `bs` invocation as a child process. `BS_NO_INPUT=1` is forced so nothing can ever block on a
 * prompt, and stdin is closed for the same reason. The child inherits `process.env` so the
 * operator's `BS_BASE_URL` / `BS_LP_VERSION` / `BS_BROWSER_CHANNEL` still apply.
 */
export function runBs(args: readonly string[], options: RunOptions = {}): Promise<CliRun> {
  const bin = requireBuild();
  const argv = [...args];
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    BS_NO_INPUT: '1',
    ...(options.root ? { BS_ROOT: options.root } : {}),
    ...options.env,
  };
  const started = Date.now();
  return new Promise<CliRun>((resolve, reject) => {
    const child = spawn(process.execPath, [bin, ...argv], {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, options.timeoutMs ?? DEFAULT_RUN_TIMEOUT_MS);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (c: string) => {
      stdout += c;
    });
    child.stderr.on('data', (c: string) => {
      stderr += c;
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      if (timedOut) {
        reject(new Error(`bs ${argv.join(' ')} did not finish within its timeout (SIGKILLed)`));
        return;
      }
      resolve({
        argv,
        code: code ?? (signal ? 128 : 1),
        stdout,
        stderr,
        ms: Date.now() - started,
      });
    });
  });
}

/** A one-line description of a run, for assertion messages and `t.diagnostic()`. */
export function describeRun(run: CliRun): string {
  const tail = run.stderr.trim().split('\n').filter(Boolean).at(-1) ?? '';
  return `bs ${run.argv.join(' ')} -> exit ${run.code}${tail ? ` | ${tail}` : ''}`;
}

/** Parses `--json` stdout, blaming the command (and its stderr) when the payload is not JSON. */
export function parseJsonStdout<T = unknown>(run: CliRun): T {
  try {
    return JSON.parse(run.stdout) as T;
  } catch (err) {
    const preview = run.stdout.slice(0, 200).replace(/\n/g, '\\n');
    throw new Error(
      `${describeRun(run)}: stdout was not JSON (${(err as Error).message})\n  stdout: ${preview}`,
    );
  }
}

export interface ListEnvelope<T = Record<string, unknown>> {
  items: T[];
  count: number;
  fetchedAt: string;
}

/** Asserts the PRD 6.3 list envelope shape and hands back the items. */
export function itemsOf<T = Record<string, unknown>>(run: CliRun): T[] {
  const envelope = parseJsonStdout<ListEnvelope<T>>(run);
  if (!Array.isArray(envelope.items) || typeof envelope.count !== 'number') {
    throw new Error(`${describeRun(run)}: expected {items, count, fetchedAt}`);
  }
  return envelope.items;
}

export interface LiveCourse {
  id: number;
  name: string;
  isActive: boolean | null;
  canAccess: boolean | null;
  url: string;
  [key: string]: unknown;
}

/**
 * The course every per-course check runs against: the first that is both active and accessible.
 * On this tenant 25 of 27 enrollments are past-term (`canAccess: false`) and answer 403 on every
 * per-course route — picking one of those would turn a healthy tenant into a red suite.
 */
export function chooseCourse(courses: readonly LiveCourse[]): LiveCourse | null {
  return courses.find((c) => c.isActive === true && c.canAccess === true) ?? null;
}

/** HTTP statuses this suite treats as "the row exists" for a deep link (anything but 404). */
export function isDeepLinkAlive(status: number): boolean {
  return status !== 404;
}
