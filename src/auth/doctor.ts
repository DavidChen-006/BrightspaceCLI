/**
 * `bs auth doctor` (PRD 6.2, PRD 5 browser row): a read-only diagnosis of everything the ladder
 * needs before it is asked to climb. It never opens a window, never mints, never climbs a rung
 * and never creates the state directory; the one request it makes is the anonymous
 * `GET /d2l/api/versions/` (d2l-api-web A-25).
 *
 * Every probe goes through `DoctorDeps` (Node version, platform, the lazy `playwright-core`
 * import, file existence, the `cli.js` path, the installer child process), so the command's
 * tests run hermetically and nothing here ever downloads during a test. The Chromium download
 * is the only side effect the command can have and only behind `--install-browser` + a `y`.
 */

import { spawn } from 'node:child_process';
import { accessSync, constants, existsSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import type { TenantConfig } from '../core/config.js';
import { CancelledError, RetryableError } from '../core/errors.js';
import { d2lUrl, type HttpClient, readJson } from '../core/http/index.js';
import type { Sink } from '../core/output.js';
import type { BsPaths } from '../core/paths.js';
import { HINT_LOGIN, profileExists } from './ladder.js';
import {
  importPlaywright,
  type PlaywrightImporter,
  type PlaywrightModule,
} from './rungs/browser.js';
import { browserUnavailableReason } from './rungs/silent.js';
import { jwtIsFresh, readSession } from './session.js';

export const NODE_FLOOR = '22.12.0';
export const VERSIONS_PATH = '/d2l/api/versions/';
/** What `install chromium` fetches (Chromium + headless shell + ffmpeg): node-toolchain A-06. */
export const CHROMIUM_INSTALL_SIZE = '~300 MB';
export const DEFAULT_CHANNEL = 'chromium';
export const HINT_STATUS = 'Run: bs auth status';

export type CheckStatus = 'ok' | 'warn' | 'fail';

export interface DoctorCheck {
  name: string;
  /** False only for `fail`; a `warn` passes. */
  ok: boolean;
  status: CheckStatus;
  detail: string;
  hint?: string;
}

export interface DoctorReport {
  /** True when no check failed. */
  ok: boolean;
  root: string;
  baseUrl: string;
  browserChannel: string;
  checks: DoctorCheck[];
}

export interface InstallInput {
  /** Absolute path of playwright-core's `cli.js`. */
  cliPath: string;
  /** `chromium`: the only browser bs installs. */
  browser: string;
  /** The child's environment (PLAYWRIGHT_BROWSERS_PATH is honoured by playwright). */
  env: NodeJS.ProcessEnv;
  /** Where the installer's progress goes: stderr, never stdout. */
  stderr: Sink;
}

/** Runs the download; resolves with the child's exit code. */
export type Installer = (input: InstallInput) => Promise<number>;

export interface DoctorDeps {
  nodeVersion: string;
  platform: NodeJS.Platform;
  /** The lazy `import('playwright-core')`; never called by `--help`. */
  importer: PlaywrightImporter;
  /** `playwright-core`'s package version without loading the library; null when unresolvable. */
  playwrightVersion: () => string | null;
  fileExists: (file: string) => boolean;
  /** Absolute path of `playwright-core/cli.js`, or null when it cannot be found. */
  cliPath: () => string | null;
  install: Installer;
}

function ok(name: string, detail: string): DoctorCheck {
  return { name, ok: true, status: 'ok', detail };
}

function warn(name: string, detail: string, hint?: string): DoctorCheck {
  return hint === undefined
    ? { name, ok: true, status: 'warn', detail }
    : { name, ok: true, status: 'warn', detail, hint };
}

function fail(name: string, detail: string, hint?: string): DoctorCheck {
  return hint === undefined
    ? { name, ok: false, status: 'fail', detail }
    : { name, ok: false, status: 'fail', detail, hint };
}

function describe(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return message.split('\n')[0] ?? message;
}

// ---------------------------------------------------------------------------------------------
// Defaults (the real environment)
// ---------------------------------------------------------------------------------------------

const require = createRequire(import.meta.url);

/** `cli.js` is not in playwright-core's exports map; `package.json` is, and it sits beside it. */
function packageDir(): string | null {
  try {
    return path.dirname(require.resolve('playwright-core/package.json'));
  } catch {
    return null;
  }
}

export function resolvePlaywrightVersion(): string | null {
  const dir = packageDir();
  if (dir === null) return null;
  try {
    const pkg = require(path.join(dir, 'package.json')) as { version?: unknown };
    return typeof pkg.version === 'string' ? pkg.version : null;
  } catch {
    return null;
  }
}

export function resolveCliPath(): string | null {
  const dir = packageDir();
  if (dir === null) return null;
  const cli = path.join(dir, 'cli.js');
  return existsSync(cli) ? cli : null;
}

/**
 * `node <cli.js> install chromium`: the same command the hint prints, with both of the child's
 * streams forwarded to stderr so stdout stays an API. Credentials are never involved.
 */
export const spawnInstaller: Installer = ({ cliPath, browser, env, stderr }) =>
  new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath, 'install', browser], {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.on('data', (chunk: Buffer) => stderr.write(chunk.toString('utf8')));
    child.stderr.on('data', (chunk: Buffer) => stderr.write(chunk.toString('utf8')));
    child.on('error', reject);
    child.on('close', (code) => resolve(code ?? 1));
  });

