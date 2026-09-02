import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { test } from 'node:test';
import {
  CHROMIUM_INSTALL_SIZE,
  channelExecutables,
  type DoctorCheck,
  type DoctorDeps,
  type DoctorReport,
  type InstallInput,
  NODE_FLOOR,
  nodeSatisfies,
  VERSIONS_PATH,
} from '../../src/auth/doctor.js';
import { HINT_LOGIN } from '../../src/auth/ladder.js';
import type { PlaywrightModule } from '../../src/auth/rungs/browser.js';
import { writeSession } from '../../src/auth/session.js';
import { DEFAULT_CONFIG } from '../../src/core/config.js';
import { EXIT_CODES } from '../../src/core/errors.js';
import { ensureDirs } from '../../src/core/paths.js';
import { assertNoSecrets, fakeJwt, fakeSession, secretsOf, tempRoot } from '../helpers/auth.js';
import { parseJson, runCli } from '../helpers/cli.js';
import { fakeTransport, jsonStep, type Step } from '../helpers/http.js';

const FAR_FUTURE = '2999-01-01T00:00:00Z';
const FRESH_JWT = fakeJwt({ exp: Date.parse(FAR_FUTURE) / 1000 });
const CHROMIUM_EXE =
  '/fake/ms-playwright/chromium-1234/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';
const CLI_PATH = '/fake/node_modules/playwright-core/cli.js';
const CHROME_MAC = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const CHECK_NAMES = [
  'node',
  'root',
  'permissions',
  'session',
  'profile',
  'playwright',
  'browser',
  'tenant',
  'lp',
  'le',
];

/** The documented `GET /d2l/api/versions/` shape (d2l-api-web A-25), synthetic values. */
function versionsPayload(
  lp: { latest: string; supported: string[] },
  le: { latest: string; supported: string[] },
): unknown {
  return [
    { ProductCode: 'lp', LatestVersion: lp.latest, SupportedVersions: lp.supported },
    { ProductCode: 'le', LatestVersion: le.latest, SupportedVersions: le.supported },
    { ProductCode: 'ep', LatestVersion: '2.3', SupportedVersions: ['2.0', '2.1', '2.2', '2.3'] },
  ];
}

const VERSIONS_OK = versionsPayload(
  {
    latest: DEFAULT_CONFIG.lpVersion,
    supported: ['1.9', '1.60', '1.61', DEFAULT_CONFIG.lpVersion],
  },
  {
    latest: DEFAULT_CONFIG.leVersion,
    supported: ['1.9', '1.94', '1.95', DEFAULT_CONFIG.leVersion],
  },
);

interface Fake {
  deps: DoctorDeps;
  existing: Set<string>;
  installs: InstallInput[];
  launches: number;
  imports: number;
}

interface FakeOptions {
  existing?: string[];
  importError?: Error;
  /** What the installer returns (exit code); default 0 and it makes the Chromium executable appear. */
  installCode?: number;
  cliPath?: string | null;
  nodeVersion?: string;
  platform?: NodeJS.Platform;
  noExecutablePath?: boolean;
}

function fake(options: FakeOptions = {}): Fake {
  const existing = new Set(options.existing ?? [CHROMIUM_EXE]);
  const installs: InstallInput[] = [];
  const state: Fake = {
    existing,
    installs,
    launches: 0,
    imports: 0,
    deps: {
      nodeVersion: options.nodeVersion ?? 'v22.12.0',
      platform: options.platform ?? 'darwin',
      importer: async () => {
        state.imports += 1;
        if (options.importError) throw options.importError;
        const module: PlaywrightModule = {
          chromium: {
            launchPersistentContext: async () => {
              state.launches += 1;
              throw new Error('doctor must never launch a browser');
            },
            ...(options.noExecutablePath ? {} : { executablePath: () => CHROMIUM_EXE }),
          },
        };
        return module;
      },
      playwrightVersion: () => '1.62.1',
      fileExists: (file) => existing.has(file),
      cliPath: () => (options.cliPath === undefined ? CLI_PATH : options.cliPath),
      install: async (input) => {
        installs.push(input);
        const code = options.installCode ?? 0;
        if (code === 0) existing.add(CHROMIUM_EXE);
        return code;
      },
    },
  };
  return state;
}

