import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MINT_PATH, mintJwt } from '../../src/auth/mint.js';
import { JWT_SKEW_MS } from '../../src/auth/session.js';
import { createHttp } from '../../src/core/http/index.js';
import {
  assertNoSecrets,
  bogusBearerStep,
  expiredStubStep,
  fakeJwt,
  fakeSession,
  forbiddenStep,
  mintOkStep,
  secretsOf,
} from '../helpers/auth.js';
import { collectLog, fakeSleep, fakeTransport, type Step } from '../helpers/http.js';

const NOW = Date.parse('2026-09-02T10:00:00Z');

function setup(steps: Step[]) {
  const ft = fakeTransport(steps);
  const lg = collectLog();
  const http = createHttp({
    transport: ft.transport,
    sleep: fakeSleep().sleep,
    log: lg.log,
    verbose: true,
    clock: () => NOW,
  });
  return { ft, lg, http };
}

test('mintJwt sends the one permitted mutation with cookie, csrf and form body', async () => {
  const jwt = fakeJwt({ exp: NOW / 1000 + 3600 });
  const { ft, http } = setup([mintOkStep(jwt)]);
  const session = fakeSession();
  const result = await mintJwt(http, session, { now: () => NOW });
  assert.equal(result.kind, 'ok');
  assert.equal(ft.calls.length, 1);
  const req = ft.calls[0];
  assert.ok(req);
  assert.equal(req.method, 'POST');
  assert.equal(req.url, `${session.baseUrl}${MINT_PATH}`);
  assert.equal(MINT_PATH, '/d2l/lp/auth/oauth2/token');
  assert.equal(req.body, 'scope=*:*:*');
  assert.equal(req.headers.cookie, session.cookieHeader);
  assert.equal(req.headers['x-csrf-token'], session.csrfToken);
  assert.equal(req.headers['content-type'], 'application/x-www-form-urlencoded');
  assert.equal(req.headers.authorization, undefined);
});

test('ok: expiresAt comes from the decoded exp minus skew; expires_in and 3600 s are fallbacks', async () => {
  const exp = NOW / 1000 + 3000;
  const decoded = await mintJwt(setup([mintOkStep(fakeJwt({ exp }))]).http, fakeSession(), {
    now: () => NOW,
  });
  assert.equal(decoded.kind, 'ok');
  if (decoded.kind !== 'ok') return;
  assert.equal(decoded.jwt, fakeJwt({ exp }));
  assert.equal(
    decoded.expiresAt,
    new Date(exp * 1000 - JWT_SKEW_MS).toISOString().replace('.000Z', 'Z'),
  );

  const opaque = await mintJwt(
    setup([mintOkStep('opaque-token', { expires_in: 600 })]).http,
    fakeSession(),
    { now: () => NOW },
  );
  assert.equal(opaque.kind, 'ok');
  if (opaque.kind !== 'ok') return;
  assert.equal(Date.parse(opaque.expiresAt), NOW + 600_000 - JWT_SKEW_MS);

  const bare = await mintJwt(
    setup([{ status: 200, body: JSON.stringify({ access_token: 'opaque-token' }) }]).http,
    fakeSession(),
    { now: () => NOW },
  );
  assert.equal(bare.kind, 'ok');
  if (bare.kind !== 'ok') return;
  assert.equal(Date.parse(bare.expiresAt), NOW + 3_600_000);
});

test('HTTP 200 carrying the sessionExpired=1 stub classifies as expired (marker before status)', async () => {
  const result = await mintJwt(setup([expiredStubStep]).http, fakeSession());
  assert.equal(result.kind, 'expired');
});

test('HTTP 403 on the mint classifies as expired', async () => {
  const result = await mintJwt(setup([forbiddenStep]).http, fakeSession());
  assert.equal(result.kind, 'expired');
});

test('HTTP 401 with the recorded bogus-bearer problem body is transport, carrying the detail', async () => {
  const result = await mintJwt(setup([bogusBearerStep]).http, fakeSession());
  assert.equal(result.kind, 'transport');
  if (result.kind !== 'transport') return;
  assert.match(result.reason, /401/);
  assert.match(result.reason, /Couldn't parse token/);
});

test('a 2xx without a string access_token, or not JSON at all, is transport', async () => {
  const noToken = await mintJwt(
    setup([{ status: 200, body: JSON.stringify({ token_type: 'Bearer' }) }]).http,
    fakeSession(),
  );
  assert.equal(noToken.kind, 'transport');
  if (noToken.kind === 'transport') assert.match(noToken.reason, /access_token/);

  const numeric = await mintJwt(
    setup([{ status: 200, body: JSON.stringify({ access_token: 12 }) }]).http,
    fakeSession(),
  );
  assert.equal(numeric.kind, 'transport');

  const html = await mintJwt(
    setup([{ status: 200, body: '<html>maintenance</html>' }]).http,
    fakeSession(),
  );
  assert.equal(html.kind, 'transport');
});

test('other non-2xx statuses are transport with the text detail; 5xx after its retry too', async () => {
  const text = await mintJwt(
    setup([{ status: 400, body: 'Bad Request: scope' }]).http,
    fakeSession(),
  );
  assert.equal(text.kind, 'transport');
  if (text.kind === 'transport') assert.match(text.reason, /HTTP 400: Bad Request: scope/);

  const { ft, http } = setup([{ status: 502, body: '' }]);
  const gateway = await mintJwt(http, fakeSession());
  assert.equal(gateway.kind, 'transport');
  assert.equal(ft.calls.length, 2, '5xx is retried once by the client');
});

test('a network failure that survives its retry is transport, not a throw', async () => {
  const { ft, http } = setup([new Error('getaddrinfo ENOTFOUND purdue.brightspace.com')]);
  const result = await mintJwt(http, fakeSession());
  assert.equal(result.kind, 'transport');
  if (result.kind === 'transport') assert.match(result.reason, /ENOTFOUND/);
  assert.equal(ft.calls.length, 2);
});

test('no cookie, csrf or jwt value ever reaches a log line', async () => {
  const jwt = fakeJwt({ exp: NOW / 1000 + 3600 });
  const session = fakeSession();
  const mintLog = collectLog();
  for (const steps of [[mintOkStep(jwt)], [expiredStubStep], [bogusBearerStep], [new Error('x')]]) {
    const { lg, http } = setup(steps);
    await mintJwt(http, session, { log: mintLog.log });
    assertNoSecrets(lg.lines.join('\n'), [...secretsOf(session), jwt], 'http log');
  }
  assertNoSecrets(mintLog.lines.join('\n'), [...secretsOf(session), jwt], 'mint log');
  assert.ok(mintLog.lines.length > 0, 'the mint logs an outcome under verbose');
});
