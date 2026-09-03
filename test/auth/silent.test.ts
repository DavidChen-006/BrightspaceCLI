import assert from 'node:assert/strict';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { test } from 'node:test';
import { authorizedHttp, climb, HINT_LOGIN, type RungContext } from '../../src/auth/ladder.js';
import { HINT_DOCTOR, silentRung } from '../../src/auth/rungs/silent.js';
import { readSession, writeSession } from '../../src/auth/session.js';
import { createContext } from '../../src/cli/context.js';
import { DEFAULT_CONFIG } from '../../src/core/config.js';
import { AuthRequiredError, CancelledError } from '../../src/core/errors.js';
import { createHttp } from '../../src/core/http/index.js';
import {
  assertNoSecrets,
  expiredStubStep,
  fakeJwt,
  fakeSession,
  mintOkStep,
  secretsOf,
  seedProfile,
  tempRoot,
} from '../helpers/auth.js';
import {
  ALL_COOKIES,
  emailSurface,
  FakeBrowser,
  homeSurface,
  loginSurface,
  silentChain,
  XSRF_VIA_JS,
  XSRF_VIA_META,
} from '../helpers/browser.js';
import { collectLog, fakeSleep, fakeTransport, type Step } from '../helpers/http.js';

const NOW = Date.parse('2026-09-02T10:00:00Z');
const NEW_JWT = fakeJwt({ exp: NOW / 1000 + 7200 });
const SECRETS = [...ALL_COOKIES.map((c) => c.value), XSRF_VIA_JS, XSRF_VIA_META, NEW_JWT];

function rungContext(root: ReturnType<typeof tempRoot>, overrides: Partial<RungContext> = {}) {
  const log = collectLog();
  const ctx: RungContext = {
    paths: root.paths,
    config: DEFAULT_CONFIG,
    log: log.log,
    ...overrides,
  };
  return { ctx, log };
}

function warnSpy() {
  const lines: string[] = [];
  return { lines, warn: (m: string) => lines.push(m) };
}

test('silentRung is kind silent and restores a session through a headless browser on profile/', async () => {
  const root = tempRoot();
  try {
    const fb = new FakeBrowser(silentChain(), { now: NOW });
    const rung = silentRung({ importer: fb.importer(), now: () => fb.now });
    assert.equal(rung.kind, 'silent');
    const { ctx, log } = rungContext(root, {
      config: { ...DEFAULT_CONFIG, browserChannel: 'chrome' },
    });
    const session = await rung.attempt(ctx);
    assert.ok(session);
    assert.equal(session.csrfToken, XSRF_VIA_JS);
    assert.deepEqual(
      session.cookies.map((c) => c.name),
      ['d2lSecureSessionVal', 'd2lSessionVal'],
    );
    assert.deepEqual(fb.launches, [
      { dir: root.paths.profileDir, options: { headless: true, channel: 'chrome' } },
    ]);
    assert.equal(fb.closed, 1);
    assert.ok(existsSync(root.paths.profileDir));
    assert.equal(
      existsSync(root.paths.sessionFile),
      false,
      'the rung returns; the ladder persists',
    );
    assertNoSecrets(log.lines.join('\n'), SECRETS, 'rung log');
  } finally {
    rmSync(root.root, { recursive: true, force: true });
  }
});

test('silentRung uses the tenant config for the campus selector and base URL', async () => {
  const root = tempRoot();
  try {
    const other = 'https://example.brightspace.com';
    const fb = new FakeBrowser(
      [
        {
          ...loginSurface('home'),
          url: `${other}/d2l/login`,
          visible: ['text:Example Campus'],
          onClick: { 'text:example campus': 'home' },
        },
        homeSurface({
          url: `${other}/d2l/home`,
          cookies: [{ name: 'd2lSessionVal', value: 'v', domain: 'example.brightspace.com' }],
        }),
      ],
      { now: NOW },
    );
    const rung = silentRung({ importer: fb.importer(), now: () => fb.now });
    const { ctx } = rungContext(root, {
      config: { ...DEFAULT_CONFIG, baseUrl: other, campusText: 'Example Campus' },
    });
    const session = await rung.attempt(ctx);
    assert.equal(session?.baseUrl, other);
    assert.equal(fb.calls[0], `goto ${other}/d2l/home`);
    assert.deepEqual(fb.clicks, ['text:Example Campus']);
  } finally {
    rmSync(root.root, { recursive: true, force: true });
  }
});

