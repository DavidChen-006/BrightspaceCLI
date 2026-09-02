/**
 * Redaction for the live E2E harness (PRD 8.2, D7).
 *
 * `scripts/e2e.sh` captures the stderr of every `bs` run it makes so a failing check can be
 * explained. That stderr is written to a log file and, on failure, echoed to the operator's
 * terminal — so it has to be scrubbed first. This module is the one place that decides what
 * "scrubbed" means, and it lives in `scripts/lib/` rather than inside the shell script so that
 * `test/live-harness/redact.test.ts` can unit-test it without a tenant.
 *
 * It is deliberately fail-closed: anything that *looks* like a credential is replaced, even when
 * the surrounding text is innocent. Over-redacting a log line costs nothing; under-redacting it
 * leaks a session.
 *
 * Two entry points:
 *   - `import { redact } from './redact.mjs'` — the pure function.
 *   - `node scripts/lib/redact.mjs` — a stdin → stdout filter, which is how bash uses it.
 */

import { pathToFileURL } from 'node:url';

export const REDACTED = '[redacted]';
export const REDACTED_JWT = '[redacted-jwt]';

/** Header and env-var names whose value is always a secret, in `name: value` or `name=value`. */
const SECRET_KEYS = [
  'authorization',
  'proxy-authorization',
  'cookie',
  'set-cookie',
  'x-csrf-token',
  'x-xsrf-token',
  'xsrf-token',
  'bs_password',
  'password',
  'passwd',
];

/** Cookie and token names that carry a value inline, anywhere in a line. */
const SECRET_VALUE_NAMES = ['d2lsessionval', 'd2lsecuresessionval', 'd2lsessionvalformat'];

const KEY_VALUE = new RegExp(`\\b(${SECRET_KEYS.join('|')})(\\s*[:=]\\s*)[^\\r\\n]*`, 'gi');
const NAMED_COOKIE = new RegExp(`\\b(${SECRET_VALUE_NAMES.join('|')})(=)[^;,\\s"']*`, 'gi');
const BEARER = /\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi;
/** Three base64url segments starting with the `{"alg"` prefix every D2L JWT has. */
const JWT = /\beyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}/g;

/**
 * Replaces every credential-shaped run in `text`. Idempotent: running it twice is the same as
 * running it once, so a log can be filtered again on its way to the terminal.
 */
export function redact(text) {
  if (typeof text !== 'string' || text === '') return '';
  return text
    .replace(KEY_VALUE, (_m, name, sep) => `${name}${sep}${REDACTED}`)
    .replace(NAMED_COOKIE, (_m, name, sep) => `${name}${sep}${REDACTED}`)
    .replace(BEARER, `Bearer ${REDACTED}`)
    .replace(JWT, REDACTED_JWT);
}

/** stdin → stdout filter. Reads the whole stream: E2E logs are small and bounded by the run. */
async function main() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  process.stdout.write(redact(Buffer.concat(chunks).toString('utf8')));
}

// `pathToFileURL` rather than a `file://` template: a repo path with a space would not compare
// equal, the filter would emit nothing, and e2e.sh would replace a log with an empty file.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
