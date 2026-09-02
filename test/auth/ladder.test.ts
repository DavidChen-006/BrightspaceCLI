import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  authorizedHttp,
  climb,
  HINT_LOGIN,
  HINT_REFRESH,
  type LadderStatus,
  type Rung,
  type RungContext,
  readStatus,
  retryOnceOnSessionExpired,
} from '../../src/auth/ladder.js';
import { readSession, type Session, writeSession } from '../../src/auth/session.js';
import { createContext } from '../../src/cli/context.js';
import { DEFAULT_CONFIG } from '../../src/core/config.js';
import { AuthRequiredError, RetryableError } from '../../src/core/errors.js';
import { createHttp, type HttpClient } from '../../src/core/http/index.js';
import {
  assertNoSecrets,
  expiredStubStep,
  fakeJwt,
  fakeSession,
  mintOkStep,
  secretsOf,
  tempRoot,
} from '../helpers/auth.js';
import { collectLog, fakeSleep, fakeTransport, jsonStep, type Step } from '../helpers/http.js';

const NOW = Date.parse('2026-09-02T10:00:00Z');
const FRESH_JWT = fakeJwt({ exp: NOW / 1000 + 3600 });
const STALE_JWT = fakeJwt({ exp: NOW / 1000 - 10 });
const NEW_JWT = fakeJwt({ exp: NOW / 1000 + 7200, iat: NOW / 1000 });

function harness(steps: Step[]) {
  const ft = fakeTransport(steps);
  const lg = collectLog();
  const http = createHttp({
    transport: ft.transport,
    sleep: fakeSleep().sleep,
    log: lg.log,
    verbose: true,
    clock: () => NOW,
  });
  const { root, paths } = tempRoot();
  const input = {
    paths,
    http,
    config: DEFAULT_CONFIG,
    log: lg.log,
    now: () => NOW,
  };
  return {
    ft,
    lg,
    http,
    root,
    paths,
    input,
    done: () => rmSync(root, { recursive: true, force: true }),
  };
}

function rung(kind: Rung['kind'], behaviour: (ctx: RungContext) => Promise<Session | null>) {
  const calls: RungContext[] = [];
  const r: Rung = {
    kind,
    attempt: async (ctx) => {
      calls.push(ctx);
      return behaviour(ctx);
    },
  };
  return { rung: r, calls };
}

function statusOf(paths: { statusFile: string }): LadderStatus {
  return JSON.parse(readFileSync(paths.statusFile, 'utf8')) as LadderStatus;
}

test('no session and no rungs: state none, login hint, status.json written, nothing else created', async () => {
  const h = harness([]);
  try {
    const result = await climb(h.input);
    assert.equal(result.state, 'none');
    if (result.state === 'none') {
      assert.equal(result.hint, HINT_LOGIN);
      assert.equal(result.session, null);
    }
    assert.equal(h.ft.calls.length, 0);
    assert.equal(existsSync(h.paths.sessionFile), false);
    const status = statusOf(h.paths);
    assert.equal(status.state, 'none');
    assert.equal(status.checkedAt, '2026-09-02T10:00:00Z');
    assert.equal(status.baseUrl, null);
    assert.equal(status.capturedAt, null);
    assert.equal(status.jwtExpiresAt, null);
    assert.equal(typeof status.lastError, 'string');
    if (process.platform !== 'win32') {
      assert.equal(statSync(h.paths.statusFile).mode & 0o777, 0o600);
    }
    assert.deepEqual(readStatus(h.paths), status);
  } finally {
    h.done();
  }
});

test('a fresh cached JWT is used without any HTTP call', async () => {
  const h = harness([]);
  try {
    const session = fakeSession({ jwt: FRESH_JWT, jwtExpiresAt: '2026-09-02T10:59:00Z' });
    writeSession(h.paths, session);
    const result = await climb(h.input);
    assert.equal(result.state, 'fresh');
    if (result.state === 'fresh') {
      assert.equal(result.session.jwt, FRESH_JWT);
      assert.equal(result.rungUsed, 'none');
    }
    assert.equal(h.ft.calls.length, 0);
    const status = statusOf(h.paths);
    assert.equal(status.state, 'fresh');
    assert.equal(status.baseUrl, session.baseUrl);
    assert.equal(status.capturedAt, session.capturedAt);
    assert.equal(status.jwtExpiresAt, session.jwtExpiresAt);
    assert.equal(status.lastError, null);
  } finally {
    h.done();
  }
});

