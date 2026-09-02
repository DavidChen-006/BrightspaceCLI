import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BsError, CancelledError, RetryableError, UsageError } from '../../src/core/errors.js';
import {
  createHttp,
  type HttpRequest,
  MAX_5XX_RETRIES,
  MAX_RATE_LIMIT_RETRIES,
  withBearer,
} from '../../src/core/http/index.js';
import {
  collectLog,
  fakeSleep,
  fakeTransport,
  jsonStep,
  readAll,
  seededRandom,
  streamOf,
} from '../helpers/http.js';

const URL_ = 'https://purdue.brightspace.com/d2l/api/lp/1.62/enrollments/myenrollments/';
const TOKEN = 'eyJhbGciOiJIUzI1NiJ9.SECRET-JWT-PAYLOAD.signature';

function client(
  steps: Parameters<typeof fakeTransport>[0],
  extra: Partial<Parameters<typeof createHttp>[0]> = {},
) {
  const ft = fakeTransport(steps);
  const sl = fakeSleep();
  const lg = collectLog();
  const http = createHttp({
    transport: ft.transport,
    sleep: sl.sleep,
    random: seededRandom([0.5]),
    log: lg.log,
    timeoutMs: 30_000,
    verbose: true,
    ...extra,
  });
  return { http, ...ft, delays: sl.delays, lines: lg.lines };
}

const get = (url = URL_, headers: Record<string, string> = {}): HttpRequest => ({
  method: 'GET',
  url,
  headers,
});

// ---------------------------------------------------------------- basic request / response

test('request returns status, lowercased headers and the text body', async () => {
  const c = client([{ status: 200, headers: { 'Content-Type': 'text/plain' }, body: 'hi' }]);
  const res = await c.http.request(get());
  assert.equal(res.status, 200);
  assert.equal(res.headers['content-type'], 'text/plain');
  assert.equal(res.body, 'hi');
  assert.equal(res.method, 'GET');
  assert.equal(res.url, URL_);
  assert.equal(c.calls.length, 1);
  assert.equal(c.calls[0]?.method, 'GET');
});

test('request reads a streamed body to text and accepts fetch Headers objects', async () => {
  const c = client([
    async () => ({
      status: 200,
      headers: new Headers({ 'X-Request-Cost': '2' }),
      body: streamOf('{"a":1}'),
    }),
  ]);
  const res = await c.http.request(get());
  assert.equal(res.body, '{"a":1}');
  assert.equal(res.headers['x-request-cost'], '2');
});

test('json() parses the body and returns the typed value', async () => {
  const c = client([jsonStep({ Items: [] })]);
  const value = await c.http.json<{ Items: unknown[] }>(get());
  assert.deepEqual(value, { Items: [] });
});

test('json() throws the classified BsError on a non-2xx status', async () => {
  const c = client([jsonStep({ title: 'Not Found', status: 404 }, 404)]);
  await assert.rejects(c.http.json(get()), (err: unknown) => {
    assert.ok(err instanceof BsError);
    assert.equal(err.exitName, 'not_found');
    return true;
  });
});

test('withBearer sets the Authorization header without mutating the input', () => {
  const req = get(URL_, { Accept: 'application/json' });
  const out = withBearer(req, TOKEN);
  assert.equal(out.headers?.Authorization, `Bearer ${TOKEN}`);
  assert.equal(out.headers?.Accept, 'application/json');
  assert.equal(req.headers?.Authorization, undefined);
});

test('the bearer header reaches the transport verbatim', async () => {
  const c = client([jsonStep({})]);
  await c.http.request(withBearer(get(), TOKEN));
  assert.equal(c.calls[0]?.headers.authorization, `Bearer ${TOKEN}`);
});

// ---------------------------------------------------------------- read-only guard

for (const method of ['GET', 'HEAD', 'OPTIONS', 'get']) {
  test(`readonly guard allows ${method}`, async () => {
    const c = client([{ status: 200 }]);
    await c.http.request({ method, url: URL_ });
    assert.equal(c.calls.length, 1);
    assert.equal(c.calls[0]?.method, method.toUpperCase());
  });
}

for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
  test(`readonly guard rejects ${method} before dispatch with a UsageError (exit 2)`, async () => {
    const c = client([{ status: 200 }]);
    await assert.rejects(c.http.request({ method, url: URL_ }), (err: unknown) => {
      assert.ok(err instanceof UsageError);
      assert.equal(err.exitCode, 2);
      assert.match(err.message, /read-only/);
      return true;
    });
    assert.equal(c.calls.length, 0, 'no network I/O');
  });
}

