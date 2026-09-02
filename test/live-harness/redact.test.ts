/**
 * Hermetic tests for `scripts/lib/redact.mjs` — the filter every byte of captured stderr passes
 * through before `scripts/e2e.sh` writes it to a log or echoes it to the terminal (PRD 8.2, D7).
 *
 * The redactor is deliberately fail-closed, so these tests assert two things at once: the secret
 * is gone, and enough of the line survives that the log is still worth reading.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { REDACTED, REDACTED_JWT, redact } from '../../scripts/lib/redact.mjs';

const JWT = 'eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiIxMjM0NSIsImV4cCI6OTk5OTk5OTk5OX0.c2lnbmF0dXJl';

test('redact: Authorization and Bearer tokens', () => {
  const out = redact(`> Authorization: Bearer ${JWT}`);
  assert.ok(!out.includes(JWT), out);
  assert.match(out, /^> Authorization: \[redacted\]$/);
  assert.equal(redact(`token=Bearer ${JWT}`), `token=Bearer ${REDACTED}`);
});

test('redact: cookie headers and the D2L session cookies by name', () => {
  const line = 'cookie: d2lSessionVal=abc123; d2lSecureSessionVal=def456; path=/';
  assert.equal(redact(line), `cookie: ${REDACTED}`);
  const inline = 'sending d2lSessionVal=abc123; d2lSecureSessionVal=def456 to the tenant';
  const out = redact(inline);
  assert.ok(!out.includes('abc123'), out);
  assert.ok(!out.includes('def456'), out);
  assert.match(
    out,
    /^sending d2lSessionVal=\[redacted\]; d2lSecureSessionVal=\[redacted\] to the tenant$/,
  );
});

test('redact: the XSRF header', () => {
  assert.equal(redact('x-csrf-token: 7f3a-not-a-real-token'), `x-csrf-token: ${REDACTED}`);
  assert.equal(redact('X-CSRF-Token=abc'), `X-CSRF-Token=${REDACTED}`);
});

test('redact: a bare JWT anywhere in the text', () => {
  const out = redact(`mint returned ${JWT} (expires in 3600s)`);
  assert.equal(out, `mint returned ${REDACTED_JWT} (expires in 3600s)`);
});

test('redact: passwords never survive', () => {
  assert.equal(redact('BS_PASSWORD=hunter2'), `BS_PASSWORD=${REDACTED}`);
  assert.equal(redact('password: hunter2'), `password: ${REDACTED}`);
});

test('redact: innocent text is untouched and the filter is idempotent', () => {
  const innocent = 'http GET /d2l/api/lp/1.62/users/whoami -> 200 (143 ms) cost=1\ncookies are set';
  assert.equal(redact(innocent), innocent);
  const once = redact(`Authorization: Bearer ${JWT}\ncookie: d2lSessionVal=abc`);
  assert.equal(redact(once), once);
  assert.equal(redact(''), '');
});

test('redact: every line of a multi-line capture is scrubbed', () => {
  const capture = [
    'warn: session expired, re-minting',
    `authorization: Bearer ${JWT}`,
    'cookie: d2lSessionVal=abc123',
    'error: 403 past-term course 412690',
  ].join('\n');
  const out = redact(capture);
  assert.ok(!out.includes(JWT));
  assert.ok(!out.includes('abc123'));
  assert.match(out, /error: 403 past-term course 412690/);
  assert.equal(out.split('\n').length, 4);
});