test('silentRung returns null (never throws) when the browser lands on an email prompt', async () => {
  const root = tempRoot();
  try {
    const fb = new FakeBrowser([loginSurface('email'), emailSurface()], { now: NOW });
    const { ctx } = rungContext(root);
    assert.equal(
      await silentRung({ importer: fb.importer(), now: () => fb.now }).attempt(ctx),
      null,
    );
    assert.equal(fb.closed, 1);
  } finally {
    rmSync(root.root, { recursive: true, force: true });
  }
});

test('silentRung: playwright-core not installed → null, one-line doctor hint, warning', async () => {
  const root = tempRoot();
  try {
    const fb = new FakeBrowser([homeSurface()]);
    const importError = Object.assign(
      new Error("Cannot find package 'playwright-core' imported from /x/browser.js"),
      { code: 'ERR_MODULE_NOT_FOUND' },
    );
    const spy = warnSpy();
    const { ctx, log } = rungContext(root, { warn: spy.warn });
    const rung = silentRung({ importer: fb.importer({ importError }) });
    assert.equal(await rung.attempt(ctx), null);
    assert.equal(spy.lines.length, 1);
    assert.ok(spy.lines[0]?.includes(HINT_DOCTOR), spy.lines[0]);
    assert.ok(/playwright-core/.test(spy.lines[0] ?? ''));
    assert.equal(spy.lines[0]?.includes('\n'), false, 'one line');
    assert.ok(log.lines.some((l) => l.includes(HINT_DOCTOR)));
    assert.equal(fb.launches.length, 0);
  } finally {
    rmSync(root.root, { recursive: true, force: true });
  }
});

test('silentRung: browser executable missing → null, one-line doctor hint, warning', async () => {
  const root = tempRoot();
  try {
    const fb = new FakeBrowser([homeSurface()]);
    const launchError = new Error(
      "browserType.launchPersistentContext: Executable doesn't exist at /Users/x/Library/Caches/ms-playwright/chromium-1200/chrome\n╔═══════════╗\n║ Looks like Playwright was just installed or updated. ║\n║ Please run: npx playwright install ║\n╚═══════════╝",
    );
    const spy = warnSpy();
    const { ctx } = rungContext(root, { warn: spy.warn });
    const rung = silentRung({ importer: fb.importer({ launchError }) });
    assert.equal(await rung.attempt(ctx), null);
    assert.equal(spy.lines.length, 1);
    assert.ok(spy.lines[0]?.includes(HINT_DOCTOR), spy.lines[0]);
    assert.equal(spy.lines[0]?.includes('\n'), false, 'the box art is not repeated');
  } finally {
    rmSync(root.root, { recursive: true, force: true });
  }
});

test('silentRung: any other browser failure is logged and swallowed without the doctor hint', async () => {
  const root = tempRoot();
  try {
    const fb = new FakeBrowser([homeSurface()]);
    const spy = warnSpy();
    const { ctx, log } = rungContext(root, { warn: spy.warn });
    const rung = silentRung({ importer: fb.importer({ launchError: new Error('boom') }) });
    assert.equal(await rung.attempt(ctx), null);
    assert.deepEqual(spy.lines, []);
    assert.ok(log.lines.some((l) => /boom/.test(l)));
  } finally {
    rmSync(root.root, { recursive: true, force: true });
  }
});