export function defaultDoctorDeps(): DoctorDeps {
  return {
    nodeVersion: process.version,
    platform: process.platform,
    importer: importPlaywright,
    playwrightVersion: resolvePlaywrightVersion,
    fileExists: existsSync,
    cliPath: resolveCliPath,
    install: spawnInstaller,
  };
}

// ---------------------------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------------------------

function parseVersion(version: string): [number, number, number] | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(version.trim());
  if (m === null) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

/** True when `version` (with or without the `v`) is at or above the floor (PRD 5). */
export function nodeSatisfies(version: string, floor: string = NODE_FLOOR): boolean {
  const have = parseVersion(version);
  const need = parseVersion(floor);
  if (have === null || need === null) return false;
  for (let i = 0; i < 3; i += 1) {
    const a = have[i] ?? 0;
    const b = need[i] ?? 0;
    if (a !== b) return a > b;
  }
  return true;
}

type ChannelTable = Partial<Record<'linux' | 'darwin' | 'win32', string>>;

/** playwright-core 1.62's chromium channel table (`_createChromiumChannel` in coreBundle.js). */
const CHANNELS: Readonly<Record<string, ChannelTable>> = Object.freeze({
  chrome: {
    linux: '/opt/google/chrome/chrome',
    darwin: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    win32: '\\Google\\Chrome\\Application\\chrome.exe',
  },
  'chrome-beta': {
    linux: '/opt/google/chrome-beta/chrome',
    darwin: '/Applications/Google Chrome Beta.app/Contents/MacOS/Google Chrome Beta',
    win32: '\\Google\\Chrome Beta\\Application\\chrome.exe',
  },
  'chrome-dev': {
    linux: '/opt/google/chrome-unstable/chrome',
    darwin: '/Applications/Google Chrome Dev.app/Contents/MacOS/Google Chrome Dev',
    win32: '\\Google\\Chrome Dev\\Application\\chrome.exe',
  },
  'chrome-canary': {
    darwin: '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
    win32: '\\Google\\Chrome SxS\\Application\\chrome.exe',
  },
  msedge: {
    linux: '/opt/microsoft/msedge/msedge',
    darwin: '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    win32: '\\Microsoft\\Edge\\Application\\msedge.exe',
  },
  'msedge-beta': {
    linux: '/opt/microsoft/msedge-beta/msedge',
    darwin: '/Applications/Microsoft Edge Beta.app/Contents/MacOS/Microsoft Edge Beta',
    win32: '\\Microsoft\\Edge Beta\\Application\\msedge.exe',
  },
  'msedge-dev': {
    linux: '/opt/microsoft/msedge-dev/msedge',
    darwin: '/Applications/Microsoft Edge Dev.app/Contents/MacOS/Microsoft Edge Dev',
    win32: '\\Microsoft\\Edge Dev\\Application\\msedge.exe',
  },
  'msedge-canary': {
    darwin: '/Applications/Microsoft Edge Canary.app/Contents/MacOS/Microsoft Edge Canary',
    win32: '\\Microsoft\\Edge SxS\\Application\\msedge.exe',
  },
});

