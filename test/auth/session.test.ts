import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { test } from 'node:test';
import {
  buildCookieHeader,
  buildSession,
  deleteSession,
  JWT_FALLBACK_TTL_MS,
  JWT_SKEW_MS,
  jwtExpiry,
  jwtIsFresh,
  readSession,
  writeSession,
} from '../../src/auth/session.js';
import {
  COOKIE_VALUE,
  fakeJwt,
  fakeSession,
  SECURE_COOKIE_VALUE,
  tempRoot,
} from '../helpers/auth.js';

const posix = process.platform !== 'win32';

test('buildCookieHeader: d2lSessionVal, then d2lSecureSessionVal, then the rest in input order', () => {
  const header = buildCookieHeader([
    { name: 'zeta', value: 'z' },
    { name: 'd2lSecureSessionVal', value: SECURE_COOKIE_VALUE },
    { name: 'alpha', value: 'a' },
    { name: 'd2lSessionVal', value: COOKIE_VALUE },
  ]);
  assert.equal(
    header,
    `d2lSessionVal=${COOKIE_VALUE}; d2lSecureSessionVal=${SECURE_COOKIE_VALUE}; zeta=z; alpha=a`,
  );
  assert.equal(buildCookieHeader([]), '');
});

test('buildSession stamps capturedAt as whole-second ISO and derives cookieHeader', () => {
  const session = buildSession({
    baseUrl: 'https://purdue.brightspace.com/',
    cookies: [{ name: 'd2lSessionVal', value: 'v' }],
    csrfToken: 'x',
    landedUrl: 'https://purdue.brightspace.com/d2l/home',
    capturedAt: Date.parse('2026-09-02T10:00:00.123Z'),
  });
  assert.equal(session.capturedAt, '2026-09-02T10:00:00Z');
  assert.equal(session.baseUrl, 'https://purdue.brightspace.com');
  assert.equal(session.cookieHeader, 'd2lSessionVal=v');
  assert.equal(session.jwt, undefined);
});

