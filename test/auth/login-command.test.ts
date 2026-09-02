import assert from 'node:assert/strict';
import { existsSync, readFileSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { test } from 'node:test';
import { HINT_CREDENTIALS, writeCredentialsFile } from '../../src/auth/credentials.js';
import type { Rung } from '../../src/auth/ladder.js';
import type { FullFailure, FullRung, FullRungInput } from '../../src/auth/rungs/full.js';
import { HINT_DOCTOR } from '../../src/auth/rungs/silent.js';
import { readSession, writeSession } from '../../src/auth/session.js';
import { createContext } from '../../src/cli/context.js';
import { EXIT_CODES } from '../../src/core/errors.js';
import {
  assertNoSecrets,
  fakeJwt,
  fakeSession,
  mintOkStep,
  promptStdin,
  secretsOf,
  tempRoot,
} from '../helpers/auth.js';
import { parseJson, runCli } from '../helpers/cli.js';
import { fakeTransport, type Step } from '../helpers/http.js';

const NOW = Date.parse('2026-09-02T10:00:00Z');
const NEW_JWT = fakeJwt({ exp: NOW / 1000 + 7200 });
const EMAIL = 'student@purdue.edu';
const PASSWORD = 'PASSWORD-SECRET-9f8e7d';
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

interface FakeFull {
  factory: (input: FullRungInput) => FullRung;
  inputs: FullRungInput[];
  attempts: () => number;
}

/** A full rung that returns `outcome` (a session, or null with `failure`) and records its input. */
function fakeFull(outcome: 'session' | FullFailure['kind']): FakeFull {
  const inputs: FullRungInput[] = [];
  let attempts = 0;
  const factory = (input: FullRungInput): FullRung => {
    inputs.push(input);
    const failure: FullFailure | null =
      outcome === 'session' ? null : { kind: outcome, reason: `fake ${outcome}` };
    return {
      kind: 'full',
      get failure() {
        return attempts === 0 ? null : failure;
      },
      attempt: async (rc) => {
        attempts += 1;
        if (outcome === 'session') return fakeSession();
        rc.warn?.(`fake ${outcome}`);
        input.announce?.('Type 72 into Authenticator on your phone');
        return null;
      },
    };
  };
  return { factory, inputs, attempts: () => attempts };
}

function countingSilent(): { rung: Rung; attempts: () => number } {
  let attempts = 0;
  return {
    rung: {
      kind: 'silent',
      attempt: async () => {
        attempts += 1;
        return null;
      },
    },
    attempts: () => attempts,
  };
}

function login(
  root: string,
  steps: Step[],
  full: FakeFull,
  extra: string[] = [],
  io: Parameters<typeof runCli>[1] = {},
) {
  const ft = fakeTransport(steps);
  const silent = countingSilent();
  return runCli(['--root', root, 'auth', 'login', ...extra], {
    transport: ft.transport,
    rungs: [silent.rung],
    fullRung: full.factory,
    env: { BS_EMAIL: EMAIL, BS_PASSWORD: PASSWORD },
    ...io,
  }).then((r) => ({ ...r, calls: ft.calls, silentAttempts: silent.attempts }));
}

test('auth login: credentials resolved, the full rung climbs, rung 0 mints, exit 0, status shape', async () => {
  const { root, paths } = tempRoot('bs-login-');
  try {
    const full = fakeFull('session');
    const r = await login(root, [mintOkStep(NEW_JWT)], full, ['--json']);
    assert.equal(r.code, EXIT_CODES.ok, r.stderr);
    const out = parseJson<StatusJson>(r.stdout);
    assert.deepEqual(Object.keys(out), STATUS_KEYS, 'same shape as auth status');
    assert.equal(out.state, 'fresh');
    assert.equal(out.baseUrl, 'https://purdue.brightspace.com');
    assert.equal(out.sessionFile, paths.sessionFile);
    assert.equal(full.inputs.length, 1, 'one full rung, built inside the command');
    assert.deepEqual(full.inputs[0]?.credentials, { email: EMAIL, password: PASSWORD });
    assert.equal(full.inputs[0]?.headed, false);
    assert.equal(full.attempts(), 1);
    assert.equal(r.silentAttempts(), 0, 'the silent rung is inside the full rung; never run twice');
    assert.equal(r.calls.length, 1, 'exactly one mint');
    assert.equal(readSession(paths)?.jwt, NEW_JWT);
    assert.equal(JSON.parse(readFileSync(paths.statusFile, 'utf8')).rungUsed, 'full');
    assert.equal(existsSync(paths.credentialsFile), false, 'no --save-credentials, no file');
    assert.equal(r.stderr, '');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('auth login --headed asks the full rung for a window', async () => {
  const { root } = tempRoot('bs-login-');
  try {
    const full = fakeFull('session');
    const r = await login(root, [mintOkStep(NEW_JWT)], full, ['--headed', '--json']);
    assert.equal(r.code, EXIT_CODES.ok, r.stderr);
    assert.equal(full.inputs[0]?.headed, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('auth login relays the MFA line to stderr as a plain line, not a warning', async () => {
  const { root } = tempRoot('bs-login-');
  try {
    const full = fakeFull('mfa-timeout');
    const r = await login(root, [], full, ['--json']);
    assert.equal(r.code, EXIT_CODES.auth_required);
    assert.ok(r.stderr.split('\n').includes('Type 72 into Authenticator on your phone'), r.stderr);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('auth login: the full rung fails → exit 4, status printed, hint specific to the failure', async () => {
  const cases: [FullFailure['kind'], RegExp, RegExp][] = [
    ['bad-password', /--save-credentials/, /password/i],
    ['mfa-timeout', /approve/i, /re-run/i],
    ['mfa-denied', /approve/i, /re-run/i],
    ['browser', new RegExp(HINT_DOCTOR), /doctor/],
    ['no-field', /--headed/, /doctor/],
    ['unknown-account', /email/i, /BS_EMAIL/],
  ];
  for (const [kind, first, second] of cases) {
    const { root, paths } = tempRoot('bs-login-');
    try {
      const full = fakeFull(kind);
      const r = await login(root, [], full, ['--json']);
      assert.equal(r.code, EXIT_CODES.auth_required, `${kind}: ${r.stderr}`);
      const out = parseJson<StatusJson>(r.stdout);
      assert.deepEqual(Object.keys(out), STATUS_KEYS);
      assert.equal(out.state, 'none');
      assert.match(r.stderr, first, kind);
      assert.match(r.stderr, second, kind);
      assert.equal(existsSync(paths.sessionFile), false);
      assert.equal(existsSync(paths.credentialsFile), false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test('auth login keeps an expired session when the full rung fails (never deletes state)', async () => {
  const { root, paths } = tempRoot('bs-login-');
  try {
    writeSession(
      paths,
      fakeSession({ jwt: fakeJwt({ exp: 1 }), jwtExpiresAt: '2020-01-01T00:00:00Z' }),
    );
    const before = readFileSync(paths.sessionFile, 'utf8');
    const full = fakeFull('mfa-timeout');
    const r = await login(
      root,
      [
        {
          status: 200,
          headers: { 'content-type': 'text/html' },
          body: '<html>sessionExpired=1</html>',
        },
      ],
      full,
      ['--json'],
    );
    assert.equal(r.code, EXIT_CODES.auth_required);
    assert.equal(parseJson<StatusJson>(r.stdout).state, 'expired');
    assert.equal(readFileSync(paths.sessionFile, 'utf8'), before);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('auth login non-interactive with no credentials: exit 4 fast, no browser, hint names the sources', async () => {
  const { root, paths } = tempRoot('bs-login-');
  try {
    const full = fakeFull('session');
    const r = await login(root, [], full, ['--json'], { env: {} });
    assert.equal(r.code, EXIT_CODES.auth_required);
    assert.equal(r.stdout, '', 'no status: nothing was attempted');
    assert.ok(r.stderr.includes(HINT_CREDENTIALS), r.stderr);
    assert.equal(full.inputs.length, 0, 'the full rung was never built');
    assert.equal(r.calls.length, 0);
    assert.equal(existsSync(paths.statusFile), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('auth login --no-input on a TTY with no credentials behaves like a non-TTY', async () => {
  const { root } = tempRoot('bs-login-');
  try {
    const full = fakeFull('session');
    const r = await login(root, [], full, ['--no-input'], {
      env: {},
      stdinIsTTY: true,
      stdin: promptStdin([`${EMAIL}\n`, `${PASSWORD}\n`]),
    });
    assert.equal(r.code, EXIT_CODES.auth_required);
    assert.equal(full.inputs.length, 0);
    assert.doesNotMatch(r.stderr, /email:/i, 'no prompt');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('auth login on a TTY prompts on stderr and never echoes the password', async () => {
  const { root } = tempRoot('bs-login-');
  try {
    const full = fakeFull('session');
    const r = await login(root, [mintOkStep(NEW_JWT)], full, ['--json'], {
      env: {},
      stdinIsTTY: true,
      stdin: promptStdin([`${EMAIL}\n`, `${PASSWORD}\n`]),
    });
    assert.equal(r.code, EXIT_CODES.ok, r.stderr);
    assert.match(r.stderr, /email/i);
    assert.match(r.stderr, /password/i);
    assert.deepEqual(full.inputs[0]?.credentials, { email: EMAIL, password: PASSWORD });
    assertNoSecrets(r.stderr, [PASSWORD], 'stderr');
    assertNoSecrets(r.stdout, [PASSWORD], 'stdout');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('auth login --email --password-stdin reads the password from stdin', async () => {
  const { root } = tempRoot('bs-login-');
  try {
    const full = fakeFull('session');
    const r = await login(
      root,
      [mintOkStep(NEW_JWT)],
      full,
      ['--email', EMAIL, '--password-stdin', '--json'],
      { env: {}, stdin: Readable.from([`${PASSWORD}\n`]) },
    );
    assert.equal(r.code, EXIT_CODES.ok, r.stderr);
    assert.deepEqual(full.inputs[0]?.credentials, { email: EMAIL, password: PASSWORD });
    assertNoSecrets(r.stderr, [PASSWORD], 'stderr');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('auth login with one env var alone is a config error (exit 10) before anything runs', async () => {
  const { root, paths } = tempRoot('bs-login-');
  try {
    const full = fakeFull('session');
    const r = await login(root, [], full, ['--json'], { env: { BS_EMAIL: EMAIL } });
    assert.equal(r.code, EXIT_CODES.config);
    assert.match(r.stderr, /BS_PASSWORD/);
    assert.equal(full.inputs.length, 0);
    assert.equal(existsSync(paths.profileDir), false, 'no state was created');
    assert.equal(existsSync(paths.statusFile), false, 'the ladder never ran');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('auth login --save-credentials writes credentials.json (0600) only after a successful login', async () => {
  const { root, paths } = tempRoot('bs-login-');
  try {
    const failed = await login(root, [], fakeFull('bad-password'), [
      '--save-credentials',
      '--json',
    ]);
    assert.equal(failed.code, EXIT_CODES.auth_required);
    assert.equal(existsSync(paths.credentialsFile), false, 'a failed login saves nothing');

    const ok = await login(root, [mintOkStep(NEW_JWT)], fakeFull('session'), [
      '--save-credentials',
      '--json',
    ]);
    assert.equal(ok.code, EXIT_CODES.ok, ok.stderr);
    assert.deepEqual(JSON.parse(readFileSync(paths.credentialsFile, 'utf8')), {
      email: EMAIL,
      password: PASSWORD,
    });
    assert.equal(statSync(paths.credentialsFile).mode & 0o777, 0o600);
    assert.match(ok.stderr, /credentials\.json/);
    assertNoSecrets(ok.stderr, [PASSWORD], 'stderr');

    // And the saved file is the source next time (no env, no prompt possible).
    const again = await login(root, [mintOkStep(NEW_JWT)], fakeFull('session'), ['--json'], {
      env: {},
    });
    assert.equal(again.code, EXIT_CODES.ok, again.stderr);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('auth login never prints a secret in any mode, even under --verbose', async () => {
  const { root, paths } = tempRoot('bs-login-');
  try {
    ensureCredentials(paths);
    const secrets = [...secretsOf(fakeSession()), NEW_JWT, PASSWORD];
    for (const flags of [['--json', '--verbose'], ['--verbose'], ['--plain', '--verbose']]) {
      const r = await login(root, [mintOkStep(NEW_JWT)], fakeFull('session'), flags, {
        env: {},
      });
      assert.equal(r.code, EXIT_CODES.ok, r.stderr);
      assertNoSecrets(r.stdout, secrets, `stdout (${flags.join(' ')})`);
      assertNoSecrets(r.stderr, secrets, `stderr (${flags.join(' ')})`);
      assert.ok(r.stderr.length > 0, 'verbose diagnostics were written');
    }
    const human = await login(root, [mintOkStep(NEW_JWT)], fakeFull('session'), [], { env: {} });
    assert.match(human.stdout, /^fresh\b/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function ensureCredentials(paths: ReturnType<typeof tempRoot>['paths']): void {
  writeCredentialsFile(paths, { email: EMAIL, password: PASSWORD });
}

test('the default context registers no full rung and no full-rung factory', () => {
  const ctx = createContext({ stdout: { write: () => true }, stderr: { write: () => true } });
  assert.deepEqual(
    ctx.rungs.map((r) => r.kind),
    ['silent'],
  );
  assert.equal(ctx.fullRung, undefined);
});

test('auth login --help and schema never create the state directory or need credentials', async () => {
  const { root } = tempRoot('bs-login-');
  const state = path.join(root, 'state');
  try {
    for (const argv of [
      ['auth', 'login', '--help'],
      ['schema', 'auth', 'login'],
    ]) {
      const r = await runCli(['--root', state, ...argv]);
      assert.equal(r.code, 0, argv.join(' '));
      assert.equal(existsSync(state), false, argv.join(' '));
    }
    const help = await runCli(['--root', state, 'auth', 'login', '--help']);
    for (const flag of ['--headed', '--email', '--password-stdin', '--save-credentials']) {
      assert.ok(help.stdout.includes(flag), flag);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