test('a stale JWT is re-minted through rung 0 and the new token is persisted', async () => {
  const h = harness([mintOkStep(NEW_JWT)]);
  try {
    writeSession(h.paths, fakeSession({ jwt: STALE_JWT, jwtExpiresAt: '2026-09-02T09:00:00Z' }));
    const result = await climb(h.input);
    assert.equal(result.state, 'fresh');
    if (result.state === 'fresh') assert.equal(result.session.jwt, NEW_JWT);
    assert.equal(h.ft.calls.length, 1);
    const onDisk = readSession(h.paths);
    assert.equal(onDisk?.jwt, NEW_JWT);
    assert.equal(onDisk?.jwtExpiresAt, '2026-09-02T11:59:00Z');
    assert.equal(statusOf(h.paths).jwtExpiresAt, '2026-09-02T11:59:00Z');
  } finally {
    h.done();
  }
});

test('forceMint skips the fresh-JWT shortcut', async () => {
  const h = harness([mintOkStep(NEW_JWT)]);
  try {
    writeSession(h.paths, fakeSession({ jwt: FRESH_JWT, jwtExpiresAt: '2026-09-02T10:59:00Z' }));
    const result = await climb({ ...h.input, forceMint: true });
    assert.equal(result.state, 'fresh');
    assert.equal(h.ft.calls.length, 1);
    assert.equal(readSession(h.paths)?.jwt, NEW_JWT);
  } finally {
    h.done();
  }
});

test('expired mint with no rungs: state expired, refresh hint, session.json byte-identical', async () => {
  const h = harness([expiredStubStep]);
  try {
    writeSession(h.paths, fakeSession({ jwt: STALE_JWT, jwtExpiresAt: '2026-09-02T09:00:00Z' }));
    const before = readFileSync(h.paths.sessionFile, 'utf8');
    const result = await climb(h.input);
    assert.equal(result.state, 'expired');
    if (result.state === 'expired') {
      assert.equal(result.hint, HINT_REFRESH);
      assert.equal(result.retryable, false);
      assert.equal(result.session?.jwt, STALE_JWT);
    }
    assert.equal(readFileSync(h.paths.sessionFile, 'utf8'), before);
    assert.ok(existsSync(h.paths.profileDir));
    const status = statusOf(h.paths);
    assert.equal(status.state, 'expired');
    assert.match(status.lastError ?? '', /expired/);
    assert.equal(status.jwtExpiresAt, '2026-09-02T09:00:00Z');
  } finally {
    h.done();
  }
});

test('mint transport failure: expired with retryable, rungs are not walked, session untouched', async () => {
  const h = harness([{ status: 502, body: 'Bad Gateway' }]);
  try {
    writeSession(h.paths, fakeSession());
    const before = readFileSync(h.paths.sessionFile, 'utf8');
    const silent = rung('silent', async () => fakeSession());
    const result = await climb({ ...h.input, rungs: [silent.rung] });
    assert.equal(result.state, 'expired');
    if (result.state === 'expired') {
      assert.equal(result.retryable, true);
      assert.match(result.reason, /502/);
    }
    assert.equal(silent.calls.length, 0);
    assert.equal(readFileSync(h.paths.sessionFile, 'utf8'), before);
    assert.match(statusOf(h.paths).lastError ?? '', /502/);
  } finally {
    h.done();
  }
});

test('silent rung restores the session: persisted, minted, fresh with rungUsed silent', async () => {
  const h = harness([expiredStubStep, mintOkStep(NEW_JWT)]);
  try {
    writeSession(h.paths, fakeSession({ csrfToken: 'OLD-CSRF' }));
    const restored = fakeSession({ csrfToken: 'NEW-CSRF', capturedAt: '2026-09-02T10:00:00Z' });
    const silent = rung('silent', async () => restored);
    const result = await climb({ ...h.input, rungs: [silent.rung] });
    assert.equal(result.state, 'fresh');
    if (result.state === 'fresh') {
      assert.equal(result.rungUsed, 'silent');
      assert.equal(result.session.jwt, NEW_JWT);
      assert.equal(result.session.csrfToken, 'NEW-CSRF');
    }
    assert.equal(silent.calls.length, 1);
    assert.equal(silent.calls[0]?.paths, h.paths);
    assert.equal(silent.calls[0]?.config, DEFAULT_CONFIG);
    assert.equal(h.ft.calls.length, 2);
    assert.equal(h.ft.calls[1]?.headers['x-csrf-token'], 'NEW-CSRF');
    const onDisk = readSession(h.paths);
    assert.equal(onDisk?.csrfToken, 'NEW-CSRF');
    assert.equal(onDisk?.jwt, NEW_JWT);
    assert.equal(statusOf(h.paths).state, 'fresh');
  } finally {
    h.done();
  }
});

