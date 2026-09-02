import assert from 'node:assert/strict';
import { readFileSync, rmSync } from 'node:fs';
import { test } from 'node:test';
import { HINT_LOGIN, type Rung } from '../../src/auth/ladder.js';
import { HINT_DOCTOR, silentRung } from '../../src/auth/rungs/silent.js';
import { readSession, writeSession } from '../../src/auth/session.js';
import { EXIT_CODES } from '../../src/core/errors.js';
import {
  assertNoSecrets,
  expiredStubStep,
  fakeJwt,
  fakeSession,
  mintOkStep,
  secretsOf,
  tempRoot,
} from '../helpers/auth.js';
import {
  ALL_COOKIES,
  emailSurface,
  FakeBrowser,
  loginSurface,
  silentChain,
  XSRF_VIA_JS,
  XSRF_VIA_META,
} from '../helpers/browser.js';
import { parseJson, runCli } from '../helpers/cli.js';
import { fakeTransport, type Step } from '../helpers/http.js';

const NOW = Date.parse('2026-09-02T10:00:00Z');
const NEW_JWT = fakeJwt({ exp: NOW / 1000 + 7200 });
const STALE_JWT = fakeJwt({ exp: 1 });
const SECRETS = [
  ...ALL_COOKIES.map((c) => c.value),
  XSRF_VIA_JS,
  XSRF_VIA_META,
  NEW_JWT,
  STALE_JWT,
];
const STATUS_KEYS = [
  'state',
  'baseUrl',
  'capturedAt',
  'jwtExpiresAt',
  'profileExists',
  'sessionFile',
  'root',
];

interface StatusJson {
  state: string;
  baseUrl: string;
  capturedAt: string | null;
  jwtExpiresAt: string | null;
  profileExists: boolean;
  sessionFile: string;
  root: string;
}

function refresh(
  root: string,
  steps: Step[],
  fb: FakeBrowser,
  extra: string[] = [],
  rungDeps = {},
) {
  const ft = fakeTransport(steps);
  let fullCalls = 0;
  const full: Rung = {
    kind: 'full',
    attempt: async () => {
      fullCalls += 1;
      return fakeSession();
    },
  };
  return runCli(['--root', root, 'auth', 'refresh', ...extra], {
    transport: ft.transport,
    rungs: [silentRung({ importer: fb.importer(), now: () => fb.now, ...rungDeps }), full],
  }).then((r) => ({ ...r, calls: ft.calls, fullCalls: () => fullCalls }));
}

