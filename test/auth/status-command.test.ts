import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { HINT_LOGIN, HINT_REFRESH } from '../../src/auth/ladder.js';
import { writeSession } from '../../src/auth/session.js';
import { DEFAULT_CONFIG } from '../../src/core/config.js';
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
import { parseJson, runCli } from '../helpers/cli.js';
import { fakeTransport, type Step } from '../helpers/http.js';

interface StatusJson {
  state: 'fresh' | 'expired' | 'none';
  baseUrl: string;
  capturedAt: string | null;
  jwtExpiresAt: string | null;
  profileExists: boolean;
  sessionFile: string;
  root: string;
}

const FAR_FUTURE = '2999-01-01T00:00:00Z';
const FRESH_JWT = fakeJwt({ exp: Date.parse(FAR_FUTURE) / 1000 });
const STALE_JWT = fakeJwt({ exp: 1 });

function status(root: string, steps: Step[], extra: string[] = []) {
  const ft = fakeTransport(steps);
  return runCli(['--root', root, 'auth', 'status', ...extra], { transport: ft.transport }).then(
    (r) => ({ ...r, calls: ft.calls }),
  );
}

test('auth status with no session: exit 4, JSON shape, login hint, no HTTP', async () => {
  const { root, paths } = tempRoot();
  try {
    const r = await status(root, [], ['--json']);
    assert.equal(r.code, EXIT_CODES.auth_required);
    const out = parseJson<StatusJson>(r.stdout);
    assert.deepEqual(out, {
      state: 'none',
      baseUrl: DEFAULT_CONFIG.baseUrl,
      capturedAt: null,
      jwtExpiresAt: null,
      profileExists: false,
      sessionFile: paths.sessionFile,
      root: paths.root,
    });
    assert.ok(r.stderr.includes(HINT_LOGIN), r.stderr);
    assert.equal(r.calls.length, 0);
    assert.ok(existsSync(paths.statusFile), 'status.json is written on every call');
    assert.equal(JSON.parse(readFileSync(paths.statusFile, 'utf8')).state, 'none');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('auth status with a fresh JWT: exit 0, no HTTP, never a browser', async () => {
  const { root, paths } = tempRoot();
  try {
    const session = fakeSession({ jwt: FRESH_JWT, jwtExpiresAt: FAR_FUTURE });
    writeSession(paths, session);
    const r = await status(root, [], ['--json']);
    assert.equal(r.code, EXIT_CODES.ok, r.stderr);
    const out = parseJson<StatusJson>(r.stdout);
    assert.equal(out.state, 'fresh');
    assert.equal(out.baseUrl, session.baseUrl);
    assert.equal(out.capturedAt, session.capturedAt);
    assert.equal(out.jwtExpiresAt, FAR_FUTURE);
    assert.equal(out.profileExists, false);
    assert.equal(r.calls.length, 0);
    assert.equal(r.stderr, '');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('auth status with a stale JWT mints once through rung 0 and reports the truth', async () => {
  const { root, paths } = tempRoot();
  try {
    writeSession(paths, fakeSession({ jwt: STALE_JWT, jwtExpiresAt: '2020-01-01T00:00:00Z' }));
    const r = await status(root, [mintOkStep(FRESH_JWT)], ['--json']);
    assert.equal(r.code, EXIT_CODES.ok, r.stderr);
    const out = parseJson<StatusJson>(r.stdout);
    assert.equal(out.state, 'fresh');
    assert.equal(r.calls.length, 1);
    assert.equal(r.calls[0]?.method, 'POST');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('auth status when the mint answers the expired stub: exit 4, refresh hint, session kept', async () => {
  const { root, paths } = tempRoot();
  try {
    const session = fakeSession({ jwt: STALE_JWT, jwtExpiresAt: '2020-01-01T00:00:00Z' });
    writeSession(paths, session);
    const before = readFileSync(paths.sessionFile, 'utf8');
    const r = await status(root, [expiredStubStep], ['--json']);
    assert.equal(r.code, EXIT_CODES.auth_required);
    const out = parseJson<StatusJson>(r.stdout);
    assert.equal(out.state, 'expired');
    assert.equal(out.capturedAt, session.capturedAt);
    assert.equal(out.jwtExpiresAt, '2020-01-01T00:00:00Z');
    assert.ok(r.stderr.includes(HINT_REFRESH), r.stderr);
    assert.equal(readFileSync(paths.sessionFile, 'utf8'), before);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('auth status --plain prints key<TAB>value lines', async () => {
  const { root, paths } = tempRoot();
  try {
    writeSession(paths, fakeSession({ jwt: FRESH_JWT, jwtExpiresAt: FAR_FUTURE }));
    const r = await status(root, [], ['--plain']);
    assert.equal(r.code, 0, r.stderr);
    const lines = r.stdout.trimEnd().split('\n');
    assert.equal(lines[0], 'key\tvalue');
    const map = new Map(lines.slice(1).map((l) => l.split('\t') as [string, string]));
    assert.equal(map.get('state'), 'fresh');
    assert.equal(map.get('jwtExpiresAt'), FAR_FUTURE);
    assert.equal(map.get('profileExists'), 'false');
    assert.equal(map.get('root'), paths.root);
    assert.deepEqual(
      [...map.keys()],
      ['state', 'baseUrl', 'capturedAt', 'jwtExpiresAt', 'profileExists', 'sessionFile', 'root'],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('auth status human mode: one summary line on stdout', async () => {
  const { root, paths } = tempRoot();
  try {
    writeSession(paths, fakeSession({ jwt: FRESH_JWT, jwtExpiresAt: FAR_FUTURE }));
    const r = await status(root, []);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.stdout.trimEnd().split('\n').length, 1);
    assert.match(r.stdout, /^fresh\b/);
    assert.ok(r.stdout.includes(FAR_FUTURE));

    const none = await status(path.join(root, 'empty'), []);
    assert.equal(none.code, EXIT_CODES.auth_required);
    assert.match(none.stdout, /^none\b/);
    assert.ok(none.stderr.includes(HINT_LOGIN));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('profileExists reflects a non-empty profile directory', async () => {
  const { root, paths } = tempRoot();
  try {
    mkdirSync(paths.profileDir, { recursive: true });
    let r = await status(root, [], ['--json']);
    assert.equal(parseJson<StatusJson>(r.stdout).profileExists, false, 'empty dir is no profile');
    writeFileSync(path.join(paths.profileDir, 'Default'), '');
    r = await status(root, [], ['--json']);
    assert.equal(parseJson<StatusJson>(r.stdout).profileExists, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('auth status never writes a secret to stdout or stderr, even under --verbose', async () => {
  const { root, paths } = tempRoot();
  try {
    const session = fakeSession({ jwt: STALE_JWT, jwtExpiresAt: '2020-01-01T00:00:00Z' });
    writeSession(paths, session);
    for (const [steps, flags] of [
      [[mintOkStep(FRESH_JWT)], ['--json', '--verbose']],
      [[expiredStubStep], ['--verbose']],
      [[expiredStubStep], ['--plain', '--verbose']],
    ] as [Step[], string[]][]) {
      const r = await status(root, steps, flags);
      const secrets = [...secretsOf(session), FRESH_JWT, STALE_JWT];
      assertNoSecrets(r.stdout, secrets, `stdout (${flags.join(' ')})`);
      assertNoSecrets(r.stderr, secrets, `stderr (${flags.join(' ')})`);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('auth status --base-url does not override the session tenant, but names it when none', async () => {
  const { root } = tempRoot();
  try {
    const r = await status(root, [], ['--json', '--base-url', 'https://example.brightspace.com']);
    assert.equal(parseJson<StatusJson>(r.stdout).baseUrl, 'https://example.brightspace.com');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('help, version and schema still never create the state directory with auth registered', async () => {
  const { root } = tempRoot();
  const state = path.join(root, 'state');
  try {
    for (const argv of [
      ['auth', '--help'],
      ['auth', 'status', '--help'],
      ['schema', 'auth'],
    ]) {
      const r = await runCli(['--root', state, ...argv]);
      assert.equal(r.code, 0, argv.join(' '));
      assert.equal(existsSync(state), false, argv.join(' '));
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