test('with no session at all, a silent rung still restores it (Tier 1)', async () => {
  const h = harness([mintOkStep(NEW_JWT)]);
  try {
    const silent = rung('silent', async () => fakeSession());
    const result = await climb({ ...h.input, rungs: [silent.rung] });
    assert.equal(result.state, 'fresh');
    assert.equal(silent.calls.length, 1);
    assert.equal(h.ft.calls.length, 1);
    assert.equal(readSession(h.paths)?.jwt, NEW_JWT);
  } finally {
    h.done();
  }
});

test('the full rung is skipped unless allowFull, and used when allowed', async () => {
  const h = harness([mintOkStep(NEW_JWT)]);
  try {
    const full = rung('full', async () => fakeSession());
    const skipped = await climb({ ...h.input, rungs: [full.rung] });
    assert.equal(skipped.state, 'none');
    if (skipped.state === 'none') assert.equal(skipped.hint, HINT_LOGIN);
    assert.equal(full.calls.length, 0);
    assert.ok(h.lg.lines.some((l) => /skipping rung 1 \(full\)/.test(l)));

    const used = await climb({ ...h.input, rungs: [full.rung], allowFull: true });
    assert.equal(used.state, 'fresh');
    if (used.state === 'fresh') assert.equal(used.rungUsed, 'full');
    assert.equal(full.calls.length, 1);
  } finally {
    h.done();
  }
});

test('a rung that throws or returns null is a failed rung; the ladder continues in order', async () => {
  const h = harness([expiredStubStep, mintOkStep(NEW_JWT)]);
  try {
    writeSession(h.paths, fakeSession({ jwt: STALE_JWT, jwtExpiresAt: '2026-09-02T09:00:00Z' }));
    const before = readFileSync(h.paths.sessionFile, 'utf8');
    const order: string[] = [];
    const thrower = rung('silent', async () => {
      order.push('thrower');
      throw new Error('browser exploded');
    });
    const empty = rung('silent', async () => {
      order.push('empty');
      return null;
    });
    // Only the throwing and the empty rung: the ladder is exhausted and the session survives.
    const failed = await climb({ ...h.input, rungs: [thrower.rung, empty.rung] });
    assert.equal(failed.state, 'expired');
    if (failed.state === 'expired') assert.equal(failed.hint, HINT_LOGIN);
    assert.deepEqual(order, ['thrower', 'empty']);
    assert.equal(readFileSync(h.paths.sessionFile, 'utf8'), before);
    assert.ok(existsSync(h.paths.profileDir));
    assert.ok(h.lg.lines.some((l) => /rung 1 \(silent\) threw: browser exploded/.test(l)));
    assert.equal(statusOf(h.paths).state, 'expired');

    // Add a working rung after them: it is reached.
    const working = rung('full', async () => fakeSession());
    const ok = await climb({
      ...h.input,
      http: createHttp({
        transport: fakeTransport([expiredStubStep, mintOkStep(NEW_JWT)]).transport,
        sleep: fakeSleep().sleep,
      }),
      rungs: [thrower.rung, empty.rung, working.rung],
      allowFull: true,
    });
    assert.equal(ok.state, 'fresh');
    if (ok.state === 'fresh') assert.equal(ok.rungUsed, 'full');
  } finally {
    h.done();
  }
});

test('a rung whose session still mints expired keeps the ladder climbing', async () => {
  const h = harness([expiredStubStep, expiredStubStep, mintOkStep(NEW_JWT)]);
  try {
    writeSession(h.paths, fakeSession());
    const stale = rung('silent', async () => fakeSession({ csrfToken: 'STALE-RUNG' }));
    const good = rung('full', async () => fakeSession({ csrfToken: 'GOOD-RUNG' }));
    const result = await climb({ ...h.input, rungs: [stale.rung, good.rung], allowFull: true });
    assert.equal(result.state, 'fresh');
    if (result.state === 'fresh') assert.equal(result.rungUsed, 'full');
    assert.equal(h.ft.calls.length, 3);
    assert.equal(readSession(h.paths)?.csrfToken, 'GOOD-RUNG');
  } finally {
    h.done();
  }
});