test('allowMutation: true lets the mint POST through', async () => {
  const c = client([jsonStep({ access_token: 'x' })]);
  const res = await c.http.request({
    method: 'POST',
    url: 'https://purdue.brightspace.com/d2l/lp/auth/oauth2/token',
    body: 'scope=*:*:*',
    allowMutation: true,
  });
  assert.equal(res.status, 200);
  assert.equal(c.calls[0]?.method, 'POST');
  assert.equal(c.calls[0]?.body, 'scope=*:*:*');
});

test('X-HTTP-Method-Override is rejected in any case, even with allowMutation', async () => {
  for (const header of ['X-HTTP-Method-Override', 'x-http-method-override']) {
    const c = client([{ status: 200 }]);
    await assert.rejects(
      c.http.request({ method: 'GET', url: URL_, headers: { [header]: 'DELETE' } }),
      UsageError,
    );
    await assert.rejects(
      c.http.request({
        method: 'POST',
        url: URL_,
        headers: { [header]: 'GET' },
        allowMutation: true,
      }),
      UsageError,
    );
    assert.equal(c.calls.length, 0);
  }
});

// ---------------------------------------------------------------- retries

test('429 is retried up to 3 times with 1s<<attempt plus jitter in [0, base/2)', async () => {
  const c = client(
    [{ status: 429 }, { status: 429 }, { status: 429 }, { status: 429 }, { status: 200 }],
    { random: seededRandom([0.5, 0.25, 0.999]) },
  );
  const res = await c.http.request(get());
  assert.equal(res.status, 429, 'last response returned after exhaustion');
  assert.equal(c.calls.length, 1 + MAX_RATE_LIMIT_RETRIES);
  assert.equal(MAX_RATE_LIMIT_RETRIES, 3);
  // base = 1000 * 2**attempt; jitter = random * base / 2
  assert.deepEqual(c.delays, [1000 + 250, 2000 + 250, 4000 + 1998]);
});

test('429 retry stops as soon as a non-429 arrives', async () => {
  const c = client([{ status: 429 }, jsonStep({ ok: 1 })]);
  const res = await c.http.request(get());
  assert.equal(res.status, 200);
  assert.equal(c.calls.length, 2);
  assert.deepEqual(c.delays, [1250]);
});

test('Retry-After integer seconds wins over backoff', async () => {
  const c = client([{ status: 429, headers: { 'Retry-After': '7' } }, { status: 200 }]);
  await c.http.request(get());
  assert.deepEqual(c.delays, [7000]);
});

test('Retry-After HTTP-date is honored relative to the injected clock', async () => {
  const now = Date.parse('Wed, 02 Sep 2026 12:00:00 GMT');
  const c = client(
    [{ status: 429, headers: { 'retry-after': 'Wed, 02 Sep 2026 12:00:05 GMT' } }, { status: 200 }],
    { clock: () => now },
  );
  await c.http.request(get());
  assert.deepEqual(c.delays, [5000]);
});

test('Retry-After in the past or unparsable falls back sensibly', async () => {
  const now = Date.parse('Wed, 02 Sep 2026 12:00:00 GMT');
  const past = client(
    [{ status: 429, headers: { 'retry-after': 'Wed, 02 Sep 2026 11:00:00 GMT' } }, { status: 200 }],
    { clock: () => now },
  );
  await past.http.request(get());
  assert.deepEqual(past.delays, [0]);
  const junk = client([{ status: 429, headers: { 'retry-after': 'soon' } }, { status: 200 }]);
  await junk.http.request(get());
  assert.deepEqual(junk.delays, [1250]);
});

test('5xx is retried once after 1s and the final response is returned', async () => {
  assert.equal(MAX_5XX_RETRIES, 1);
  const c = client([{ status: 502, body: '<html>bad gateway</html>' }, { status: 503 }]);
  const res = await c.http.request(get());
  assert.equal(res.status, 503);
  assert.equal(c.calls.length, 2);
  assert.deepEqual(c.delays, [1000]);
});

test('5xx then 200 succeeds', async () => {
  const c = client([{ status: 500 }, jsonStep({ fine: true })]);
  const res = await c.http.request(get());
  assert.equal(res.status, 200);
});

test('4xx is never retried', async () => {
  for (const status of [400, 401, 403, 404, 409]) {
    const c = client([{ status }, { status: 200 }]);
    const res = await c.http.request(get());
    assert.equal(res.status, status);
    assert.equal(c.calls.length, 1);
    assert.deepEqual(c.delays, []);
  }
});

