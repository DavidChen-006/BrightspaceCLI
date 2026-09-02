/**
 * The session.json contract (PRD 8.1) and the JWT freshness rules (PRD 7, rung 0).
 *
 * Ported from Brightspace-Bar `session-capture/src/session.mjs`: the cookie header has a fixed
 * order so two captures of one session are byte-identical. Everything here is file-local and
 * secret-carrying; nothing in this module logs.
 */
import { rmSync } from 'node:fs';
import { readJsonFile, SECRET_FILE_MODE, writeJsonAtomic } from '../core/atomic.js';
import { isoAtMs, isoSeconds } from '../core/dates.js';
import { type BsPaths, ensureDirs } from '../core/paths.js';

export interface SessionCookie {
  name: string;
  value: string;
  domain?: string;
  path?: string;
  /** Seconds since the epoch, as playwright reports it; -1 for a session cookie. */
  expires?: number;
  httpOnly?: boolean;
  secure?: boolean;
}

export interface Session {
  /** Whole-second UTC ISO-8601: when the cookies were harvested. */
  capturedAt: string;
  /** Tenant origin, no trailing slash. */
  baseUrl: string;
  cookies: SessionCookie[];
  /** Raw `Cookie:` header value: d2lSessionVal, d2lSecureSessionVal, then any others. */
  cookieHeader: string;
  /** XSRF token sent as `x-csrf-token` on the mint; its absence yields a spurious 403. */
  csrfToken: string;
  /** Where the browser landed after authentication. */
  landedUrl: string;
  /** Cached bearer token from the last mint, if any. */
  jwt?: string;
  /** Whole-second UTC ISO-8601 with the 60 s skew already subtracted. */
  jwtExpiresAt?: string;
}

/** A JWT is treated as dead this long before its `exp`. */
export const JWT_SKEW_MS = 60_000;
/** Lifetime assumed when `exp` cannot be read and the mint gave no `expires_in`. */
export const JWT_FALLBACK_TTL_MS = 3_600_000;

const COOKIE_ORDER: readonly string[] = ['d2lSessionVal', 'd2lSecureSessionVal'];