test('climb never throws: a corrupt status.json is replaced, an unwritable cache is logged', async () => {
  const h = harness([]);
  try {
    mkdirSync(h.paths.cacheDir, { recursive: true });
    writeFileSync(h.paths.statusFile, '{not json');
    assert.equal(readStatus(h.paths), null);
    writeSession(h.paths, fakeSession({ jwt: FRESH_JWT, jwtExpiresAt: '2026-09-02T10:59:00Z' }));
    assert.equal((await climb(h.input)).state, 'fresh');
    assert.equal(statusOf(h.paths).state, 'fresh');

    // cache/ replaced by a regular file: status cannot be written, the result still comes back.
    rmSync(h.paths.cacheDir, { recursive: true, force: true });
    writeFileSync(h.paths.cacheDir, 'not a directory');
    const result = await climb(h.input);
    assert.equal(result.state, 'fresh');
    assert.ok(h.lg.lines.some((l) => /status\.json/.test(l)));
  } finally {
    h.done();
  }
});

test('secrets never appear in ladder or http logs', async () => {
  const h = harness([expiredStubStep, mintOkStep(NEW_JWT), jsonStep({ ok: true })]);
  try {
    const session = fakeSession({ jwt: STALE_JWT, jwtExpiresAt: '2026-09-02T09:00:00Z' });
    writeSession(h.paths, session);
    const restored = fakeSession({ csrfToken: 'RESTORED-CSRF-SECRET' });
    const silent = rung('silent', async () => restored);
    const result = await climb({ ...h.input, rungs: [silent.rung] });
    assert.equal(result.state, 'fresh');
    const secrets = [...secretsOf(session), ...secretsOf(restored), NEW_JWT, STALE_JWT];
    assertNoSecrets(h.lg.lines.join('\n'), secrets, 'ladder log');
    assertNoSecrets(readFileSync(h.paths.statusFile, 'utf8'), secrets, 'status.json');
    assert.ok(h.lg.lines.length > 0);
  } finally {
    h.done();
  }
});

// ---------------------------------------------------------------------------------------------
// authorizedHttp / retryOnceOnSessionExpired (the seam data commands will call)
// ---------------------------------------------------------------------------------------------

function cliContext(root: string, steps: Step[], rungs: Rung[] = []) {
  const ft = fakeTransport(steps);
  const stderr = { text: '', write: (s: string) => (stderr.text += s) };
  const ctx = createContext({
    stdout: { write: () => true },
    stderr,
    env: {},
    transport: ft.transport,
    stdinIsTTY: false,
    stdoutIsTTY: false,
    stderrIsTTY: false,
    rungs,
  });
  ctx.globals = { ...ctx.globals, root, verbose: true };
  return { ctx, ft, stderr };
}