/**
 * Where playwright looks for a branded channel on `platform`: the candidate paths in the
 * order playwright tries them, `[]` when the channel does not exist on that platform, and
 * `null` when `channel` is not one bs can verify (the `chromium` default is resolved through
 * `chromium.executablePath()` instead).
 */
export function channelExecutables(
  channel: string,
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
): string[] | null {
  const table = CHANNELS[channel];
  if (table === undefined) return null;
  const suffix = table[platform as keyof ChannelTable];
  if (suffix === undefined) return [];
  if (platform !== 'win32') return [suffix];
  const prefixes = [
    env.LOCALAPPDATA,
    env.PROGRAMFILES,
    env['PROGRAMFILES(X86)'],
    env.HOMEDRIVE === undefined ? undefined : `${env.HOMEDRIVE}\\Program Files`,
    env.HOMEDRIVE === undefined ? undefined : `${env.HOMEDRIVE}\\Program Files (x86)`,
  ].filter((p): p is string => typeof p === 'string' && p !== '');
  return prefixes.map((prefix) => `${prefix}${suffix}`);
}

/** The copy-pasteable download command; the hint states the cost and the no-download route. */
export function installCommand(cliPath: string | null): string {
  return cliPath === null
    ? 'npx playwright-core install chromium'
    : `node ${cliPath} install chromium`;
}

export function installHint(cliPath: string | null): string {
  return `Run: ${installCommand(cliPath)}  (downloads ${CHROMIUM_INSTALL_SIZE} into playwright's browser cache; or: bs auth doctor --install-browser), or set BS_BROWSER_CHANNEL=chrome to use an installed Google Chrome with no download`;
}

// ---------------------------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------------------------

export function checkNode(deps: Pick<DoctorDeps, 'nodeVersion'>): DoctorCheck {
  const version = deps.nodeVersion;
  return nodeSatisfies(version)
    ? ok('node', `${version} (>= ${NODE_FLOOR})`)
    : fail(
        'node',
        `${version} is below the ${NODE_FLOOR} floor`,
        `Install Node ${NODE_FLOOR} or newer (https://nodejs.org) and re-run: bs auth doctor`,
      );
}

function modeOf(file: string): number | null {
  try {
    return statSync(file).mode & 0o777;
  } catch {
    return null;
  }
}

function octal(mode: number): string {
  return `0${mode.toString(8).padStart(3, '0')}`;
}

function nearestExistingAncestor(dir: string): string {
  let current = dir;
  for (;;) {
    if (existsSync(current)) return current;
    const parent = path.dirname(current);
    if (parent === current) return current;
    current = parent;
  }
}