interface DoctorRun {
  code: number;
  stdout: string;
  stderr: string;
  calls: ReturnType<typeof fakeTransport>['calls'];
  rungCalls: number;
  fullCalls: number;
}

async function doctor(
  root: string,
  argv: string[],
  fk: Fake,
  steps: Step[] = [jsonStep(VERSIONS_OK)],
  io: { env?: NodeJS.ProcessEnv; stdinIsTTY?: boolean; stdin?: NodeJS.ReadableStream } = {},
): Promise<DoctorRun> {
  const ft = fakeTransport(steps);
  let rungCalls = 0;
  let fullCalls = 0;
  const r = await runCli(['--root', root, 'auth', 'doctor', ...argv], {
    transport: ft.transport,
    doctor: fk.deps,
    rungs: [
      {
        kind: 'silent',
        attempt: async () => {
          rungCalls += 1;
          return null;
        },
      },
    ],
    fullRung: () => {
      fullCalls += 1;
      return {
        kind: 'full',
        failure: null,
        attempt: async () => null,
      };
    },
    ...io,
  });
  return { ...r, calls: ft.calls, rungCalls, fullCalls };
}

function byName(report: DoctorReport, name: string): DoctorCheck {
  const check = report.checks.find((c) => c.name === name);
  assert.ok(check, `no check named ${name} in ${JSON.stringify(report.checks.map((c) => c.name))}`);
  return check;
}

/** A root where every check passes: fresh session, non-empty profile, 0700/0600 modes. */
function seedGreen() {
  const t = tempRoot('bs-doctor-');
  ensureDirs(t.paths);
  writeSession(t.paths, fakeSession({ jwt: FRESH_JWT, jwtExpiresAt: FAR_FUTURE }));
  mkdirSync(path.join(t.paths.profileDir, 'Default'), { recursive: true });
  writeFileSync(path.join(t.paths.profileDir, 'Default', 'Cookies'), 'sqlite');
  return t;
}

test('nodeSatisfies compares against the 22.12 floor', () => {
  assert.equal(NODE_FLOOR, '22.12.0');
  assert.equal(nodeSatisfies('v22.12.0'), true);
  assert.equal(nodeSatisfies('v22.11.9'), false);
  assert.equal(nodeSatisfies('v20.19.0'), false);
  assert.equal(nodeSatisfies('v25.2.1'), true);
  assert.equal(nodeSatisfies('24.0.0'), true);
  assert.equal(nodeSatisfies('garbage'), false);
});

test('channelExecutables mirrors playwright: chrome/msedge per platform, unknown channel is null', () => {
  assert.deepEqual(channelExecutables('chrome', 'darwin', {}), [CHROME_MAC]);
  assert.deepEqual(channelExecutables('msedge', 'linux', {}), ['/opt/microsoft/msedge/msedge']);
  assert.deepEqual(channelExecutables('chrome', 'win32', { PROGRAMFILES: 'C:\\Program Files' }), [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  ]);
  assert.deepEqual(channelExecutables('chrome-canary', 'linux', {}), []);
  assert.equal(channelExecutables('firefox', 'darwin', {}), null);
  assert.equal(channelExecutables('chromium', 'darwin', {}), null);
});