/** Stable order: the two D2L session cookies first, then the rest in input order. */
export function buildCookieHeader(cookies: readonly SessionCookie[]): string {
  const rank = (c: SessionCookie): number => {
    const i = COOKIE_ORDER.indexOf(c.name);
    return i === -1 ? COOKIE_ORDER.length : i;
  };
  return [...cookies]
    .sort((a, b) => rank(a) - rank(b))
    .map((c) => `${c.name}=${c.value}`)
    .join('; ');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function cookieOf(raw: unknown): SessionCookie | null {
  if (!isRecord(raw) || typeof raw.name !== 'string' || typeof raw.value !== 'string') return null;
  const cookie: SessionCookie = { name: raw.name, value: raw.value };
  if (typeof raw.domain === 'string') cookie.domain = raw.domain;
  if (typeof raw.path === 'string') cookie.path = raw.path;
  if (typeof raw.expires === 'number' && Number.isFinite(raw.expires)) cookie.expires = raw.expires;
  if (typeof raw.httpOnly === 'boolean') cookie.httpOnly = raw.httpOnly;
  if (typeof raw.secure === 'boolean') cookie.secure = raw.secure;
  return cookie;
}

export interface SessionFacts {
  baseUrl: string;
  cookies: readonly SessionCookie[];
  csrfToken: string;
  landedUrl: string;
  /** Milliseconds since the epoch; defaults to now. */
  capturedAt?: number;
}

/** Assembles the contract from what a rung harvested. */
export function buildSession(facts: SessionFacts): Session {
  const cookies = facts.cookies
    .map((c) => cookieOf(c))
    .filter((c): c is SessionCookie => c !== null);
  return {
    capturedAt: isoAtMs(facts.capturedAt ?? Date.now()),
    baseUrl: facts.baseUrl.replace(/\/+$/, ''),
    cookies,
    cookieHeader: buildCookieHeader(cookies),
    csrfToken: facts.csrfToken,
    landedUrl: facts.landedUrl,
  };
}

/** ISO string as given (normalised), or a Brightspace-Bar style epoch-ms number. */
function capturedAtOf(raw: unknown): string | null {
  if (typeof raw === 'number' && Number.isFinite(raw)) return isoAtMs(raw);
  return isoSeconds(raw);
}

/**
 * The session on disk, or `null` when the file is missing, unreadable, not JSON, or not the
 * contract (poison-pill: a corrupt file is "absent", never a throw). Never deletes anything.
 */
export function readSession(paths: BsPaths): Session | null {
  const raw = readJsonFile(paths.sessionFile);
  if (!isRecord(raw)) return null;
  const capturedAt = capturedAtOf(raw.capturedAt);
  const { baseUrl, cookieHeader, csrfToken } = raw;
  if (
    capturedAt === null ||
    typeof baseUrl !== 'string' ||
    baseUrl === '' ||
    typeof cookieHeader !== 'string' ||
    cookieHeader === '' ||
    typeof csrfToken !== 'string' ||
    csrfToken === '' ||
    !Array.isArray(raw.cookies)
  ) {
    return null;
  }
  const session: Session = {
    capturedAt,
    baseUrl: baseUrl.replace(/\/+$/, ''),
    cookies: raw.cookies.map(cookieOf).filter((c): c is SessionCookie => c !== null),
    cookieHeader,
    csrfToken,
    landedUrl: typeof raw.landedUrl === 'string' ? raw.landedUrl : '',
  };
  if (typeof raw.jwt === 'string' && raw.jwt !== '') {
    session.jwt = raw.jwt;
    if (typeof raw.jwtExpiresAt === 'string') session.jwtExpiresAt = raw.jwtExpiresAt;
  }
  return session;
}

/** Atomic (same-dir temp + rename), 0600, inside 0700 directories. Throws on I/O failure. */
export function writeSession(paths: BsPaths, session: Session): void {
  ensureDirs(paths);
  writeJsonAtomic(paths.sessionFile, session, { mode: SECRET_FILE_MODE });
}

/** Only `bs auth logout` may call this (RepoBar anti-trapdoor); a no-op when absent. */
export function deleteSession(paths: BsPaths): void {
  rmSync(paths.sessionFile, { force: true });
}

export interface JwtExpiryOptions {
  /** Milliseconds since the epoch; defaults to Date.now(). */
  now?: number;
  /** The mint's `expires_in`, used (with skew) when the payload carries no readable `exp`. */
  fallbackSeconds?: number;
}

/**
 * Epoch-ms instant after which a JWT is treated as stale: the base64url-decoded payload's
 * `exp` minus 60 s, unverified. On any failure: now + `fallbackSeconds` (minus skew) when given,
 * else now + 3600 s (evidence: Brightspace-Bar A-24, no mint body was ever recorded).
 */
export function jwtExpiry(jwt: string, options: JwtExpiryOptions = {}): number {
  const now = options.now ?? Date.now();
  const exp = decodeExp(jwt);
  if (exp !== null) return exp * 1000 - JWT_SKEW_MS;
  const seconds = options.fallbackSeconds;
  if (seconds !== undefined && Number.isFinite(seconds) && seconds > 0) {
    return now + seconds * 1000 - JWT_SKEW_MS;
  }
  return now + JWT_FALLBACK_TTL_MS;
}

function decodeExp(jwt: string): number | null {
  const parts = jwt.split('.');
  if (parts.length !== 3 || parts[1] === undefined || parts[1] === '') return null;
  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (!isRecord(payload)) return null;
  const exp = payload.exp;
  return typeof exp === 'number' && Number.isFinite(exp) ? exp : null;
}

/** True when a cached JWT exists and its (skew-adjusted) expiry is still ahead of `now`. */
export function jwtIsFresh(session: Session, now: number = Date.now()): boolean {
  if (typeof session.jwt !== 'string' || session.jwt === '') return false;
  if (typeof session.jwtExpiresAt !== 'string') return false;
  const at = Date.parse(session.jwtExpiresAt);
  return Number.isFinite(at) && at > now;
}
