import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  clickThroughSilentSurfaces,
  cookiesForHost,
  extractXsrf,
  isAuthenticated,
  SILENT_TIMEOUT_MS,
  trySilentLogin,
  withBrowser,
  XSRF_TRIES,
  XSRF_WAIT_MS,
} from '../../src/auth/rungs/browser.js';
import { assertNoSecrets } from '../helpers/auth.js';
import {
  ALL_COOKIES,
  BASE_URL,
  CAMPUS_TEXT,
  emailSurface,
  FakeBrowser,
  homeSurface,
  kmsiSurface,
  loginSurface,
  type Surface,
  silentChain,
  XSRF_VIA_JS,
  XSRF_VIA_META,
} from '../helpers/browser.js';
import { collectLog } from '../helpers/http.js';

const SECRETS = [...ALL_COOKIES.map((c) => c.value), XSRF_VIA_JS, XSRF_VIA_META];
const NOW = Date.parse('2026-09-02T10:00:00Z');

function loginOptions(fb: FakeBrowser, log = collectLog()) {
  return {
    options: { baseUrl: BASE_URL, campusText: CAMPUS_TEXT, log: log.log, now: () => fb.now },
    log,
  };
}

test('cookiesForHost keeps cookies for the tenant host and its parent domains only', () => {
  const kept = cookiesForHost(
    [
      ...ALL_COOKIES,
      { name: 'parent', value: 'p', domain: '.brightspace.com' },
      { name: 'sibling', value: 's', domain: 'other.brightspace.com' },
      { name: 'nodomain', value: 'n' },
    ],
    BASE_URL,
  );
  assert.deepEqual(
    kept.map((c) => c.name),
    ['d2lSecureSessionVal', 'd2lSessionVal', 'parent'],
  );
  assert.equal(kept[0]?.httpOnly, true);
  assert.equal(kept[0]?.expires, -1);
});

test('isAuthenticated is positive only with the tenant d2lSessionVal cookie AND window.D2L.LP', async () => {
  const cases: [string, Partial<Surface>, boolean][] = [
    ['cookie and LP', { cookies: ALL_COOKIES, d2lLp: true }, true],
    [
      'cookie without LP (the login stub also sets cookies)',
      { cookies: ALL_COOKIES, d2lLp: false },
      false,
    ],
    ['LP without the cookie', { cookies: [], d2lLp: true }, false],
    [
      'd2lSessionVal for another host',
      {
        cookies: [{ name: 'd2lSessionVal', value: 'x', domain: 'other.brightspace.com' }],
        d2lLp: true,
      },
      false,
    ],
    [
      'an empty cookie value',
      {
        cookies: [{ name: 'd2lSessionVal', value: '', domain: 'purdue.brightspace.com' }],
        d2lLp: true,
      },
      false,
    ],
    [
      'evaluate throwing mid-navigation',
      { cookies: ALL_COOKIES, d2lLp: true, evaluateThrows: true },
      false,
    ],
  ];
  for (const [label, overrides, expected] of cases) {
    const fb = new FakeBrowser([homeSurface(overrides)]);
    assert.equal(await isAuthenticated(fb.page, BASE_URL), expected, label);
  }
});

test('extractXsrf asks D2L JS first and never touches the meta tag when it answers', async () => {
  const fb = new FakeBrowser([homeSurface()]);
  assert.equal(await extractXsrf(fb.page), XSRF_VIA_JS);
  assert.deepEqual(fb.calls, ['evaluate xsrf-js']);
});

test('extractXsrf falls back to the meta tag in the same try', async () => {
  const fb = new FakeBrowser([homeSurface({ xsrfJs: null })]);
  assert.equal(await extractXsrf(fb.page), XSRF_VIA_META);
  assert.deepEqual(fb.calls, ['evaluate xsrf-js', 'evaluate xsrf-meta']);
});

test('extractXsrf polls once a second until the token appears', async () => {
  const fb = new FakeBrowser([homeSurface({ xsrfJs: [null, null, XSRF_VIA_JS], xsrfMeta: null })]);
  assert.equal(await extractXsrf(fb.page), XSRF_VIA_JS);
  assert.equal(fb.waits, 2);
  assert.ok(fb.calls.every((c) => !c.startsWith('wait ') || c === `wait ${XSRF_WAIT_MS}`));
});

test('extractXsrf gives up after 10 tries', async () => {
  const fb = new FakeBrowser([homeSurface({ xsrfJs: null, xsrfMeta: null })]);
  assert.equal(await extractXsrf(fb.page), null);
  assert.equal(fb.calls.filter((c) => c === 'evaluate xsrf-js').length, XSRF_TRIES);
  assert.equal(fb.calls.filter((c) => c === 'evaluate xsrf-meta').length, XSRF_TRIES);
  assert.equal(fb.waits, XSRF_TRIES - 1, 'no wait after the last try');
});

