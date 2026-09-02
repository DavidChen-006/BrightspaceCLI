import assert from 'node:assert/strict';
import { existsSync, readFileSync, rmSync, statSync } from 'node:fs';
import { test } from 'node:test';
import type { RungContext } from '../../src/auth/ladder.js';
import {
  DISPLAY_SIGN_SELECTOR,
  FIELD_POLL_MS,
  FIELD_TIMEOUT_MS,
  type FullRungInput,
  fullRung,
  MFA_POLL_MS,
  MFA_TIMEOUT_MS,
  type MfaRelay,
  mfaPrompt,
  readMfaFile,
  writeMfaFile,
} from '../../src/auth/rungs/full.js';
import { HINT_DOCTOR } from '../../src/auth/rungs/silent.js';
import { SECRET_FILE_MODE, writeJsonAtomic } from '../../src/core/atomic.js';
import { DEFAULT_CONFIG } from '../../src/core/config.js';
import { CancelledError } from '../../src/core/errors.js';
import { ensureDirs } from '../../src/core/paths.js';
import { assertNoSecrets, tempRoot } from '../helpers/auth.js';
import {
  ALL_COOKIES,
  emailSurface,
  entraChain,
  entraEmailSurface,
  entraPasswordSurface,
  FakeBrowser,
  homeSurface,
  loginSurface,
  mfaErrorSurface,
  mfaSurface,
  passwordErrorSurface,
  silentChain,
  XSRF_VIA_JS,
  XSRF_VIA_META,
} from '../helpers/browser.js';
import { collectLog } from '../helpers/http.js';

const NOW = Date.parse('2026-09-02T10:00:00Z');
const EMAIL = 'student@purdue.edu';
const PASSWORD = 'PASSWORD-SECRET-9f8e7d';
const SECRETS = [...ALL_COOKIES.map((c) => c.value), XSRF_VIA_JS, XSRF_VIA_META, PASSWORD];

function harness(surfaces = entraChain(), input: Partial<FullRungInput> = {}) {
  const root = tempRoot('bs-full-');
  const fb = new FakeBrowser(surfaces, { now: NOW });
  const log = collectLog();
  const warns: string[] = [];
  const announced: string[] = [];
  /** What cache/mfa.json held at the moment of each announcement. */
  const relays: (MfaRelay | null)[] = [];
  const rung = fullRung(
    {
      credentials: { email: EMAIL, password: PASSWORD },
      announce: (line) => {
        announced.push(line);
        relays.push(readMfaFile(root.paths));
      },
      ...input,
    },
    { importer: fb.importer(), now: () => fb.now },
  );
  const ctx: RungContext = {
    paths: root.paths,
    config: DEFAULT_CONFIG,
    log: log.log,
    warn: (line) => warns.push(line),
  };
  return {
    root,
    fb,
    log,
    warns,
    announced,
    relays,
    rung,
    ctx,
    done: () => rmSync(root.root, { recursive: true, force: true }),
  };
}

test('constants match PRD 7 rung 2: 250 ms x 30 s per field, 2 s x 5 min for the number-match', () => {
  assert.equal(FIELD_POLL_MS, 250);
  assert.equal(FIELD_TIMEOUT_MS, 30_000);
  assert.equal(MFA_POLL_MS, 2_000);
  assert.equal(MFA_TIMEOUT_MS, 300_000);
  assert.equal(DISPLAY_SIGN_SELECTOR, '#idRichContext_DisplaySign');
  assert.equal(mfaPrompt('72'), 'Type 72 into Authenticator on your phone');
});