test('writeSession/readSession round-trip, atomic with no temp debris, 0600 file in a 0700 root', () => {
  const { root, paths } = tempRoot();
  try {
    const session = fakeSession({ jwt: fakeJwt({ exp: 1 }), jwtExpiresAt: '2026-09-02T11:00:00Z' });
    writeSession(paths, session);
    assert.deepEqual(readSession(paths), session);
    assert.deepEqual(
      readdirSync(root).filter((f) => f.endsWith('.tmp')),
      [],
      'temp file left behind',
    );
    if (posix) {
      assert.equal(statSync(paths.sessionFile).mode & 0o777, 0o600);
      assert.equal(statSync(root).mode & 0o777, 0o700);
      assert.equal(statSync(paths.cacheDir).mode & 0o777, 0o700);
    }
    // A second write replaces the file whole (rename), keeping the mode.
    writeSession(paths, { ...session, jwt: undefined, jwtExpiresAt: undefined });
    assert.equal(readSession(paths)?.jwt, undefined);
    if (posix) assert.equal(statSync(paths.sessionFile).mode & 0o777, 0o600);
    assert.ok(readFileSync(paths.sessionFile, 'utf8').endsWith('\n'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('readSession: missing, corrupt, non-object or structurally invalid files read as null', () => {
  const { root, paths } = tempRoot();
  try {
    assert.equal(readSession(paths), null);
    mkdirSync(root, { recursive: true });
    for (const text of ['', '{', '[]', 'null', '42', '{"baseUrl":"https://x"}', '{"cookies":[]}']) {
      writeFileSync(paths.sessionFile, text);
      assert.equal(readSession(paths), null, JSON.stringify(text));
    }
    // A directory in place of the file is "absent" too, never a throw.
    rmSync(paths.sessionFile);
    mkdirSync(paths.sessionFile);
    assert.equal(readSession(paths), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('readSession tolerates a Brightspace-Bar style file (numeric capturedAt, no jwt)', () => {
  const { root, paths } = tempRoot();
  try {
    mkdirSync(root, { recursive: true });
    writeFileSync(
      paths.sessionFile,
      JSON.stringify({
        capturedAt: Date.parse('2026-09-02T10:00:00Z'),
        baseUrl: 'https://purdue.brightspace.com',
        cookieHeader: 'd2lSessionVal=a; d2lSecureSessionVal=b',
        cookies: [
          { name: 'd2lSessionVal', value: 'a' },
          { name: 'd2lSecureSessionVal', value: 'b' },
        ],
        csrfToken: 'x',
        landedUrl: 'https://purdue.brightspace.com/d2l/home',
      }),
    );
    const session = readSession(paths);
    assert.ok(session);
    assert.equal(session.capturedAt, '2026-09-02T10:00:00Z');
    assert.equal(session.jwt, undefined);
    assert.equal(session.jwtExpiresAt, undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('deleteSession removes the file and is a no-op when absent', () => {
  const { root, paths } = tempRoot();
  try {
    deleteSession(paths);
    writeSession(paths, fakeSession());
    assert.ok(existsSync(paths.sessionFile));
    deleteSession(paths);
    assert.equal(existsSync(paths.sessionFile), false);
    deleteSession(paths);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('jwtExpiry decodes exp with 60 s skew and falls back to now + 3600 s', () => {
  const now = Date.parse('2026-09-02T10:00:00Z');
  const exp = Math.floor(now / 1000) + 3000;
  assert.equal(JWT_SKEW_MS, 60_000);
  assert.equal(JWT_FALLBACK_TTL_MS, 3_600_000);
  assert.equal(jwtExpiry(fakeJwt({ exp }), { now }), exp * 1000 - JWT_SKEW_MS);
  // base64url payloads that would need padding still decode.
  assert.equal(jwtExpiry(fakeJwt({ exp, sub: 'a' }), { now }), exp * 1000 - JWT_SKEW_MS);
  for (const bad of ['', 'garbage', 'a.b', 'a.!!!.c', fakeJwt({}), fakeJwt({ exp: 'soon' })]) {
    assert.equal(jwtExpiry(bad, { now }), now + JWT_FALLBACK_TTL_MS, JSON.stringify(bad));
  }
  // A payload that is valid base64url but not a JSON object.
  assert.equal(
    jwtExpiry(`x.${Buffer.from('[1]').toString('base64url')}.y`, { now }),
    now + JWT_FALLBACK_TTL_MS,
  );
  // An explicit fallback (the mint's expires_in) is honored, with skew.
  assert.equal(jwtExpiry('garbage', { now, fallbackSeconds: 120 }), now + 120_000 - JWT_SKEW_MS);
});

test('jwtIsFresh needs a jwt and a parseable jwtExpiresAt in the future', () => {
  const now = Date.parse('2026-09-02T10:00:00Z');
  const jwt = fakeJwt({ exp: 1 });
  assert.equal(jwtIsFresh(fakeSession(), now), false);
  assert.equal(jwtIsFresh(fakeSession({ jwt }), now), false);
  assert.equal(jwtIsFresh(fakeSession({ jwt, jwtExpiresAt: 'never' }), now), false);
  assert.equal(jwtIsFresh(fakeSession({ jwt, jwtExpiresAt: '2026-09-02T09:59:59Z' }), now), false);
  assert.equal(jwtIsFresh(fakeSession({ jwt, jwtExpiresAt: '2026-09-02T10:00:00Z' }), now), false);
  assert.equal(jwtIsFresh(fakeSession({ jwt, jwtExpiresAt: '2026-09-02T10:00:01Z' }), now), true);
  assert.equal(
    jwtIsFresh(fakeSession({ jwt: '', jwtExpiresAt: '2026-09-02T10:00:01Z' }), now),
    false,
  );
});