test('silentRung lets cancellation through', async () => {
  const root = tempRoot();
  try {
    const fb = new FakeBrowser([homeSurface()]);
    const { ctx } = rungContext(root);
    const rung = silentRung({ importer: fb.importer({ launchError: new CancelledError() }) });
    await assert.rejects(rung.attempt(ctx), (err: unknown) => err instanceof CancelledError);
  } finally {
    rmSync(root.root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------------------------
// Ladder integration: rung 0 → silent rung → mint
// ---------------------------------------------------------------------------------------------

function ladderHarness(steps: Step[]) {
  const ft = fakeTransport(steps);
  const lg = collectLog();
  const http = createHttp({
    transport: ft.transport,
    sleep: fakeSleep().sleep,
    log: lg.log,
    verbose: true,
    clock: () => NOW,
  });
  const root = tempRoot();
  // climb() only runs the silent rung when profile/ holds something (bs-6j8).
  seedProfile(root.paths);
  return { ft, lg, http, root, done: () => rmSync(root.root, { recursive: true, force: true }) };
}

test('ladder: no session.json → silent rung harvests → rung 0 mints → fresh, persisted, secret-free logs', async () => {
  const h = ladderHarness([mintOkStep(NEW_JWT)]);
  try {
    const fb = new FakeBrowser(silentChain(), { now: NOW });
    const result = await climb({
      paths: h.root.paths,
      http: h.http,
      config: DEFAULT_CONFIG,
      rungs: [silentRung({ importer: fb.importer(), now: () => fb.now })],
      log: h.lg.log,
      now: () => NOW,
    });
    assert.equal(result.state, 'fresh');
    if (result.state === 'fresh') {
      assert.equal(result.rungUsed, 'silent');
      assert.equal(result.session.jwt, NEW_JWT);
    }
    assert.equal(h.ft.calls.length, 1);
    const mint = h.ft.calls[0];
    assert.equal(mint?.method, 'POST');
    assert.equal(mint?.url, 'https://purdue.brightspace.com/d2l/lp/auth/oauth2/token');
    assert.equal(
      mint?.headers.cookie,
      `d2lSessionVal=${ALL_COOKIES[1]?.value}; d2lSecureSessionVal=${ALL_COOKIES[0]?.value}`,
    );
    assert.equal(mint?.headers['x-csrf-token'], XSRF_VIA_JS);
    const onDisk = readSession(h.root.paths);
    assert.equal(onDisk?.jwt, NEW_JWT);
    assert.equal(onDisk?.csrfToken, XSRF_VIA_JS);
    assert.deepEqual(
      onDisk?.cookies.map((c) => c.domain),
      ['purdue.brightspace.com', 'purdue.brightspace.com'],
    );
    assert.equal(JSON.parse(readFileSync(h.root.paths.statusFile, 'utf8')).rungUsed, 'silent');
    assertNoSecrets(h.lg.lines.join('\n'), SECRETS, 'ladder+http log');
    assert.ok(h.lg.lines.some((l) => /rung 1 \(silent\) restored/.test(l)));
    assert.equal(fb.closed, 1);
  } finally {
    h.done();
  }
});

test('ladder: expired session, silent rung meets an email prompt → exit 4 with the login hint, session kept', async () => {
  const { root, paths } = tempRoot();
  try {
    writeSession(paths, fakeSession());
    seedProfile(paths);
    const before = readFileSync(paths.sessionFile, 'utf8');
    const fb = new FakeBrowser([loginSurface('email'), emailSurface()], { now: NOW });
    const ft = fakeTransport([expiredStubStep]);
    const stderr = { text: '', write: (s: string) => (stderr.text += s) };
    const ctx = createContext({
      stdout: { write: () => true },
      stderr,
      env: {},
      transport: ft.transport,
      stdinIsTTY: false,
      stdoutIsTTY: false,
      stderrIsTTY: false,
      rungs: [silentRung({ importer: fb.importer(), now: () => fb.now })],
    });
    ctx.globals = { ...ctx.globals, root, verbose: true };
    await assert.rejects(authorizedHttp(ctx, { now: () => NOW }), (err: unknown) => {
      assert.ok(err instanceof AuthRequiredError);
      assert.equal(err.hint, HINT_LOGIN);
      return true;
    });
    assert.equal(ft.calls.length, 1, 'one mint, no data call');
    assert.equal(fb.launches.length, 1, 'the silent rung ran once');
    assert.equal(
      readFileSync(paths.sessionFile, 'utf8'),
      before,
      'a failed ladder never deletes state',
    );
    assertNoSecrets(stderr.text, [...secretsOf(fakeSession()), ...SECRETS], 'stderr');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