test('doctor all green: exit 0, --json shape, one anonymous GET, no rung, no launch', async () => {
  const t = seedGreen();
  const fk = fake();
  try {
    const r = await doctor(t.root, ['--json'], fk);
    assert.equal(r.code, EXIT_CODES.ok, r.stderr);
    const report = parseJson<DoctorReport>(r.stdout);
    assert.equal(report.ok, true);
    assert.equal(report.root, t.paths.root);
    assert.equal(report.baseUrl, DEFAULT_CONFIG.baseUrl);
    assert.equal(report.browserChannel, 'chromium');
    assert.deepEqual(
      report.checks.map((c) => c.name),
      CHECK_NAMES,
    );
    for (const check of report.checks) {
      assert.equal(check.ok, true, `${check.name}: ${check.detail}`);
      assert.equal(check.status, 'ok', `${check.name}: ${check.detail}`);
      assert.equal(typeof check.detail, 'string');
      assert.equal(check.hint, undefined, `${check.name} carries a hint while ok`);
    }
    assert.ok(byName(report, 'node').detail.includes('v22.12.0'));
    assert.ok(byName(report, 'playwright').detail.includes('1.62.1'));
    assert.ok(byName(report, 'browser').detail.includes(CHROMIUM_EXE));
    assert.ok(byName(report, 'session').detail.includes(FAR_FUTURE));
    assert.ok(byName(report, 'lp').detail.includes(DEFAULT_CONFIG.lpVersion));
    assert.ok(byName(report, 'le').detail.includes(DEFAULT_CONFIG.leVersion));
    // The versions probe is the only request: anonymous, GET, the documented route.
    assert.equal(r.calls.length, 1);
    assert.equal(r.calls[0]?.method, 'GET');
    assert.equal(r.calls[0]?.url, `${DEFAULT_CONFIG.baseUrl}${VERSIONS_PATH}`);
    assert.equal(r.calls[0]?.headers.authorization, undefined);
    assert.equal(r.calls[0]?.headers.cookie, undefined);
    assert.equal(r.rungCalls, 0, 'doctor never climbs a rung');
    assert.equal(r.fullCalls, 0, 'doctor never builds the full rung');
    assert.equal(fk.launches, 0, 'doctor never launches a browser');
    assert.equal(fk.installs.length, 0);
    assert.equal(r.stderr, '');
  } finally {
    rmSync(t.root, { recursive: true, force: true });
  }
});

test('doctor never prints a secret in any mode', async () => {
  const t = seedGreen();
  const session = fakeSession({ jwt: FRESH_JWT, jwtExpiresAt: FAR_FUTURE });
  const secrets = [...secretsOf(session), FRESH_JWT];
  try {
    for (const flags of [['--json', '--verbose'], ['--plain'], ['--verbose']]) {
      const r = await doctor(t.root, flags, fake());
      assertNoSecrets(r.stdout, secrets, `stdout (${flags.join(' ')})`);
      assertNoSecrets(r.stderr, secrets, `stderr (${flags.join(' ')})`);
    }
  } finally {
    rmSync(t.root, { recursive: true, force: true });
  }
});

test('doctor: Node below 22.12 fails the node check (exit 10)', async () => {
  const t = seedGreen();
  try {
    const r = await doctor(t.root, ['--json'], fake({ nodeVersion: 'v20.19.0' }));
    assert.equal(r.code, EXIT_CODES.config);
    const report = parseJson<DoctorReport>(r.stdout);
    assert.equal(report.ok, false);
    const node = byName(report, 'node');
    assert.equal(node.ok, false);
    assert.equal(node.status, 'fail');
    assert.match(node.detail, /v20\.19\.0/);
    assert.match(node.hint ?? '', /22\.12/);
    assert.match(r.stderr, /node/);
  } finally {
    rmSync(t.root, { recursive: true, force: true });
  }
});

