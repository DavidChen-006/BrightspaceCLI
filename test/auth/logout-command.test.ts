import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { test } from 'node:test';
import { writeSession } from '../../src/auth/session.js';
import { SECRET_FILE_MODE, writeJsonAtomic } from '../../src/core/atomic.js';
import { EXIT_CODES } from '../../src/core/errors.js';
import { ensureDirs } from '../../src/core/paths.js';
import { fakeSession, tempRoot } from '../helpers/auth.js';
import { parseJson, runCli } from '../helpers/cli.js';

interface LogoutJson {
  removed: string[];
  profilePurged: boolean;
}

/** A root with everything logout may touch: session, status, mfa, a non-empty profile, config. */
function seed() {
  const t = tempRoot('bs-logout-');
  ensureDirs(t.paths);
  writeSession(t.paths, fakeSession());
  writeJsonAtomic(t.paths.statusFile, { state: 'fresh' }, { mode: SECRET_FILE_MODE });
  writeJsonAtomic(t.paths.mfaFile, { number: '42' }, { mode: SECRET_FILE_MODE });
  mkdirSync(path.join(t.paths.profileDir, 'Default'), { recursive: true });
  writeFileSync(path.join(t.paths.profileDir, 'Default', 'Cookies'), 'sqlite');
  writeFileSync(t.paths.configFile, '{}');
  return t;
}

function stillSeeded(t: ReturnType<typeof seed>, label: string) {
  assert.ok(existsSync(t.paths.sessionFile), `${label}: session.json kept`);
  assert.ok(existsSync(t.paths.statusFile), `${label}: status.json kept`);
  assert.ok(existsSync(t.paths.mfaFile), `${label}: mfa.json kept`);
  assert.ok(
    existsSync(path.join(t.paths.profileDir, 'Default', 'Cookies')),
    `${label}: profile kept`,
  );
}

test('logout on a non-TTY without --force is a usage error (exit 2) and deletes nothing', async () => {
  const t = seed();
  try {
    const r = await runCli(['--root', t.root, 'auth', 'logout', '--json']);
    assert.equal(r.code, EXIT_CODES.usage);
    assert.equal(r.stdout, '');
    assert.ok(r.stderr.includes('Re-run with --force'), r.stderr);
    stillSeeded(t, 'non-tty');
  } finally {
    rmSync(t.root, { recursive: true, force: true });
  }
});

test('logout --no-input on a TTY behaves like a non-TTY', async () => {
  const t = seed();
  try {
    const r = await runCli(['--root', t.root, '--no-input', 'auth', 'logout'], {
      stdinIsTTY: true,
      stdin: Readable.from(['y\n']),
    });
    assert.equal(r.code, EXIT_CODES.usage);
    assert.ok(r.stderr.includes('Re-run with --force'));
    stillSeeded(t, 'no-input');
  } finally {
    rmSync(t.root, { recursive: true, force: true });
  }
});

test('logout --force removes session.json, cache/status.json and cache/mfa.json but keeps profile/ and config.json', async () => {
  const t = seed();
  try {
    const r = await runCli(['--root', t.root, 'auth', 'logout', '--force', '--json']);
    assert.equal(r.code, EXIT_CODES.ok, r.stderr);
    const out = parseJson<LogoutJson>(r.stdout);
    assert.deepEqual(out, {
      removed: [t.paths.sessionFile, t.paths.statusFile, t.paths.mfaFile],
      profilePurged: false,
    });
    assert.equal(existsSync(t.paths.sessionFile), false);
    assert.equal(existsSync(t.paths.statusFile), false);
    assert.equal(existsSync(t.paths.mfaFile), false);
    assert.ok(existsSync(path.join(t.paths.profileDir, 'Default', 'Cookies')), 'profile kept');
    assert.ok(existsSync(t.paths.configFile), 'config.json kept');
    assert.equal(r.stderr, '');
  } finally {
    rmSync(t.root, { recursive: true, force: true });
  }
});