test('network errors are retried once, then surface as RetryableError (exit 8)', async () => {
  const boom = Object.assign(new TypeError('fetch failed'), { cause: new Error('ECONNRESET') });
  const c = client([boom, boom, { status: 200 }]);
  await assert.rejects(c.http.request(get()), (err: unknown) => {
    assert.ok(err instanceof RetryableError);
    assert.equal(err.exitCode, 8);
    assert.match(err.message, /fetch failed/);
    assert.match(err.message, /GET/);
    return true;
  });
  assert.equal(c.calls.length, 2);
  assert.deepEqual(c.delays, [1000]);
});

test('network error then success recovers', async () => {
  const c = client([new TypeError('fetch failed'), jsonStep({ ok: 1 })]);
  const res = await c.http.request(get());
  assert.equal(res.status, 200);
  assert.equal(c.calls.length, 2);
});

test('retried 429/5xx stream bodies are cancelled before the next attempt', async () => {
  let cancelled = 0;
  const body = new ReadableStream<Uint8Array>({
    cancel() {
      cancelled += 1;
    },
  });
  const c = client([async () => ({ status: 503, headers: {}, body }), { status: 200 }]);
  await c.http.request(get());
  assert.equal(cancelled, 1);
});

// ---------------------------------------------------------------- timeout / cancellation

test('timeout to first byte aborts the transport signal and is retried once as a network error', async () => {
  const c = client(
    [
      (_req, signal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason));
        }),
    ],
    { timeoutMs: 5 },
  );
  await assert.rejects(c.http.request(get()), (err: unknown) => {
    assert.ok(err instanceof RetryableError);
    assert.match(err.message, /timed out after 5 ms/);
    return true;
  });
  assert.equal(c.calls.length, 2);
  assert.ok(c.signals.every((s) => s.aborted));
});

test('a streaming body is not cut off once headers have arrived', async () => {
  const c = client(
    [
      async (_req, signal) => {
        const chunks = ['abc', 'def'];
        return {
          status: 200,
          headers: { 'content-type': 'application/pdf' },
          body: new ReadableStream<Uint8Array>({
            async pull(controller) {
              await new Promise((r) => setTimeout(r, 8));
              if (signal.aborted) {
                controller.error(new Error('cut off'));
                return;
              }
              const next = chunks.shift();
              if (next === undefined) controller.close();
              else controller.enqueue(new TextEncoder().encode(next));
            },
          }),
        };
      },
    ],
    { timeoutMs: 5 },
  );
  const out = await c.http.requestStream(get());
  assert.ok(out.ok);
  assert.equal(await readAll(out.stream.body), 'abcdef');
});

test('a per-request timeoutMs overrides the client default', async () => {
  const c = client(
    [
      (_req, signal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason));
        }),
    ],
    { timeoutMs: 60_000 },
  );
  await assert.rejects(c.http.request({ ...get(), timeoutMs: 3 }), /timed out after 3 ms/);
});

test('caller cancellation is a CancelledError (exit 130) and never retried', async () => {
  const ac = new AbortController();
  const c = client([
    (_req, signal) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason));
        ac.abort();
      }),
  ]);
  await assert.rejects(c.http.request({ ...get(), signal: ac.signal }), CancelledError);
  assert.equal(c.calls.length, 1);
  assert.deepEqual(c.delays, []);
});

test('an already-aborted caller signal short-circuits before dispatch', async () => {
  const ac = new AbortController();
  ac.abort();
  const c = client([{ status: 200 }]);
  await assert.rejects(c.http.request({ ...get(), signal: ac.signal }), CancelledError);
  assert.equal(c.calls.length, 0);
});

// ---------------------------------------------------------------- streaming

test('requestStream returns the body stream and headers on 2xx', async () => {
  const c = client([
    async () => ({
      status: 200,
      headers: { 'Content-Disposition': 'attachment; filename="a.pdf"' },
      body: streamOf('%PDF-'),
    }),
  ]);
  const out = await c.http.requestStream(get());
  assert.ok(out.ok);
  assert.equal(out.stream.status, 200);
  assert.equal(out.stream.headers['content-disposition'], 'attachment; filename="a.pdf"');
  assert.equal(await readAll(out.stream.body), '%PDF-');
});

test('requestStream wraps a string body from a fake transport in a stream', async () => {
  const c = client([{ status: 200, body: 'bytes' }]);
  const out = await c.http.requestStream(get());
  assert.ok(out.ok);
  assert.equal(await readAll(out.stream.body), 'bytes');
});