test('authorizedHttp: fresh session yields a client that attaches the Bearer', async () => {
  const { root, paths } = tempRoot();
  try {
    writeSession(paths, fakeSession({ jwt: FRESH_JWT, jwtExpiresAt: '2026-09-02T10:59:00Z' }));
    const { ctx, ft } = cliContext(root, [jsonStep({ Identifier: '1' })]);
    const auth = await authorizedHttp(ctx, { now: () => NOW });
    assert.equal(auth.session.jwt, FRESH_JWT);
    const value = await auth.http.json<{ Identifier: string }>({
      method: 'GET',
      url: 'https://purdue.brightspace.com/d2l/api/lp/1.62/users/whoami',
    });
    assert.equal(value.Identifier, '1');
    assert.equal(ft.calls.length, 1);
    assert.equal(ft.calls[0]?.headers.authorization, `Bearer ${FRESH_JWT}`);
    assert.equal(ft.calls[0]?.headers.cookie, undefined, 'data routes carry no cookie');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('authorizedHttp: no session throws AuthRequiredError (exit 4) with the login hint', async () => {
  const { root } = tempRoot();
  try {
    const { ctx, ft } = cliContext(root, []);
    await assert.rejects(authorizedHttp(ctx, { now: () => NOW }), (err: unknown) => {
      assert.ok(err instanceof AuthRequiredError);
      assert.equal(err.exitCode, 4);
      assert.equal(err.hint, HINT_LOGIN);
      return true;
    });
    assert.equal(ft.calls.length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('authorizedHttp: expired session after the registered rungs fail throws AuthRequiredError', async () => {
  const { root, paths } = tempRoot();
  try {
    writeSession(paths, fakeSession());
    const silent = rung('silent', async () => null);
    const { ctx } = cliContext(root, [expiredStubStep], [silent.rung]);
    await assert.rejects(authorizedHttp(ctx, { now: () => NOW }), (err: unknown) => {
      assert.ok(err instanceof AuthRequiredError);
      assert.equal(err.hint, HINT_LOGIN);
      return true;
    });
    assert.equal(silent.calls.length, 1);
    assert.ok(existsSync(paths.sessionFile), 'a failed ladder never deletes session.json');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('authorizedHttp: a mint transport failure throws RetryableError (exit 8), not auth', async () => {
  const { root, paths } = tempRoot();
  try {
    writeSession(paths, fakeSession());
    const { ctx } = cliContext(root, [{ status: 400, body: 'Bad Request' }]);
    await assert.rejects(authorizedHttp(ctx, { now: () => NOW }), (err: unknown) => {
      assert.ok(err instanceof RetryableError);
      assert.equal(err.exitCode, 8);
      return true;
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('retryOnceOnSessionExpired re-climbs with a forced mint exactly once', async () => {
  const { root, paths } = tempRoot();
  try {
    writeSession(paths, fakeSession({ jwt: FRESH_JWT, jwtExpiresAt: '2026-09-02T10:59:00Z' }));
    const { ctx, ft } = cliContext(root, [
      expiredStubStep, // first data call: the cookie-side stub on a bearer route
      mintOkStep(NEW_JWT), // forced re-mint
      jsonStep({ Identifier: '7' }), // second data call
    ]);
    let calls = 0;
    const seen: string[] = [];
    const value = await retryOnceOnSessionExpired(
      ctx,
      async ({ http, session }) => {
        calls += 1;
        seen.push(session.jwt ?? '');
        return http.json<{ Identifier: string }>({
          method: 'GET',
          url: 'https://purdue.brightspace.com/d2l/api/lp/1.62/users/whoami',
        });
      },
      { now: () => NOW },
    );
    assert.equal(value.Identifier, '7');
    assert.equal(calls, 2);
    assert.deepEqual(seen, [FRESH_JWT, NEW_JWT]);
    assert.equal(ft.calls.length, 3);
    assert.equal(ft.calls[1]?.method, 'POST');
    assert.equal(ft.calls[2]?.headers.authorization, `Bearer ${NEW_JWT}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('retryOnceOnSessionExpired: a 401 bearer problem also forces one re-mint, then exit 4', async () => {
  const { root, paths } = tempRoot();
  try {
    writeSession(paths, fakeSession({ jwt: FRESH_JWT, jwtExpiresAt: '2026-09-02T10:59:00Z' }));
    const bogus = {
      status: 401,
      body: JSON.stringify({ title: 'Unauthorized', status: 401, detail: "Couldn't parse token" }),
    };
    const { ctx, ft } = cliContext(root, [bogus, mintOkStep(NEW_JWT), bogus]);
    let calls = 0;
    await assert.rejects(
      retryOnceOnSessionExpired(
        ctx,
        async ({ http }) => {
          calls += 1;
          return http.json({ method: 'GET', url: 'https://purdue.brightspace.com/d2l/api/x' });
        },
        { now: () => NOW },
      ),
      (err: unknown) => err instanceof AuthRequiredError,
    );
    assert.equal(calls, 2);
    assert.equal(ft.calls.length, 3);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('retryOnceOnSessionExpired passes other errors straight through without re-climbing', async () => {
  const { root, paths } = tempRoot();
  try {
    writeSession(paths, fakeSession({ jwt: FRESH_JWT, jwtExpiresAt: '2026-09-02T10:59:00Z' }));
    const { ctx, ft } = cliContext(root, [{ status: 404, body: '' }]);
    let calls = 0;
    await assert.rejects(
      retryOnceOnSessionExpired(
        ctx,
        async ({ http }: { http: HttpClient }) => {
          calls += 1;
          return http.json({ method: 'GET', url: 'https://purdue.brightspace.com/d2l/api/x' });
        },
        { now: () => NOW },
      ),
      (err: unknown) => (err as { exitCode?: number }).exitCode === 5,
    );
    assert.equal(calls, 1);
    assert.equal(ft.calls.length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
