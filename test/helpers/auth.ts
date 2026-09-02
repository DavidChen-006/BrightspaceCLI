import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import type { Session, SessionCookie } from '../../src/auth/session.js';
import { buildCookieHeader } from '../../src/auth/session.js';
import { type BsPaths, resolvePaths } from '../../src/core/paths.js';
import type { Step } from './http.js';

const FIXTURES = new URL('../fixtures/', import.meta.url);

/** The 294-byte HTML stub the mint answers with HTTP 200 once the cookie is dead. */
export const SESSION_EXPIRED_STUB = readFileSync(
  new URL('session-expired-stub.html', FIXTURES),
  'utf8',
);

/** `STATUS 401` on line one, the RFC-7807 body on the rest. */
export const BOGUS_BEARER = (() => {
  const text = readFileSync(new URL('bogus-bearer-response.txt', FIXTURES), 'utf8');
  const newline = text.indexOf('\n');
  const status = Number(
    text
      .slice(0, newline)
      .replace(/^STATUS\s+/, '')
      .trim(),
  );
  return { status, body: text.slice(newline + 1).trim() };
})();

function base64url(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64url');
}

/** An unsigned JWT-shaped string with the given payload (the CLI never verifies signatures). */
export function fakeJwt(payload: Record<string, unknown>, header = { alg: 'none' }): string {
  return `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(payload))}.sig`;
}

export const COOKIE_VALUE = 'COOKIE-SECRET-6f1c2a9e';
export const SECURE_COOKIE_VALUE = 'SECURE-COOKIE-SECRET-0b7d4e11';
export const CSRF_TOKEN = 'CSRF-SECRET-3c9a8f2d';

export const COOKIES: SessionCookie[] = [
  { name: 'd2lSecureSessionVal', value: SECURE_COOKIE_VALUE, domain: 'purdue.brightspace.com' },
  { name: 'd2lSessionVal', value: COOKIE_VALUE, domain: 'purdue.brightspace.com' },
];

export function fakeSession(overrides: Partial<Session> = {}): Session {
  return {
    capturedAt: '2026-09-02T10:00:00Z',
    baseUrl: 'https://purdue.brightspace.com',
    cookies: COOKIES,
    cookieHeader: buildCookieHeader(COOKIES),
    csrfToken: CSRF_TOKEN,
    landedUrl: 'https://purdue.brightspace.com/d2l/home',
    ...overrides,
  };
}

/** Every secret a session carries; logs and outputs must contain none of them. */
export function secretsOf(session: Session): string[] {
  return [
    ...session.cookies.map((c) => c.value),
    session.csrfToken,
    ...(session.jwt ? [session.jwt] : []),
  ].filter((s) => s.length > 0);
}

export function assertNoSecrets(text: string, secrets: readonly string[], label = 'text'): void {
  for (const secret of secrets) {
    assert.equal(text.includes(secret), false, `${label} leaks a secret (${secret.length} chars)`);
  }
}

/** A fresh temp root with resolved paths; the caller removes it. */
export function tempRoot(prefix = 'bs-auth-'): { root: string; paths: BsPaths } {
  const root = mkdtempSync(path.join(os.tmpdir(), prefix));
  return { root, paths: resolvePaths({ root, env: {} }) };
}

export function mintOkStep(jwt: string, extra: Record<string, unknown> = {}): Step {
  return {
    status: 200,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ access_token: jwt, token_type: 'Bearer', expires_in: 3600, ...extra }),
  };
}

export const expiredStubStep: Step = {
  status: 200,
  headers: { 'content-type': 'text/html' },
  body: SESSION_EXPIRED_STUB,
};

export const forbiddenStep: Step = { status: 403, headers: {}, body: 'Not authenticated' };

export const bogusBearerStep: Step = {
  status: BOGUS_BEARER.status,
  headers: { 'content-type': 'application/problem+json' },
  body: BOGUS_BEARER.body,
};

/**
 * A prompt-friendly stdin: one chunk per line with an event-loop turn between them, so the
 * readline used for the email line cannot swallow the password line that follows it.
 */
export function promptStdin(lines: readonly string[]): NodeJS.ReadableStream {
  const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
  return Readable.from(
    (async function* () {
      for (const line of lines) {
        yield line;
        await tick();
        await tick();
      }
    })(),
  );
}