test('auth refresh with no session: the silent rung restores it, rung 0 mints, exit 0, status shape', async () => {
  const { root, paths } = tempRoot();
  try {
    const fb = new FakeBrowser(silentChain(), { now: NOW });
    const r = await refresh(root, [mintOkStep(NEW_JWT)], fb, ['--json']);
    assert.equal(r.code, EXIT_CODES.ok, r.stderr);
    const out = parseJson<StatusJson>(r.stdout);
    assert.deepEqual(Object.keys(out), STATUS_KEYS, 'same shape as auth status');
    assert.equal(out.state, 'fresh');
    assert.equal(out.baseUrl, 'https://purdue.brightspace.com');
    assert.equal(out.capturedAt, '2026-09-02T10:00:02Z');
    assert.equal(out.jwtExpiresAt, '2026-09-02T11:59:00Z');
    assert.equal(out.sessionFile, paths.sessionFile);
    assert.equal(r.calls.length, 1, 'exactly one mint');
    assert.equal(r.calls[0]?.headers['x-csrf-token'], XSRF_VIA_JS);
    assert.equal(r.fullCalls(), 0, 'the full rung never runs from refresh');
    assert.deepEqual(fb.launches[0]?.options, { headless: true, channel: 'chromium' });
    const onDisk = readSession(paths);
    assert.equal(onDisk?.jwt, NEW_JWT);
    assert.equal(onDisk?.csrfToken, XSRF_VIA_JS);
    assert.equal(JSON.parse(readFileSync(paths.statusFile, 'utf8')).state, 'fresh');
    assert.equal(r.stderr, '');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('auth refresh always drives the browser, even when the cached JWT is still fresh', async () => {
  const { root, paths } = tempRoot();
  try {
    const fresh = fakeJwt({ exp: Date.parse('2999-01-01T00:00:00Z') / 1000 });
    writeSession(
      paths,
      fakeSession({ csrfToken: 'OLD-CSRF', jwt: fresh, jwtExpiresAt: '2999-01-01T00:00:00Z' }),
    );
    const fb = new FakeBrowser(silentChain(), { now: NOW });
    const r = await refresh(root, [mintOkStep(NEW_JWT)], fb, ['--json']);
    assert.equal(r.code, EXIT_CODES.ok, r.stderr);
    assert.equal(fb.launches.length, 1, 'the wristband is exercised (Extra 6 quirk 10)');
    assert.equal(r.calls.length, 1, 'the restored session is minted, not the cached JWT reused');
    assert.equal(readSession(paths)?.csrfToken, XSRF_VIA_JS);
    assert.equal(readSession(paths)?.jwt, NEW_JWT);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('auth refresh when the silent rung fails: exit 4, login hint, existing session untouched', async () => {
  const { root, paths } = tempRoot();
  try {
    const session = fakeSession({ jwt: STALE_JWT, jwtExpiresAt: '2020-01-01T00:00:00Z' });
    writeSession(paths, session);
    const before = readFileSync(paths.sessionFile, 'utf8');
    const fb = new FakeBrowser([loginSurface('email'), emailSurface()], { now: NOW });
    const r = await refresh(root, [expiredStubStep], fb, ['--json']);
    assert.equal(r.code, EXIT_CODES.auth_required);
    const out = parseJson<StatusJson>(r.stdout);
    assert.deepEqual(Object.keys(out), STATUS_KEYS);
    assert.equal(out.state, 'expired');
    assert.ok(r.stderr.includes(HINT_LOGIN), r.stderr);
    assert.equal(readFileSync(paths.sessionFile, 'utf8'), before);
    assert.equal(r.fullCalls(), 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('auth refresh with no session and a failing silent rung: exit 4, state none', async () => {
  const { root } = tempRoot();
  try {
    const fb = new FakeBrowser([loginSurface('email'), emailSurface()], { now: NOW });
    const r = await refresh(root, [], fb, ['--json']);
    assert.equal(r.code, EXIT_CODES.auth_required);
    assert.equal(parseJson<StatusJson>(r.stdout).state, 'none');
    assert.ok(r.stderr.includes(HINT_LOGIN));
    assert.equal(r.calls.length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('auth refresh with no browser available: exit 4, the doctor hint and the login hint on stderr', async () => {
  const { root } = tempRoot();
  try {
    const fb = new FakeBrowser(silentChain(), { now: NOW });
    const importError = Object.assign(new Error("Cannot find package 'playwright-core'"), {
      code: 'ERR_MODULE_NOT_FOUND',
    });
    const ft = fakeTransport([]);
    const r = await runCli(['--root', root, 'auth', 'refresh', '--json'], {
      transport: ft.transport,
      rungs: [silentRung({ importer: fb.importer({ importError }) })],
    });
    assert.equal(r.code, EXIT_CODES.auth_required);
    assert.ok(r.stderr.includes(HINT_DOCTOR), r.stderr);
    assert.ok(r.stderr.includes(HINT_LOGIN), r.stderr);
    assert.equal(parseJson<StatusJson>(r.stdout).state, 'none');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('auth refresh never prints a secret, even under --verbose, in any mode', async () => {
  const { root, paths } = tempRoot();
  try {
    writeSession(paths, fakeSession({ jwt: STALE_JWT, jwtExpiresAt: '2020-01-01T00:00:00Z' }));
    const secrets = [...secretsOf(fakeSession()), ...SECRETS];
    for (const flags of [['--json', '--verbose'], ['--verbose'], ['--plain', '--verbose']]) {
      const fb = new FakeBrowser(silentChain(), { now: NOW });
      const r = await refresh(root, [mintOkStep(NEW_JWT)], fb, flags);
      assert.equal(r.code, EXIT_CODES.ok, r.stderr);
      assertNoSecrets(r.stdout, secrets, `stdout (${flags.join(' ')})`);
      assertNoSecrets(r.stderr, secrets, `stderr (${flags.join(' ')})`);
      assert.ok(r.stderr.length > 0, 'verbose diagnostics were written');
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('auth refresh --plain and human modes mirror auth status', async () => {
  const { root } = tempRoot();
  try {
    const plain = await refresh(
      root,
      [mintOkStep(NEW_JWT)],
      new FakeBrowser(silentChain(), { now: NOW }),
      ['--plain'],
    );
    assert.equal(plain.code, 0, plain.stderr);
    const lines = plain.stdout.trimEnd().split('\n');
    assert.equal(lines[0], 'key\tvalue');
    assert.deepEqual(
      lines.slice(1).map((l) => l.split('\t')[0]),
      STATUS_KEYS,
    );

    const human = await refresh(
      root,
      [mintOkStep(NEW_JWT)],
      new FakeBrowser(silentChain(), { now: NOW }),
    );
    assert.equal(human.code, 0, human.stderr);
    assert.match(human.stdout, /^fresh\b/);
    assert.equal(human.stdout.trimEnd().split('\n').length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