test('requestStream buffers a non-2xx body so it can be classified', async () => {
  const c = client([{ status: 400, body: '"Content topic is not a file"' }]);
  const out = await c.http.requestStream(get());
  assert.equal(out.ok, false);
  if (!out.ok) {
    assert.equal(out.response.status, 400);
    assert.equal(out.response.body, '"Content topic is not a file"');
  }
});

test('requestStream retries 429 like request does', async () => {
  const c = client([
    { status: 429, headers: { 'retry-after': '1' } },
    { status: 200, body: 'x' },
  ]);
  const out = await c.http.requestStream(get());
  assert.ok(out.ok);
  assert.deepEqual(c.delays, [1000]);
});

// ---------------------------------------------------------------- verbose logging

test('verbose logs method, path, status, elapsed ms and rate-limit headers', async () => {
  let t = 1000;
  const c = client(
    [
      {
        status: 200,
        headers: { 'X-Request-Cost': '3', 'X-Rate-Limit-Remaining': '997' },
        body: '{}',
      },
    ],
    {
      clock: () => {
        t += 42;
        return t;
      },
    },
  );
  await c.http.request(withBearer(get(`${URL_}?sortBy=-EndDate`), TOKEN));
  assert.equal(c.lines.length, 1);
  const line = c.lines[0] ?? '';
  assert.match(line, /GET \/d2l\/api\/lp\/1\.62\/enrollments\/myenrollments\/\?sortBy=-EndDate/);
  assert.match(line, /\b200\b/);
  assert.match(line, /42 ms/);
  assert.match(line, /cost=3/);
  assert.match(line, /remaining=997/);
  assert.doesNotMatch(line, /purdue\.brightspace\.com/, 'path only, not the full URL');
});

test('verbose logs retry decisions', async () => {
  const c = client([
    { status: 429, headers: { 'retry-after': '2' } },
    { status: 503 },
    new TypeError('fetch failed'),
    { status: 200 },
  ]);
  await c.http.request(get());
  const joined = c.lines.join('\n');
  assert.match(joined, /429/);
  assert.match(joined, /retry 1\/3 in 2000 ms \(Retry-After\)/);
  assert.match(joined, /503/);
  assert.match(joined, /retry 1\/1 in 1000 ms \(5xx\)/);
  assert.match(joined, /fetch failed/);
  assert.match(joined, /retry 1\/1 in 1000 ms \(network\)/);
});

test('verbose logs never contain the bearer token, cookies or the csrf token', async () => {
  const cookie = 'd2lSessionVal=COOKIE-SECRET-1; d2lSecureSessionVal=COOKIE-SECRET-2';
  const csrf = 'CSRF-SECRET-TOKEN';
  const c = client([
    { status: 429, headers: { 'retry-after': '1' } },
    new TypeError(`fetch failed for Bearer ${TOKEN}`),
    { status: 200, headers: { 'set-cookie': cookie } },
  ]);
  await c.http.request({
    method: 'POST',
    url: 'https://purdue.brightspace.com/d2l/lp/auth/oauth2/token',
    headers: { Authorization: `Bearer ${TOKEN}`, cookie, 'x-csrf-token': csrf },
    allowMutation: true,
  });
  assert.ok(c.lines.length >= 3);
  for (const line of c.lines) {
    assert.doesNotMatch(line, /SECRET/);
    assert.ok(!line.includes(TOKEN));
    assert.ok(!line.includes(csrf));
    assert.ok(!line.includes('COOKIE-SECRET'));
  }
});

test('error messages never contain the bearer token', async () => {
  const c = client([new TypeError(`bad ${TOKEN}`), new TypeError(`bad ${TOKEN}`)]);
  await assert.rejects(c.http.request(withBearer(get(), TOKEN)), (err: unknown) => {
    assert.ok(err instanceof Error);
    assert.ok(!err.message.includes(TOKEN));
    return true;
  });
});

test('nothing is logged when verbose is off', async () => {
  const c = client([{ status: 429 }, { status: 200 }], { verbose: false });
  await c.http.request(get());
  assert.deepEqual(c.lines, []);
});

test('createHttp defaults: timeoutMs from options, verbose off, no log required', async () => {
  const ft = fakeTransport([{ status: 200 }]);
  const http = createHttp({ transport: ft.transport, timeoutMs: 1234 });
  assert.equal(http.timeoutMs, 1234);
  const res = await http.request(get());
  assert.equal(res.status, 200);
});