test('full rung: silent fails on the email prompt, then email → next → password → sign in → number-match → KMSI → home', async () => {
  const h = harness();
  try {
    assert.equal(h.rung.kind, 'full');
    const session = await h.rung.attempt(h.ctx);
    assert.ok(session, h.warns.join('\n'));
    assert.equal(session.csrfToken, XSRF_VIA_JS);
    assert.deepEqual(
      session.cookies.map((c) => c.name),
      ['d2lSecureSessionVal', 'd2lSessionVal'],
    );
    assert.equal(h.rung.failure, null);
    // Headless by default, on the persistent profile.
    assert.deepEqual(h.fb.launches, [
      { dir: h.root.paths.profileDir, options: { headless: true, channel: 'chromium' } },
    ]);
    assert.equal(h.fb.closed, 1);
    // The email went into an email field and the password into a password field.
    assert.equal(h.fb.filled.length, 2);
    assert.match(h.fb.filled[0]?.selector ?? '', /email|loginfmt|i0116/);
    assert.equal(h.fb.filled[0]?.value, EMAIL);
    assert.match(h.fb.filled[1]?.selector ?? '', /password|passwd|i0118/);
    assert.equal(h.fb.filled[1]?.value, PASSWORD);
    // Next, Sign in, then Yes on the proven KMSI page: three primary-button clicks, no more.
    assert.deepEqual(
      h.fb.clicks.filter((c) => c.includes('#idSIButton9')).length,
      3,
      h.fb.clicks.join(','),
    );
    // Both numbers announced, each once, in order, with mfa.json written BEFORE the line.
    assert.deepEqual(
      h.announced.filter((l) => l.startsWith('Type ')),
      [mfaPrompt('72'), mfaPrompt('68')],
    );
    const relays = h.relays.filter((r): r is MfaRelay => r !== null);
    assert.deepEqual(
      relays.map((r) => r.number),
      ['72', '68'],
    );
    assert.match(relays[0]?.mintedAt ?? '', /^2026-09-02T10:00:\d\dZ$/);
    // Cleared in finally.
    assert.equal(existsSync(h.root.paths.mfaFile), false);
    // The number-match poll keeps its 2 s rhythm.
    assert.ok(h.fb.calls.includes(`wait ${MFA_POLL_MS}`));
    // The password is nowhere near a log line or a warning.
    assertNoSecrets(h.log.lines.join('\n'), SECRETS, 'log');
    assertNoSecrets(h.warns.join('\n'), SECRETS, 'warn');
    assertNoSecrets(h.announced.join('\n'), SECRETS, 'announce');
    assert.ok(h.log.lines.some((l) => /password/.test(l) && !l.includes(PASSWORD)));
  } finally {
    h.done();
  }
});

test('full rung: mfa.json is written atomically, mode 0600, {number, mintedAt}, and read back', () => {
  const root = tempRoot('bs-full-');
  try {
    ensureDirs(root.paths);
    writeMfaFile(root.paths, { number: '42', mintedAt: '2026-09-02T10:00:00Z' });
    assert.equal(statSync(root.paths.mfaFile).mode & 0o777, SECRET_FILE_MODE);
    assert.deepEqual(JSON.parse(readFileSync(root.paths.mfaFile, 'utf8')), {
      number: '42',
      mintedAt: '2026-09-02T10:00:00Z',
    });
    assert.deepEqual(readMfaFile(root.paths), { number: '42', mintedAt: '2026-09-02T10:00:00Z' });
    writeJsonAtomic(root.paths.mfaFile, { number: 7 }, { mode: SECRET_FILE_MODE });
    assert.equal(readMfaFile(root.paths), null);
  } finally {
    rmSync(root.root, { recursive: true, force: true });
  }
});

test('full rung: a stale mfa.json is cleared before the browser launches', async () => {
  const h = harness(silentChain());
  try {
    ensureDirs(h.root.paths);
    writeMfaFile(h.root.paths, { number: '11', mintedAt: '2026-09-02T09:00:00Z' });
    let atLaunch: boolean | undefined;
    const importer = h.fb.importer();
    const rung = fullRung(
      { credentials: { email: EMAIL, password: PASSWORD } },
      {
        importer: async () => {
          atLaunch = existsSync(h.root.paths.mfaFile);
          return importer();
        },
        now: () => h.fb.now,
      },
    );
    assert.ok(await rung.attempt(h.ctx));
    assert.equal(atLaunch, false, 'cleared before the attempt');
    assert.equal(existsSync(h.root.paths.mfaFile), false);
  } finally {
    h.done();
  }
});

test('full rung: the silent path succeeding short-circuits the Entra steps (credentials untouched)', async () => {
  const h = harness(silentChain());
  try {
    const session = await h.rung.attempt(h.ctx);
    assert.ok(session);
    assert.deepEqual(h.fb.filled, []);
    assert.deepEqual(
      h.announced.filter((l) => l.startsWith('Type ')),
      [],
    );
    assert.equal(h.fb.clicks.filter((c) => c.includes('#idSIButton9')).length, 1, 'KMSI Yes');
  } finally {
    h.done();
  }
});

test('full rung: headed: true opens a visible window', async () => {
  const h = harness(entraChain(), { headed: true });
  try {
    assert.ok(await h.rung.attempt(h.ctx));
    assert.equal(h.fb.launches[0]?.options.headless, false);
  } finally {
    h.done();
  }
});