test('clickThroughSilentSurfaces clicks the campus selector on /d2l/login, case-insensitively', async () => {
  const fb = new FakeBrowser([loginSurface('home'), homeSurface()]);
  const log = collectLog();
  assert.equal(
    await clickThroughSilentSurfaces(fb.page, {
      campusText: 'purdue WEST lafayette',
      log: log.log,
    }),
    true,
  );
  assert.deepEqual(fb.clicks, ['text:purdue WEST lafayette']);
  assert.equal(fb.surface, 'home');
  assert.ok(log.lines.some((l) => /campus/.test(l)));
});

test('clickThroughSilentSurfaces leaves the campus text alone off /d2l/login and when absent', async () => {
  const offLogin = new FakeBrowser([
    { ...loginSurface('home'), url: `${BASE_URL}/d2l/home` },
    homeSurface(),
  ]);
  assert.equal(await clickThroughSilentSurfaces(offLogin.page, { campusText: CAMPUS_TEXT }), false);
  assert.deepEqual(offLogin.clicks, []);

  const otherCampus = new FakeBrowser([loginSurface('home'), homeSurface()]);
  assert.equal(
    await clickThroughSilentSurfaces(otherCampus.page, { campusText: 'Purdue Northwest' }),
    false,
  );
  assert.deepEqual(otherCampus.clicks, []);

  const blank = new FakeBrowser([loginSurface('home'), homeSurface()]);
  assert.equal(await clickThroughSilentSurfaces(blank.page, { campusText: '  ' }), false);
  assert.deepEqual(blank.clicks, []);
});

test('clickThroughSilentSurfaces clicks #idSIButton9 only behind a KMSI marker (Extra 6 quirk 1)', async () => {
  // The email page has #idSIButton9 ("Next") too; clicking it there submits an empty form forever.
  const email = new FakeBrowser([emailSurface()]);
  assert.equal(await clickThroughSilentSurfaces(email.page, { campusText: CAMPUS_TEXT }), false);
  assert.deepEqual(email.clicks, []);

  for (const marker of ['#KmsiCheckboxField', 'text:Stay signed in?'] as const) {
    const fb = new FakeBrowser([kmsiSurface('home', marker), homeSurface()]);
    const log = collectLog();
    assert.equal(
      await clickThroughSilentSurfaces(fb.page, { campusText: CAMPUS_TEXT, log: log.log }),
      true,
      marker,
    );
    assert.deepEqual(fb.clicks, ['#idSIButton9']);
    assert.equal(fb.surface, 'home');
    assert.ok(log.lines.some((l) => /Stay signed in/.test(l)));
  }

  const markerNoButton = new FakeBrowser([
    { ...kmsiSurface('home', '#KmsiCheckboxField'), visible: ['#KmsiCheckboxField'] },
    homeSurface(),
  ]);
  assert.equal(
    await clickThroughSilentSurfaces(markerNoButton.page, { campusText: CAMPUS_TEXT }),
    false,
  );
});

test('trySilentLogin walks campus → SSO → KMSI → home and harvests a host-filtered session', async () => {
  const fb = new FakeBrowser(silentChain(), { now: NOW });
  const { options, log } = loginOptions(fb);
  const session = await trySilentLogin(fb.page, options);
  assert.ok(session, 'landed authenticated');
  assert.equal(fb.calls[0], `goto ${BASE_URL}/d2l/home`);
  assert.deepEqual(fb.clicks, [`text:${CAMPUS_TEXT}`, '#idSIButton9']);
  assert.equal(session.baseUrl, BASE_URL);
  assert.deepEqual(
    session.cookies.map((c) => c.name),
    ['d2lSecureSessionVal', 'd2lSessionVal'],
    'Entra and Shibboleth cookies are not harvested',
  );
  assert.equal(session.cookies[0]?.domain, 'purdue.brightspace.com');
  assert.equal(session.cookies[0]?.httpOnly, true);
  assert.equal(
    session.cookieHeader,
    `d2lSessionVal=${ALL_COOKIES[1]?.value}; d2lSecureSessionVal=${ALL_COOKIES[0]?.value}`,
  );
  assert.equal(session.csrfToken, XSRF_VIA_JS);
  assert.equal(session.landedUrl, `${BASE_URL}/d2l/home`);
  assert.equal(session.capturedAt, '2026-09-02T10:00:02Z', 'captured on the injected clock');
  assert.equal(session.jwt, undefined);
  assertNoSecrets(log.lines.join('\n'), SECRETS, 'login log');
  assert.ok(log.lines.length > 0);
});