test('logout --force --purge-profile also removes profile/', async () => {
  const t = seed();
  try {
    const r = await runCli([
      '--root',
      t.root,
      'auth',
      'logout',
      '--force',
      '--purge-profile',
      '--json',
    ]);
    assert.equal(r.code, EXIT_CODES.ok, r.stderr);
    const out = parseJson<LogoutJson>(r.stdout);
    assert.equal(out.profilePurged, true);
    assert.deepEqual(out.removed, [t.paths.sessionFile, t.paths.statusFile, t.paths.mfaFile]);
    assert.equal(existsSync(t.paths.profileDir), false);
    assert.equal(existsSync(t.paths.sessionFile), false);
    assert.ok(existsSync(t.paths.configFile));
  } finally {
    rmSync(t.root, { recursive: true, force: true });
  }
});

test('logout is idempotent: nothing to remove is exit 0 with an empty list', async () => {
  const { root } = tempRoot('bs-logout-');
  const state = path.join(root, 'state');
  try {
    const r = await runCli([
      '--root',
      state,
      'auth',
      'logout',
      '--force',
      '--purge-profile',
      '--json',
    ]);
    assert.equal(r.code, EXIT_CODES.ok, r.stderr);
    assert.deepEqual(parseJson<LogoutJson>(r.stdout), { removed: [], profilePurged: false });
    assert.equal(existsSync(state), false, 'logout creates no state directory');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('logout on a TTY asks on stderr (y/N) and proceeds on y', async () => {
  const t = seed();
  try {
    const r = await runCli(['--root', t.root, 'auth', 'logout', '--purge-profile', '--json'], {
      stdinIsTTY: true,
      stdin: Readable.from(['Y\n']),
    });
    assert.equal(r.code, EXIT_CODES.ok, r.stderr);
    assert.match(r.stderr, /\[y\/N\]/);
    assert.match(r.stderr, /profile/);
    assert.equal(parseJson<LogoutJson>(r.stdout).profilePurged, true);
    assert.equal(existsSync(t.paths.sessionFile), false);
    assert.equal(existsSync(t.paths.profileDir), false);
  } finally {
    rmSync(t.root, { recursive: true, force: true });
  }
});

test('logout on a TTY treats anything but y/yes as a cancellation (exit 130) and deletes nothing', async () => {
  for (const answer of ['n\n', '\n', 'maybe\n', '']) {
    const t = seed();
    try {
      const r = await runCli(['--root', t.root, 'auth', 'logout', '--json'], {
        stdinIsTTY: true,
        stdin: Readable.from(answer === '' ? [] : [answer]),
      });
      assert.equal(r.code, EXIT_CODES.cancelled, JSON.stringify(answer));
      assert.equal(r.stdout, '');
      assert.match(r.stderr, /cancel/i);
      stillSeeded(t, JSON.stringify(answer));
    } finally {
      rmSync(t.root, { recursive: true, force: true });
    }
  }
});

test('logout --force human and --plain modes list what was removed', async () => {
  const t = seed();
  try {
    const plain = await runCli(['--root', t.root, 'auth', 'logout', '--force', '--plain']);
    assert.equal(plain.code, 0, plain.stderr);
    const lines = plain.stdout.trimEnd().split('\n');
    assert.equal(lines[0], 'kind\tpath');
    assert.equal(lines.length, 4);
    assert.ok(lines[1]?.startsWith(`file\t${t.paths.sessionFile}`));

    const human = await runCli(['--root', t.root, 'auth', 'logout', '--force', '--purge-profile']);
    assert.equal(human.code, 0, human.stderr);
    assert.match(human.stdout, /profile/);
    assert.equal(readFileSync(t.paths.configFile, 'utf8'), '{}');
  } finally {
    rmSync(t.root, { recursive: true, force: true });
  }
});

test('refresh/logout help and schema still never create the state directory', async () => {
  const { root } = tempRoot('bs-logout-');
  const state = path.join(root, 'state');
  try {
    for (const argv of [
      ['auth', 'refresh', '--help'],
      ['auth', 'logout', '--help'],
      ['schema', 'auth', 'logout'],
      ['schema', 'auth', 'refresh'],
    ]) {
      const r = await runCli(['--root', state, ...argv]);
      assert.equal(r.code, 0, argv.join(' '));
      assert.equal(existsSync(state), false, argv.join(' '));
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