test('full rung: the 5-minute number-match deadline on the fake clock → null, mfa-timeout, warn, mfa.json cleared', async () => {
  const h = harness([
    loginSurface('email'),
    entraEmailSurface('password'),
    entraPasswordSurface('mfa'),
    mfaSurface('mfa', '72'),
  ]);
  try {
    assert.equal(await h.rung.attempt(h.ctx), null);
    assert.equal(h.rung.failure?.kind, 'mfa-timeout');
    assert.equal(h.warns.length, 1);
    assert.match(h.warns[0] ?? '', /5 min|300/);
    assert.deepEqual(
      h.announced.filter((l) => l.startsWith('Type ')),
      [mfaPrompt('72')],
      'announced once, not every 2 s',
    );
    const polls = h.fb.calls.filter((c) => c === `wait ${MFA_POLL_MS}`).length;
    assert.ok(polls >= MFA_TIMEOUT_MS / MFA_POLL_MS, `polls=${polls}`);
    assert.ok(polls <= MFA_TIMEOUT_MS / MFA_POLL_MS + 1, `polls=${polls}`);
    assert.equal(existsSync(h.root.paths.mfaFile), false);
    assert.equal(h.fb.closed, 1);
  } finally {
    h.done();
  }
});

test('full rung: the wrong-password surface → null, bad-password, one warn line without the password', async () => {
  const h = harness([
    loginSurface('email'),
    entraEmailSurface('password'),
    entraPasswordSurface('password-error'),
    passwordErrorSurface(),
  ]);
  try {
    assert.equal(await h.rung.attempt(h.ctx), null);
    assert.equal(h.rung.failure?.kind, 'bad-password');
    assert.equal(h.warns.length, 1);
    assert.match(h.warns[0] ?? '', /password/i);
    assertNoSecrets(h.warns.join('\n'), SECRETS, 'warn');
    assert.ok(h.fb.waits < 10, 'fails promptly, not after the 5-minute budget');
  } finally {
    h.done();
  }
});

test('full rung: the request-denied / expired surface → null, mfa-denied', async () => {
  const h = harness([
    loginSurface('email'),
    entraEmailSurface('password'),
    entraPasswordSurface('mfa'),
    mfaSurface('mfa', '72', { count: 2, next: 'mfa-error' }),
    mfaErrorSurface(),
  ]);
  try {
    assert.equal(await h.rung.attempt(h.ctx), null);
    assert.equal(h.rung.failure?.kind, 'mfa-denied');
    assert.equal(h.warns.length, 1);
    assert.match(h.warns[0] ?? '', /denied|expired|hear from you/i);
  } finally {
    h.done();
  }
});

test('full rung: a field that never appears fails after the 30 s budget, not the MFA one', async () => {
  const h = harness([loginSurface('email'), emailSurface()]);
  try {
    // Email fills, Next is clicked, but nothing ever changes: no password field arrives.
    assert.equal(await h.rung.attempt(h.ctx), null);
    assert.equal(h.rung.failure?.kind, 'no-field');
    assert.equal(h.warns.length, 1);
    assert.match(h.warns[0] ?? '', /password/i);
    const polls = h.fb.calls.filter((c) => c === `wait ${FIELD_POLL_MS}`).length;
    assert.ok(polls >= FIELD_TIMEOUT_MS / FIELD_POLL_MS, `polls=${polls}`);
    assert.ok(polls <= FIELD_TIMEOUT_MS / FIELD_POLL_MS + 1, `polls=${polls}`);
    assert.equal(h.fb.filled.length, 1, 'the password was never typed anywhere');
  } finally {
    h.done();
  }
});

test('full rung: no browser → null, failure browser, the doctor hint on warn', async () => {
  const h = harness();
  try {
    const importError = Object.assign(new Error("Cannot find package 'playwright-core'"), {
      code: 'ERR_MODULE_NOT_FOUND',
    });
    const rung = fullRung(
      { credentials: { email: EMAIL, password: PASSWORD } },
      { importer: h.fb.importer({ importError }) },
    );
    assert.equal(await rung.attempt(h.ctx), null);
    assert.equal(rung.failure?.kind, 'browser');
    assert.ok(h.warns[0]?.includes(HINT_DOCTOR), h.warns.join('\n'));
  } finally {
    h.done();
  }
});

test('full rung: an authenticated page without an XSRF token is a failure, not a session', async () => {
  const h = harness([
    loginSurface('email'),
    entraEmailSurface('password'),
    entraPasswordSurface('home'),
    homeSurface({ xsrfJs: null, xsrfMeta: null }),
  ]);
  try {
    assert.equal(await h.rung.attempt(h.ctx), null);
    assert.equal(h.rung.failure?.kind, 'no-xsrf');
  } finally {
    h.done();
  }
});

test('full rung lets cancellation through and still clears mfa.json', async () => {
  const h = harness();
  try {
    ensureDirs(h.root.paths);
    writeMfaFile(h.root.paths, { number: '11', mintedAt: '2026-09-02T09:00:00Z' });
    const rung = fullRung(
      { credentials: { email: EMAIL, password: PASSWORD } },
      { importer: h.fb.importer({ launchError: new CancelledError() }) },
    );
    await assert.rejects(rung.attempt(h.ctx), (err: unknown) => err instanceof CancelledError);
    assert.equal(existsSync(h.root.paths.mfaFile), false);
  } finally {
    h.done();
  }
});