function writable(dir: string): boolean {
  try {
    accessSync(dir, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

/** The state root: path, origin, whether it exists and whether bs could write there. */
export function checkRoot(paths: BsPaths): DoctorCheck {
  const origin =
    paths.source === 'flag' ? '--root' : paths.source === 'env' ? 'BS_ROOT' : 'platform default';
  const where = `${paths.root} (${origin})`;
  if (!existsSync(paths.root)) {
    const ancestor = nearestExistingAncestor(paths.root);
    return writable(ancestor)
      ? ok('root', `not created yet: ${where}; the first login creates it with mode 0700`)
      : fail(
          'root',
          `not created yet: ${where}, and ${ancestor} is not writable`,
          `Make ${ancestor} writable or point --root / BS_ROOT somewhere else`,
        );
  }
  let isDir = false;
  try {
    isDir = statSync(paths.root).isDirectory();
  } catch {
    isDir = false;
  }
  if (!isDir) {
    return fail(
      'root',
      `${where} exists but is not a directory`,
      'Move it aside or change --root / BS_ROOT',
    );
  }
  if (!writable(paths.root)) {
    return fail('root', `${where} is not writable`, `Run: chmod 700 ${paths.root}`);
  }
  return ok('root', where);
}

/**
 * Modes of what exists (PRD 8.1): 0700 directories, 0600 secret files. config.json holds no
 * secret, so a loose mode there is a warning. Nothing is created and nothing is changed.
 */
export function checkPermissions(paths: BsPaths, platform: NodeJS.Platform): DoctorCheck {
  if (platform === 'win32') return ok('permissions', 'not checked on Windows (ACLs)');
  if (!existsSync(paths.root)) return ok('permissions', 'nothing to check yet');
  const looseDirs: string[] = [];
  const looseSecrets: string[] = [];
  const looseConfig: string[] = [];
  const offenders: string[] = [];
  for (const dir of [paths.root, paths.profileDir, paths.cacheDir]) {
    const mode = modeOf(dir);
    if (mode !== null && (mode & 0o077) !== 0) {
      looseDirs.push(dir);
      offenders.push(`${dir} is ${octal(mode)}`);
    }
  }
  for (const file of [paths.sessionFile, paths.credentialsFile, paths.mfaFile, paths.statusFile]) {
    const mode = modeOf(file);
    if (mode !== null && (mode & 0o077) !== 0) {
      looseSecrets.push(file);
      offenders.push(`${file} is ${octal(mode)}`);
    }
  }
  const configMode = modeOf(paths.configFile);
  if (configMode !== null && (configMode & 0o077) !== 0) {
    looseConfig.push(paths.configFile);
    offenders.push(`${paths.configFile} is ${octal(configMode)}`);
  }
  if (offenders.length === 0) return ok('permissions', 'directories 0700, files 0600');
  const hints: string[] = [];
  if (looseSecrets.length > 0 || looseConfig.length > 0) {
    hints.push(`chmod 600 ${[...looseSecrets, ...looseConfig].join(' ')}`);
  }
  if (looseDirs.length > 0) hints.push(`chmod 700 ${looseDirs.join(' ')}`);
  const hint = `Run: ${hints.join('  &&  ')}`;
  const detail = `readable by others: ${offenders.join('; ')}`;
  return looseDirs.length > 0 || looseSecrets.length > 0
    ? fail('permissions', detail, hint)
    : warn('permissions', detail, hint);
}

/** `session.json` by its cached facts only: no mint, no rung (that is `bs auth status`). */
export function checkSession(paths: BsPaths, now: number): DoctorCheck {
  const session = readSession(paths);
  if (session === null) {
    return warn('session', `none at ${paths.sessionFile}`, HINT_LOGIN);
  }
  const captured = `captured ${session.capturedAt} for ${session.baseUrl}`;
  if (jwtIsFresh(session, now)) {
    return ok('session', `fresh: JWT cached until ${session.jwtExpiresAt} (${captured})`);
  }
  const until =
    session.jwtExpiresAt === undefined
      ? 'no cached JWT'
      : `cached JWT expired at ${session.jwtExpiresAt}`;
  return warn(
    'session',
    `expired: ${until} (${captured}); a mint decides whether the cookies still work`,
    HINT_STATUS,
  );
}

/** `profile/` holds the ~90-day Entra sign-in the silent rung re-uses; empty is no profile. */
export function checkProfile(paths: BsPaths): DoctorCheck {
  if (profileExists(paths)) return ok('profile', paths.profileDir);
  if (existsSync(paths.profileDir)) {
    return warn(
      'profile',
      `${paths.profileDir} is empty; the silent rung has nothing to re-use`,
      HINT_LOGIN,
    );
  }
  return warn('profile', `none at ${paths.profileDir}; the first login creates it`, HINT_LOGIN);
}

export type PlaywrightLoad =
  | { module: PlaywrightModule; version: string | null }
  | { module: null; reason: string };

/** The lazy import, once; a failure is a reason, never a throw (cancellation excepted). */
export async function loadPlaywright(
  deps: Pick<DoctorDeps, 'importer' | 'playwrightVersion'>,
): Promise<PlaywrightLoad> {
  try {
    const module = await deps.importer();
    return { module, version: deps.playwrightVersion() };
  } catch (err) {
    if (err instanceof CancelledError) throw err;
    return { module: null, reason: browserUnavailableReason(err) ?? describe(err) };
  }
}

export function checkPlaywright(load: PlaywrightLoad): DoctorCheck {
  if (load.module === null) {
    return fail(
      'playwright',
      load.reason,
      'Reinstall bs so its playwright-core dependency is present: npm install -g brightspace-cli  (or npm install in a checkout)',
    );
  }
  return ok('playwright', `playwright-core ${load.version ?? '(version unknown)'} importable`);
}

export interface BrowserCheckInput {
  config: Pick<TenantConfig, 'browserChannel'>;
  env: NodeJS.ProcessEnv;
  load: PlaywrightLoad;
  deps: Pick<DoctorDeps, 'platform' | 'fileExists' | 'cliPath'>;
}

/**
 * The executable the configured channel would launch (PRD 5 browser row). `chromium` (the
 * default) is playwright's own download at `chromium.executablePath()`; a branded channel is
 * looked up where playwright looks. Never launches anything.
 */
export function checkBrowser(input: BrowserCheckInput): DoctorCheck {
  const { config, env, load, deps } = input;
  const channel = config.browserChannel === '' ? DEFAULT_CHANNEL : config.browserChannel;
  if (load.module === null) {
    return fail('browser', `not checked: ${load.reason}`, installHint(deps.cliPath()));
  }
  if (channel === DEFAULT_CHANNEL) {
    const executablePath = load.module.chromium.executablePath;
    if (typeof executablePath !== 'function') {
      return warn(
        'browser',
        'playwright-core exposes no chromium.executablePath(); the launch will tell',
        installHint(deps.cliPath()),
      );
    }
    let exe: string;
    try {
      exe = executablePath.call(load.module.chromium);
    } catch (err) {
      return fail(
        'browser',
        `chromium.executablePath() failed: ${describe(err)}`,
        installHint(deps.cliPath()),
      );
    }
    return deps.fileExists(exe)
      ? ok('browser', `chromium: ${exe}`)
      : fail('browser', `no Chromium at ${exe} (channel "chromium")`, installHint(deps.cliPath()));
  }
  const candidates = channelExecutables(channel, deps.platform, env);
  if (candidates === null) {
    return warn(
      'browser',
      `channel "${channel}" is not one bs can verify; playwright resolves it at launch`,
      `Use BS_BROWSER_CHANNEL=chromium (playwright's download) or chrome / msedge (installed browsers)`,
    );
  }
  const found = candidates.find((file) => deps.fileExists(file));
  if (found !== undefined) return ok('browser', `${channel}: ${found}`);
  const brand = channel.startsWith('msedge') ? 'Microsoft Edge' : 'Google Chrome';
  const looked =
    candidates.length === 0
      ? `channel "${channel}" is not available on ${deps.platform}`
      : `no ${brand} at ${candidates.join(' or ')} (channel "${channel}")`;
  return fail(
    'browser',
    looked,
    `Install ${brand}, or unset BS_BROWSER_CHANNEL and run: ${installCommand(deps.cliPath())}  (${CHROMIUM_INSTALL_SIZE})`,
  );
}

interface VersionEntry {
  ProductCode: string;
  LatestVersion: string;
  SupportedVersions: string[];
}

function isVersionEntry(value: unknown): value is VersionEntry {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.ProductCode === 'string' &&
    typeof v.LatestVersion === 'string' &&
    Array.isArray(v.SupportedVersions)
  );
}

function checkProduct(
  name: 'lp' | 'le',
  configured: string,
  envName: string,
  entries: readonly VersionEntry[],
): DoctorCheck {
  const entry = entries.find((e) => e.ProductCode.toLowerCase() === name);
  if (entry === undefined) {
    return fail(
      name,
      `the tenant does not advertise product "${name}" (configured ${configured})`,
      'Check --base-url / BS_BASE_URL points at a Brightspace tenant',
    );
  }
  const supported = entry.SupportedVersions.map(String);
  const latest = entry.LatestVersion;
  const setHint = `Set ${envName}=${latest} (or "${name}Version" in config.json)`;
  if (configured === latest) return ok(name, `${configured} (latest)`);
  if (supported.includes(configured)) {
    return warn(
      name,
      `${configured} is supported; latest is ${latest}`,
      `${setHint} to use the latest`,
    );
  }
  return fail(
    name,
    `${configured} is not supported (supported: ${supported.join(', ')}; latest ${latest})`,
    setHint,
  );
}

export interface VersionsCheckInput {
  http: HttpClient;
  config: Pick<TenantConfig, 'baseUrl' | 'lpVersion' | 'leVersion'>;
  log: (line: string) => void;
}

export interface VersionsResult {
  checks: DoctorCheck[];
  /** True when the tenant could not be reached at all (network, timeout, 5xx): worth a retry. */
  transportFailure: boolean;
}

/** The anonymous versions probe: reachability, then LP/LE support (PRD 6.2, 8.3). */
export async function checkVersions(input: VersionsCheckInput): Promise<VersionsResult> {
  const { http, config } = input;
  const notChecked = (name: 'lp' | 'le', configured: string) =>
    warn(name, `${configured}: not checked (tenant unreachable)`);
  const skipped = [notChecked('lp', config.lpVersion), notChecked('le', config.leVersion)];
  let entries: VersionEntry[];
  try {
    const response = await http.request({
      method: 'GET',
      url: d2lUrl(config.baseUrl, VERSIONS_PATH),
    });
    const body = readJson<unknown>(response);
    if (!Array.isArray(body)) throw new Error('the versions route did not answer with an array');
    entries = body.filter(isVersionEntry);
  } catch (err) {
    if (err instanceof CancelledError) throw err;
    const reason = describe(err);
    input.log(`doctor: versions probe failed: ${reason}`);
    const transportFailure = err instanceof RetryableError;
    const hint = transportFailure
      ? 'Check the network and --base-url / BS_BASE_URL, then retry: bs auth doctor'
      : 'Check --base-url / BS_BASE_URL points at a Brightspace tenant (the anonymous GET /d2l/api/versions/ should answer JSON)';
    return {
      checks: [fail('tenant', `${config.baseUrl}: ${reason}`, hint), ...skipped],
      transportFailure,
    };
  }
  const codes = entries.map((e) => e.ProductCode).join(', ');
  return {
    checks: [
      ok('tenant', `${config.baseUrl}: ${entries.length} products (${codes})`),
      checkProduct('lp', config.lpVersion, 'BS_LP_VERSION', entries),
      checkProduct('le', config.leVersion, 'BS_LE_VERSION', entries),
    ],
    transportFailure: false,
  };
}

// ---------------------------------------------------------------------------------------------
// The whole diagnosis
// ---------------------------------------------------------------------------------------------

export interface DoctorInput {
  paths: BsPaths;
  config: TenantConfig;
  http: HttpClient;
  env: NodeJS.ProcessEnv;
  /** Verbose diagnostics; never a secret. */
  log: (line: string) => void;
  /** Milliseconds since the epoch; defaults to Date.now. */
  now?: () => number;
}

export interface DoctorRun {
  report: DoctorReport;
  /** The playwright load the browser check used, so `--install-browser` can re-check. */
  load: PlaywrightLoad;
  /** True when the versions probe failed at the transport level (network, timeout, 5xx). */
  tenantUnreachable: boolean;
}

export function reportOf(
  input: Pick<DoctorInput, 'paths' | 'config'>,
  checks: readonly DoctorCheck[],
): DoctorReport {
  return {
    ok: checks.every((c) => c.ok),
    root: input.paths.root,
    baseUrl: input.config.baseUrl,
    browserChannel:
      input.config.browserChannel === '' ? DEFAULT_CHANNEL : input.config.browserChannel,
    checks: [...checks],
  };
}

/** Every check, in report order. Read-only: no directory, no file, no window, no mint. */
export async function runDoctor(input: DoctorInput, deps: DoctorDeps): Promise<DoctorRun> {
  const now = (input.now ?? Date.now)();
  const load = await loadPlaywright(deps);
  const versions = await checkVersions({ http: input.http, config: input.config, log: input.log });
  const checks: DoctorCheck[] = [
    checkNode(deps),
    checkRoot(input.paths),
    checkPermissions(input.paths, deps.platform),
    checkSession(input.paths, now),
    checkProfile(input.paths),
    checkPlaywright(load),
    checkBrowser({ config: input.config, env: input.env, load, deps }),
    ...versions.checks,
  ];
  return { report: reportOf(input, checks), load, tenantUnreachable: versions.transportFailure };
}
