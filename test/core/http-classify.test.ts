import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  AuthRequiredError,
  BsError,
  NotFoundError,
  PermissionDeniedError,
  RateLimitedError,
  RetryableError,
} from '../../src/core/errors.js';
import {
  classify,
  FORBIDDEN_HINT,
  type HttpResponse,
  problemDetails,
  readJson,
  toError,
} from '../../src/core/http/index.js';

const fixture = (name: string) =>
  readFileSync(fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url)), 'utf8');

const SESSION_EXPIRED_HTML = fixture('session-expired-stub.html');
const bogus = fixture('bogus-bearer-response.txt').split('\n');
const BOGUS_STATUS = Number(bogus[0]?.replace('STATUS ', ''));
const BOGUS_BODY = bogus[1] ?? '';

const PATH = '/d2l/api/le/1.96/412690/grades/';
const res = (status: number, body = '', headers: Record<string, string> = {}): HttpResponse => ({
  status,
  headers,
  body,
  method: 'GET',
  url: `https://purdue.brightspace.com${PATH}`,
});

// ---------------------------------------------------------------- fixtures sanity

test('fixtures are the faithful copies (sizes match the reference)', () => {
  assert.equal(Buffer.byteLength(SESSION_EXPIRED_HTML), 294);
  assert.equal(BOGUS_STATUS, 401);
  assert.match(BOGUS_BODY, /Couldn't parse token/);
});

// ---------------------------------------------------------------- problemDetails

test('problemDetails parses RFC-7807 JSON', () => {
  const p = problemDetails(BOGUS_BODY);
  assert.equal(p.isProblem, true);
  assert.equal(p.type, 'http://docs.valence.desire2learn.com/res/apiprop.html#invalid-token');
  assert.equal(p.title, 'Unauthorized');
  assert.equal(p.status, 401);
  assert.equal(p.detail, "Couldn't parse token");
  assert.equal(p.instance, undefined);
  assert.equal(p.text, BOGUS_BODY);
});

test('problemDetails keeps instance and tolerates extra or wrongly typed fields', () => {
  const p = problemDetails(
    JSON.stringify({ title: 'Nope', instance: '/x', status: '500', detail: 7, extra: true }),
  );
  assert.equal(p.isProblem, true);
  assert.equal(p.title, 'Nope');
  assert.equal(p.instance, '/x');
  assert.equal(p.status, 500, 'numeric strings are coerced');
  assert.equal(p.detail, undefined, 'non-string detail is dropped');
});

test('problemDetails falls back to trimmed text for plain text, HTML, arrays and empty bodies', () => {
  const plain = problemDetails('  Timestamp out of range \n');
  assert.equal(plain.isProblem, false);
  assert.equal(plain.text, 'Timestamp out of range');
  assert.equal(plain.title, undefined);
  const arr = problemDetails('[1,2]');
  assert.equal(arr.isProblem, false);
  assert.equal(arr.text, '[1,2]');
  const obj = problemDetails('{"Items":[]}');
  assert.equal(obj.isProblem, false, 'a JSON object without title/detail is not a problem');
  const empty = problemDetails('');
  assert.equal(empty.isProblem, false);
  assert.equal(empty.text, '');
});

// ---------------------------------------------------------------- classify

test('2xx is ok', () => {
  for (const status of [200, 201, 204]) {
    assert.equal(classify(res(status, '{}')).kind, 'ok');
  }
});

test('sessionExpired=1 in the body wins over any status (checked before status)', () => {
  for (const status of [200, 302, 403, 500]) {
    const c = classify(res(status, SESSION_EXPIRED_HTML));
    assert.equal(c.kind, 'SessionExpired', `status ${status}`);
  }
  const err = toError(classify(res(200, SESSION_EXPIRED_HTML)));
  assert.ok(err instanceof AuthRequiredError);
  assert.equal(err.exitCode, 4);
  assert.match(err.message, /session expired/i);
  assert.equal(err.hint, 'Run: bs auth login');
});

test('401 with the bogus-bearer fixture is AuthRequired, not SessionExpired', () => {
  const c = classify(res(BOGUS_STATUS, BOGUS_BODY));
  assert.equal(c.kind, 'AuthRequired');
  assert.equal(c.problem.detail, "Couldn't parse token");
  const err = toError(c);
  assert.ok(err instanceof AuthRequiredError);
  assert.equal(err.exitCode, 4);
  assert.match(err.message, /401/);
  assert.match(err.message, /Unauthorized/);
  assert.match(err.message, /Couldn't parse token/);
  assert.equal(err.hint, 'Run: bs auth login');
});

test('403 on a data route is Forbidden with a neutral hint that assumes no diagnosis', () => {
  const c = classify(res(403));
  assert.equal(c.kind, 'Forbidden');
  const err = toError(c);
  assert.ok(err instanceof PermissionDeniedError);
  assert.equal(err.exitCode, 6);
  assert.match(err.message, /403/);
  assert.equal(err.hint, FORBIDDEN_HINT);
  // bs-6j8: the hint reaches active courses too, so it may not lead with "past-term".
  assert.match(err.hint ?? '', /denied this route \(HTTP 403\)/);
  assert.equal(/^403 on a past-term course/.test(err.hint ?? ''), false);
});

test('403 on the mint route is SessionExpired', () => {
  const c = classify(res(403, 'Not authenticated'), { mint: true });
  assert.equal(c.kind, 'SessionExpired');
  assert.ok(toError(c) instanceof AuthRequiredError);
  assert.equal(classify(res(401, ''), { mint: true }).kind, 'AuthRequired');
});

test('404 is NotFound with a trailing-slash hint', () => {
  const c = classify(res(404));
  assert.equal(c.kind, 'NotFound');
  const err = toError(c);
  assert.ok(err instanceof NotFoundError);
  assert.equal(err.exitCode, 5);
  assert.match(err.message, /404/);
  assert.match(err.hint ?? '', /trailing slash/);
});

test('429 is RateLimited', () => {
  const c = classify(res(429, '', { 'retry-after': '3' }));
  assert.equal(c.kind, 'RateLimited');
  const err = toError(c);
  assert.ok(err instanceof RateLimitedError);
  assert.equal(err.exitCode, 7);
});

test('5xx is Retryable', () => {
  for (const status of [500, 502, 504]) {
    const c = classify(res(status, status === 500 ? '' : '<html>gateway</html>'));
    assert.equal(c.kind, 'Retryable');
    const err = toError(c);
    assert.ok(err instanceof RetryableError);
    assert.equal(err.exitCode, 8);
    assert.match(err.message, new RegExp(String(status)));
  }
});

test('a transport failure classifies as Transport → RetryableError', () => {
  const c = classify(new TypeError('fetch failed'));
  assert.equal(c.kind, 'Transport');
  const err = toError(c);
  assert.ok(err instanceof RetryableError);
  assert.match(err.message, /fetch failed/);
});

test('other 4xx/3xx are Failed (exit 1) and carry the body text', () => {
  const c = classify(res(400, '"Content topic is not a file"'));
  assert.equal(c.kind, 'Failed');
  const err = toError(c);
  assert.ok(err instanceof BsError);
  assert.equal(err.exitCode, 1);
  assert.match(err.message, /400/);
  assert.match(err.message, /Content topic is not a file/);
  assert.equal(classify(res(302, '', { location: '/d2l/login' })).kind, 'Failed');
});

test('expectJson turns an undecodable 2xx body into BadShape', () => {
  const c = classify(res(200, '<html>login</html>'), { expectJson: true });
  assert.equal(c.kind, 'BadShape');
  const err = toError(c);
  assert.equal(err.exitCode, 1);
  assert.match(err.message, /JSON/);
  assert.match(err.hint ?? '', /bs auth doctor/);
  assert.equal(classify(res(200, '{"a":1}'), { expectJson: true }).kind, 'ok');
  assert.equal(classify(res(200, '<html>'), {}).kind, 'ok', 'no expectation, no BadShape');
});

test('messages include method and path, plus title/detail when present', () => {
  const c = classify(
    res(403, JSON.stringify({ title: 'Forbidden', detail: 'Not enrolled', status: 403 })),
  );
  assert.equal(c.message, `GET ${PATH}: HTTP 403 Forbidden: Not enrolled`);
  const plain = classify(res(500, '   Something broke   '));
  assert.equal(plain.message, `GET ${PATH}: HTTP 500: Something broke`);
  const empty = classify(res(500));
  assert.equal(empty.message, `GET ${PATH}: HTTP 500`);
});

test('long or multi-line text bodies are collapsed and truncated in messages', () => {
  const body = `<html>\n${'x'.repeat(500)}\n</html>`;
  const c = classify(res(502, body));
  assert.ok(c.message.length < 300);
  assert.doesNotMatch(c.message, /\n/);
});

// ---------------------------------------------------------------- readJson

test('readJson returns the parsed value on 2xx', () => {
  assert.deepEqual(readJson<{ Items: number[] }>(res(200, '{"Items":[1]}')), { Items: [1] });
});

test('readJson throws the classified error for non-2xx and BadShape for undecodable bodies', () => {
  assert.throws(() => readJson(res(404)), NotFoundError);
  assert.throws(() => readJson(res(200, SESSION_EXPIRED_HTML)), AuthRequiredError);
  assert.throws(
    () => readJson(res(200, '')),
    (err: unknown) => err instanceof BsError && /JSON/.test(err.message),
  );
  assert.throws(() => readJson(res(403, ''), { mint: true }), AuthRequiredError);
});