test('trySilentLogin fails fast on an email prompt without spending the budget', async () => {
  const fb = new FakeBrowser([loginSurface('email'), emailSurface()], { now: NOW });
  const { options, log } = loginOptions(fb);
  assert.equal(await trySilentLogin(fb.page, options), null);
  assert.equal(fb.surface, 'email');
  assert.deepEqual(
    fb.clicks,
    [`text:${CAMPUS_TEXT}`],
    '#idSIButton9 on the email page is never clicked',
  );
  assert.ok(fb.now - NOW < 5_000, `gave up after ${fb.now - NOW} ms`);
  assert.ok(log.lines.some((l) => /email|credential/i.test(l)));
});

test('trySilentLogin gives up after 30 s when nothing changes', async () => {
  const stuck: Surface = {
    name: 'stuck',
    url: 'https://sso.purdue.edu/idp/profile/SAML2/Redirect/SSO',
  };
  const fb = new FakeBrowser([stuck], { now: NOW });
  const { options, log } = loginOptions(fb);
  assert.equal(await trySilentLogin(fb.page, options), null);
  assert.ok(fb.now - NOW >= SILENT_TIMEOUT_MS, `waited ${fb.now - NOW} ms`);
  assert.ok(fb.waits <= SILENT_TIMEOUT_MS / 1000 + 1);
  assert.deepEqual(fb.clicks, []);
  assert.ok(log.lines.some((l) => /30000 ms|timed out|not authenticated/i.test(l)));
});

test('trySilentLogin honours a shorter timeout and a failed initial navigation', async () => {
  const stuck: Surface = { name: 'stuck', url: 'about:blank' };
  const fb = new FakeBrowser([stuck], { now: NOW });
  fb.page.goto = async () => {
    throw new Error('net::ERR_NAME_NOT_RESOLVED');
  };
  const { options, log } = loginOptions(fb);
  assert.equal(await trySilentLogin(fb.page, { ...options, timeoutMs: 3_000 }), null);
  assert.ok(fb.waits <= 4);
  assert.ok(log.lines.some((l) => /ERR_NAME_NOT_RESOLVED/.test(l)));
});

test('trySilentLogin returns null when authenticated but no XSRF token can be found', async () => {
  const fb = new FakeBrowser([homeSurface({ xsrfJs: null, xsrfMeta: null })], { now: NOW });
  const { options, log } = loginOptions(fb);
  assert.equal(await trySilentLogin(fb.page, options), null);
  assert.ok(log.lines.some((l) => /XSRF/.test(l)));
});

test('withBrowser launches a persistent context on the profile dir, hands over the first page, always closes', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'bs-browser-'));
  const profileDir = path.join(root, 'profile');
  try {
    const fb = new FakeBrowser([homeSurface()]);
    const log = collectLog();
    const result = await withBrowser(
      { profileDir, headless: true, channel: 'chrome', log: log.log, importer: fb.importer() },
      async (page, context) => {
        assert.equal(page, fb.page);
        assert.equal(context, fb.context);
        assert.equal(fb.closed, 0, 'still open while fn runs');
        return 'drove';
      },
    );
    assert.equal(result, 'drove');
    assert.deepEqual(fb.launches, [
      { dir: profileDir, options: { headless: true, channel: 'chrome' } },
    ]);
    assert.equal(fb.closed, 1);
    assert.ok(existsSync(profileDir), 'the profile dir is created on first use');
    if (process.platform !== 'win32') assert.equal(statSync(profileDir).mode & 0o777, 0o700);

    await assert.rejects(
      withBrowser(
        { profileDir, headless: false, log: log.log, importer: fb.importer() },
        async () => {
          throw new Error('drive failed');
        },
      ),
      /drive failed/,
    );
    assert.equal(fb.closed, 2, 'closed in finally');
    assert.deepEqual(
      fb.launches[1]?.options,
      { headless: false },
      'no channel key when none is set',
    );
    assertNoSecrets(log.lines.join('\n'), SECRETS, 'browser log');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('withBrowser lets an import failure propagate untouched', async () => {
  const fb = new FakeBrowser([homeSurface()]);
  const importError = Object.assign(new Error("Cannot find package 'playwright-core'"), {
    code: 'ERR_MODULE_NOT_FOUND',
  });
  await assert.rejects(
    withBrowser(
      {
        profileDir: os.tmpdir(),
        headless: true,
        log: () => {},
        importer: fb.importer({ importError }),
      },
      async () => 1,
    ),
    (err: unknown) => err === importError,
  );
  assert.equal(fb.launches.length, 0);
});