test('doctor on a root that does not exist: read-only, creates nothing, session/profile are warnings, exit 0', async () => {
  const { root } = tempRoot('bs-doctor-');
  const state = path.join(root, 'state');
  try {
    const r = await doctor(state, ['--json'], fake());
    assert.equal(r.code, EXIT_CODES.ok, r.stderr);
    assert.equal(existsSync(state), false, 'doctor must not create the state directory');
    const report = parseJson<DoctorReport>(r.stdout);
    assert.equal(report.ok, true);
    const rootCheck = byName(report, 'root');
    assert.equal(rootCheck.status, 'ok');
    assert.match(rootCheck.detail, /not created yet/);
    assert.ok(rootCheck.detail.includes(state));
    assert.equal(byName(report, 'permissions').status, 'ok');
    const session = byName(report, 'session');
    assert.equal(session.ok, true);
    assert.equal(session.status, 'warn');
    assert.match(session.detail, /^none\b/);
    assert.equal(session.hint, HINT_LOGIN);
    const profile = byName(report, 'profile');
    assert.equal(profile.status, 'warn');
    assert.equal(profile.hint, HINT_LOGIN);
    assert.equal(r.calls.length, 1, 'only the versions probe');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('doctor: an expired cached JWT is a warning pointing at bs auth status; no mint happens', async () => {
  const t = seedGreen();
  try {
    writeSession(
      t.paths,
      fakeSession({ jwt: fakeJwt({ exp: 1 }), jwtExpiresAt: '2020-01-01T00:00:00Z' }),
    );
    const r = await doctor(t.root, ['--json'], fake());
    assert.equal(r.code, EXIT_CODES.ok, r.stderr);
    const session = byName(parseJson<DoctorReport>(r.stdout), 'session');
    assert.equal(session.status, 'warn');
    assert.match(session.detail, /^expired\b/);
    assert.ok(session.detail.includes('2020-01-01T00:00:00Z'));
    assert.match(session.hint ?? '', /bs auth status/);
    assert.equal(r.calls.filter((c) => c.method === 'POST').length, 0, 'no mint');
  } finally {
    rmSync(t.root, { recursive: true, force: true });
  }
});

test('doctor: an empty profile directory is a warning', async () => {
  const t = seedGreen();
  try {
    rmSync(t.paths.profileDir, { recursive: true, force: true });
    mkdirSync(t.paths.profileDir, { mode: 0o700 });
    const r = await doctor(t.root, ['--json'], fake());
    assert.equal(r.code, EXIT_CODES.ok, r.stderr);
    const profile = byName(parseJson<DoctorReport>(r.stdout), 'profile');
    assert.equal(profile.status, 'warn');
    assert.match(profile.detail, /empty/);
  } finally {
    rmSync(t.root, { recursive: true, force: true });
  }
});

test('doctor: loose modes on the root or a secret file fail the permissions check with a chmod hint', async (tc) => {
  if (process.platform === 'win32') return tc.skip('POSIX modes');
  const t = seedGreen();
  try {
    chmodSync(t.paths.sessionFile, 0o644);
    chmodSync(t.paths.root, 0o755);
    const r = await doctor(t.root, ['--json'], fake());
    assert.equal(r.code, EXIT_CODES.config);
    const perms = byName(parseJson<DoctorReport>(r.stdout), 'permissions');
    assert.equal(perms.status, 'fail');
    assert.ok(perms.detail.includes('session.json'), perms.detail);
    assert.ok(perms.detail.includes('0644'), perms.detail);
    assert.ok(perms.detail.includes('0755'), perms.detail);
    assert.match(perms.hint ?? '', /chmod 600/);
    assert.match(perms.hint ?? '', /chmod 700/);
  } finally {
    rmSync(t.root, { recursive: true, force: true });
  }
});

test('doctor: playwright-core missing fails playwright and browser (not checked), exit 10', async () => {
  const t = seedGreen();
  try {
    const err = Object.assign(new Error("Cannot find package 'playwright-core'"), {
      code: 'ERR_MODULE_NOT_FOUND',
    });
    const r = await doctor(t.root, ['--json'], fake({ importError: err }));
    assert.equal(r.code, EXIT_CODES.config);
    const report = parseJson<DoctorReport>(r.stdout);
    const pw = byName(report, 'playwright');
    assert.equal(pw.status, 'fail');
    assert.match(pw.detail, /not installed/);
    assert.match(pw.hint ?? '', /npm install/);
    const browser = byName(report, 'browser');
    assert.equal(browser.status, 'fail');
    assert.match(browser.detail, /not checked/);
  } finally {
    rmSync(t.root, { recursive: true, force: true });
  }
});

test('doctor: no Chromium for the default channel fails with the install command, the size and the chrome alternative', async () => {
  const t = seedGreen();
  try {
    const r = await doctor(t.root, ['--json'], fake({ existing: [] }));
    assert.equal(r.code, EXIT_CODES.config);
    const report = parseJson<DoctorReport>(r.stdout);
    assert.equal(report.ok, false);
    const browser = byName(report, 'browser');
    assert.equal(browser.status, 'fail');
    assert.ok(browser.detail.includes(CHROMIUM_EXE), browser.detail);
    const hint = browser.hint ?? '';
    assert.ok(hint.includes(`node ${CLI_PATH} install chromium`), hint);
    assert.ok(hint.includes(CHROMIUM_INSTALL_SIZE), hint);
    assert.ok(hint.includes('BS_BROWSER_CHANNEL=chrome'), hint);
    assert.ok(hint.includes('bs auth doctor --install-browser'), hint);
    assert.match(r.stderr, /browser/);
    for (const name of CHECK_NAMES.filter((n) => n !== 'browser')) {
      assert.equal(byName(report, name).ok, true, name);
    }
  } finally {
    rmSync(t.root, { recursive: true, force: true });
  }
});

test('doctor: BS_BROWSER_CHANNEL=chrome resolves the installed Chrome path per platform', async () => {
  const t = seedGreen();
  try {
    const present = await doctor(t.root, ['--json'], fake({ existing: [CHROME_MAC] }), undefined, {
      env: { BS_BROWSER_CHANNEL: 'chrome' },
    });
    assert.equal(present.code, EXIT_CODES.ok, present.stderr);
    const report = parseJson<DoctorReport>(present.stdout);
    assert.equal(report.browserChannel, 'chrome');
    assert.ok(byName(report, 'browser').detail.includes(CHROME_MAC));

    const missing = await doctor(
      t.root,
      ['--json'],
      fake({ existing: [CHROMIUM_EXE] }),
      undefined,
      {
        env: { BS_BROWSER_CHANNEL: 'chrome' },
      },
    );
    assert.equal(missing.code, EXIT_CODES.config);
    const browser = byName(parseJson<DoctorReport>(missing.stdout), 'browser');
    assert.equal(browser.status, 'fail');
    assert.ok(browser.detail.includes(CHROME_MAC), browser.detail);
    assert.match(browser.hint ?? '', /Google Chrome/);
    assert.match(browser.hint ?? '', /BS_BROWSER_CHANNEL/);

    const unknown = await doctor(t.root, ['--json'], fake(), undefined, {
      env: { BS_BROWSER_CHANNEL: 'firefox' },
    });
    assert.equal(unknown.code, EXIT_CODES.ok, unknown.stderr);
    assert.equal(byName(parseJson<DoctorReport>(unknown.stdout), 'browser').status, 'warn');
  } finally {
    rmSync(t.root, { recursive: true, force: true });
  }
});

test('doctor: a playwright-core without executablePath is a warning, not a launch', async () => {
  const t = seedGreen();
  const fk = fake({ noExecutablePath: true });
  try {
    const r = await doctor(t.root, ['--json'], fk);
    assert.equal(r.code, EXIT_CODES.ok, r.stderr);
    assert.equal(byName(parseJson<DoctorReport>(r.stdout), 'browser').status, 'warn');
    assert.equal(fk.launches, 0);
  } finally {
    rmSync(t.root, { recursive: true, force: true });
  }
});

test('doctor: a supported but not latest LP/LE version is a warning with the env hint (exit 0)', async () => {
  const t = seedGreen();
  try {
    const payload = versionsPayload(
      { latest: '1.63', supported: ['1.61', DEFAULT_CONFIG.lpVersion, '1.63'] },
      { latest: '1.97', supported: ['1.95', DEFAULT_CONFIG.leVersion, '1.97'] },
    );
    const r = await doctor(t.root, ['--json'], fake(), [jsonStep(payload)]);
    assert.equal(r.code, EXIT_CODES.ok, r.stderr);
    const report = parseJson<DoctorReport>(r.stdout);
    assert.equal(report.ok, true);
    const lp = byName(report, 'lp');
    assert.equal(lp.status, 'warn');
    assert.ok(lp.detail.includes('1.63'), lp.detail);
    assert.match(lp.hint ?? '', /BS_LP_VERSION=1\.63/);
    const le = byName(report, 'le');
    assert.equal(le.status, 'warn');
    assert.match(le.hint ?? '', /BS_LE_VERSION=1\.97/);
  } finally {
    rmSync(t.root, { recursive: true, force: true });
  }
});

test('doctor: an unsupported configured version fails (exit 10) with the latest named', async () => {
  const t = seedGreen();
  try {
    const payload = versionsPayload(
      { latest: '1.63', supported: ['1.61', DEFAULT_CONFIG.lpVersion, '1.63'] },
      { latest: '1.97', supported: ['1.95', DEFAULT_CONFIG.leVersion, '1.97'] },
    );
    const r = await doctor(t.root, ['--json'], fake(), [jsonStep(payload)], {
      env: { BS_LE_VERSION: '1.50' },
    });
    assert.equal(r.code, EXIT_CODES.config);
    const report = parseJson<DoctorReport>(r.stdout);
    const le = byName(report, 'le');
    assert.equal(le.status, 'fail');
    assert.match(le.detail, /1\.50/);
    assert.match(le.detail, /not supported/);
    assert.match(le.hint ?? '', /BS_LE_VERSION=1\.97/);
    assert.equal(byName(report, 'lp').status, 'warn');
    assert.equal(byName(report, 'tenant').status, 'ok');
    assert.match(r.stderr, /\ble\b/);
  } finally {
    rmSync(t.root, { recursive: true, force: true });
  }
});

test('doctor: the tenant not advertising a product, or answering non-JSON, fails the probe', async () => {
  const t = seedGreen();
  try {
    const noLe = await doctor(t.root, ['--json'], fake(), [
      jsonStep([{ ProductCode: 'lp', LatestVersion: '1.62', SupportedVersions: ['1.62'] }]),
    ]);
    assert.equal(noLe.code, EXIT_CODES.config);
    const le = byName(parseJson<DoctorReport>(noLe.stdout), 'le');
    assert.equal(le.status, 'fail');
    assert.match(le.detail, /not advertise/);

    const html = await doctor(t.root, ['--json'], fake(), [
      { status: 200, headers: { 'content-type': 'text/html' }, body: '<html>login</html>' },
    ]);
    assert.equal(html.code, EXIT_CODES.config);
    const report = parseJson<DoctorReport>(html.stdout);
    assert.equal(byName(report, 'tenant').status, 'fail');
    assert.equal(byName(report, 'lp').status, 'warn');
    assert.equal(byName(report, 'le').status, 'warn');
  } finally {
    rmSync(t.root, { recursive: true, force: true });
  }
});

test('doctor: a network failure fails the tenant row with a retry hint, the rest still reports, exit 8', async () => {
  const t = seedGreen();
  try {
    const r = await doctor(t.root, ['--json'], fake(), [
      Object.assign(new TypeError('fetch failed'), { cause: new Error('getaddrinfo ENOTFOUND') }),
    ]);
    assert.equal(r.code, EXIT_CODES.retryable);
    const report = parseJson<DoctorReport>(r.stdout);
    assert.equal(report.ok, false);
    const tenant = byName(report, 'tenant');
    assert.equal(tenant.status, 'fail');
    assert.match(tenant.detail, /ENOTFOUND|fetch failed/);
    assert.match(tenant.hint ?? '', /retry/i);
    assert.equal(byName(report, 'lp').status, 'warn');
    assert.match(byName(report, 'lp').detail, /not checked/);
    assert.equal(byName(report, 'node').status, 'ok');
    assert.equal(byName(report, 'browser').status, 'ok');
    assert.match(r.stderr, /tenant/);
  } finally {
    rmSync(t.root, { recursive: true, force: true });
  }
});

test('doctor --install-browser on a non-TTY (or --no-input) is exit 2, the installer never runs', async () => {
  const t = seedGreen();
  try {
    const fk = fake({ existing: [] });
    const r = await doctor(t.root, ['--install-browser', '--json'], fk);
    assert.equal(r.code, EXIT_CODES.usage);
    assert.equal(fk.installs.length, 0);
    assert.match(r.stderr, /cannot prompt/);
    assert.ok(r.stderr.includes(`node ${CLI_PATH} install chromium`), r.stderr);
    assert.equal(parseJson<DoctorReport>(r.stdout).ok, false, 'the report is still emitted');

    const fk2 = fake({ existing: [] });
    const r2 = await doctor(t.root, ['--install-browser', '--no-input'], fk2, undefined, {
      stdinIsTTY: true,
      stdin: Readable.from(['y\n']),
    });
    assert.equal(r2.code, EXIT_CODES.usage);
    assert.equal(fk2.installs.length, 0);
  } finally {
    rmSync(t.root, { recursive: true, force: true });
  }
});

test('doctor --install-browser on a TTY asks (~300 MB, y/N) on stderr, installs once, re-checks the browser', async () => {
  const t = seedGreen();
  try {
    const fk = fake({ existing: [] });
    const r = await doctor(t.root, ['--install-browser', '--json'], fk, undefined, {
      stdinIsTTY: true,
      stdin: Readable.from(['y\n']),
      env: { PLAYWRIGHT_BROWSERS_PATH: '/fake/browsers' },
    });
    assert.equal(r.code, EXIT_CODES.ok, r.stderr);
    assert.match(r.stderr, /Download Chromium \(~300 MB\) into playwright's cache\? \[y\/N\]/);
    assert.equal(fk.installs.length, 1);
    assert.equal(fk.installs[0]?.cliPath, CLI_PATH);
    assert.equal(fk.installs[0]?.browser, 'chromium');
    assert.equal(fk.installs[0]?.env.PLAYWRIGHT_BROWSERS_PATH, '/fake/browsers');
    assert.equal(fk.imports, 2, 'the browser check is re-run after the install');
    const report = parseJson<DoctorReport>(r.stdout);
    assert.equal(report.ok, true);
    const browser = byName(report, 'browser');
    assert.equal(browser.status, 'ok');
    assert.ok(browser.detail.includes(CHROMIUM_EXE));
    assert.equal(fk.launches, 0);
  } finally {
    rmSync(t.root, { recursive: true, force: true });
  }
});

test('doctor --install-browser declined at the prompt: nothing installed, browser still fails (exit 10)', async () => {
  const t = seedGreen();
  try {
    for (const answer of ['n\n', '\n', 'maybe\n']) {
      const fk = fake({ existing: [] });
      const r = await doctor(t.root, ['--install-browser', '--json'], fk, undefined, {
        stdinIsTTY: true,
        stdin: Readable.from([answer]),
      });
      assert.equal(r.code, EXIT_CODES.config, JSON.stringify(answer));
      assert.equal(fk.installs.length, 0);
      assert.match(r.stderr, /declined/);
      assert.equal(byName(parseJson<DoctorReport>(r.stdout), 'browser').status, 'fail');
    }
  } finally {
    rmSync(t.root, { recursive: true, force: true });
  }
});

test('doctor --install-browser: a failing installer leaves the browser check failed (exit 10)', async () => {
  const t = seedGreen();
  try {
    const fk = fake({ existing: [], installCode: 3 });
    const r = await doctor(t.root, ['--install-browser', '--json'], fk, undefined, {
      stdinIsTTY: true,
      stdin: Readable.from(['yes\n']),
    });
    assert.equal(r.code, EXIT_CODES.config);
    assert.equal(fk.installs.length, 1);
    assert.match(r.stderr, /exited with code 3/);
    assert.equal(byName(parseJson<DoctorReport>(r.stdout), 'browser').status, 'fail');
  } finally {
    rmSync(t.root, { recursive: true, force: true });
  }
});

test('doctor --install-browser: already installed → no prompt, no install; a non-chromium channel → no download offered', async () => {
  const t = seedGreen();
  try {
    const fk = fake();
    const r = await doctor(t.root, ['--install-browser', '--json'], fk, undefined, {
      stdinIsTTY: true,
      stdin: Readable.from(['y\n']),
    });
    assert.equal(r.code, EXIT_CODES.ok, r.stderr);
    assert.equal(fk.installs.length, 0);
    assert.doesNotMatch(r.stderr, /\[y\/N\]/);

    const fk2 = fake({ existing: [] });
    const r2 = await doctor(t.root, ['--install-browser', '--json'], fk2, undefined, {
      stdinIsTTY: true,
      stdin: Readable.from(['y\n']),
      env: { BS_BROWSER_CHANNEL: 'chrome' },
    });
    assert.equal(r2.code, EXIT_CODES.config);
    assert.equal(fk2.installs.length, 0);
    assert.doesNotMatch(r2.stderr, /\[y\/N\]/);
    assert.match(r2.stderr, /Google Chrome/);

    const fk3 = fake({ existing: [], cliPath: null });
    const r3 = await doctor(t.root, ['--install-browser', '--json'], fk3, undefined, {
      stdinIsTTY: true,
      stdin: Readable.from(['y\n']),
    });
    assert.equal(r3.code, EXIT_CODES.config);
    assert.equal(fk3.installs.length, 0);
    assert.match(r3.stderr, /cli\.js/);
  } finally {
    rmSync(t.root, { recursive: true, force: true });
  }
});

test('doctor --plain is one TSV row per check; human mode is a marked table on stdout', async () => {
  const t = seedGreen();
  try {
    const plain = await doctor(t.root, ['--plain'], fake({ existing: [] }));
    assert.equal(plain.code, EXIT_CODES.config);
    const lines = plain.stdout.trimEnd().split('\n');
    assert.equal(lines[0], 'name\tstatus\tok\tdetail\thint');
    assert.equal(lines.length, CHECK_NAMES.length + 1);
    assert.ok(lines[1]?.startsWith('node\tok\ttrue\t'), lines[1]);
    const browserLine = lines.find((l) => l.startsWith('browser\t'));
    assert.ok(browserLine?.startsWith('browser\tfail\tfalse\t'), browserLine ?? '(no browser row)');
    assert.ok(browserLine?.includes('install chromium'));

    const human = await doctor(t.root, [], fake({ existing: [] }));
    assert.equal(human.code, EXIT_CODES.config);
    assert.ok(human.stdout.includes('\u2713 node'), human.stdout);
    assert.ok(human.stdout.includes('\u2717 browser'), human.stdout);
    assert.ok(human.stdout.includes('install chromium'), human.stdout);
    assert.match(human.stdout, /1 check failed/);
    assert.match(human.stderr, /^bs: /m);

    const green = await doctor(t.root, [], fake());
    assert.equal(green.code, EXIT_CODES.ok, green.stderr);
    assert.match(green.stdout, /all checks passed/);
    assert.equal(green.stderr, '');
  } finally {
    rmSync(t.root, { recursive: true, force: true });
  }
});

test('doctor --help and schema auth doctor create no state directory', async () => {
  const { root } = tempRoot('bs-doctor-');
  const state = path.join(root, 'state');
  try {
    for (const argv of [
      ['auth', 'doctor', '--help'],
      ['schema', 'auth', 'doctor'],
    ]) {
      const r = await runCli(['--root', state, ...argv]);
      assert.equal(r.code, 0, argv.join(' '));
      assert.equal(existsSync(state), false, argv.join(' '));
      assert.ok(r.stdout.includes('install-browser'), argv.join(' '));
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
