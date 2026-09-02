/**
 * The single place where the on-disk layout is decided (PRD 8.1).
 *
 * Resolution is pure: resolvePaths() never touches the filesystem, so --help, version and
 * schema stay side-effect free. Writers call ensureDirs() first.
 */
import { chmodSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import envPaths from 'env-paths';

export const APP_DIR_NAME = 'bs';

export type RootSource = 'flag' | 'env' | 'default';

export interface PathsInput {
  /** --root flag value. */
  root?: string | null;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  /** Test injection only; when omitted the real platform is used via env-paths. */
  platform?: NodeJS.Platform;
  /** Test injection only. */
  homedir?: string;
}

export interface BsPaths {
  root: string;
  source: RootSource;
  /** Chromium persistent profile (0700). */
  profileDir: string;
  /** {capturedAt, baseUrl, cookies, cookieHeader, csrfToken, landedUrl, jwt, jwtExpiresAt} (0600). */
  sessionFile: string;
  /** {email, password}, only with --save-credentials (0600). */
  credentialsFile: string;
  /** Optional tenant overrides, PRD 8.3 (0600). */
  configFile: string;
  cacheDir: string;
  /** Ephemeral {number, mintedAt} during a full login (0600). */
  mfaFile: string;
  /** Last ladder outcome (0600). */
  statusFile: string;
}

/**
 * Mirrors env-paths 4's `data` directory for an injected platform/homedir/env. env-paths
 * snapshots os.homedir() and process.env at import time, so it cannot be injected; a test
 * pins this mirror to env-paths for the running platform.
 */
export function platformDataDir(
  platform: NodeJS.Platform,
  homedir: string,
  env: NodeJS.ProcessEnv,
  name: string = APP_DIR_NAME,
): string {
  if (platform === 'darwin') {
    return path.join(homedir, 'Library', 'Application Support', name);
  }
  if (platform === 'win32') {
    const localAppData = env.LOCALAPPDATA || path.join(homedir, 'AppData', 'Local');
    return path.join(localAppData, name, 'Data');
  }
  return path.join(env.XDG_DATA_HOME || path.join(homedir, '.local', 'share'), name);
}

function defaultRoot(input: PathsInput): string {
  const injected = input.platform !== undefined || input.homedir !== undefined;
  if (!injected) {
    return envPaths(APP_DIR_NAME, { suffix: '' }).data;
  }
  return platformDataDir(
    input.platform ?? process.platform,
    input.homedir ?? os.homedir(),
    input.env ?? process.env,
  );
}

export function resolveRoot(input: PathsInput = {}): { root: string; source: RootSource } {
  const env = input.env ?? process.env;
  const cwd = input.cwd ?? process.cwd();
  const flag = input.root?.trim();
  if (flag) return { root: path.resolve(cwd, flag), source: 'flag' };
  const fromEnv = env.BS_ROOT?.trim();
  if (fromEnv) return { root: path.resolve(cwd, fromEnv), source: 'env' };
  return { root: defaultRoot(input), source: 'default' };
}

export function resolvePaths(input: PathsInput = {}): BsPaths {
  const { root, source } = resolveRoot(input);
  const cacheDir = path.join(root, 'cache');
  return {
    root,
    source,
    profileDir: path.join(root, 'profile'),
    sessionFile: path.join(root, 'session.json'),
    credentialsFile: path.join(root, 'credentials.json'),
    configFile: path.join(root, 'config.json'),
    cacheDir,
    mfaFile: path.join(cacheDir, 'mfa.json'),
    statusFile: path.join(cacheDir, 'status.json'),
  };
}

const DIR_MODE = 0o700;

/**
 * Creates root, profile/ and cache/ with mode 0700. Idempotent. Never called by --help,
 * version or schema; only by commands that persist state.
 */
export function ensureDirs(paths: BsPaths): void {
  for (const dir of [paths.root, paths.profileDir, paths.cacheDir]) {
    mkdirSync(dir, { recursive: true, mode: DIR_MODE });
    if (process.platform !== 'win32') {
      chmodSync(dir, DIR_MODE);
    }
  }
}
