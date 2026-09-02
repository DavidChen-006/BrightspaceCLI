/**
 * The session ladder (PRD 7), run-and-exit inside each command:
 *
 *   rung 0  session.json → cached JWT if fresh, else mint (`mint.ts`)
 *   rung 1  silent SSO   (`kind: 'silent'`, registered by bs-30m)
 *   rung 2  full login   (`kind: 'full'`, `bs auth login` only, registered by bs-68x)
 *
 * `sessionExpired` is the ONLY signal that climbs: a mint that fails for any other reason
 * (network, 5xx, a body without a token) stops the ladder and is reported as retryable. A
 * rung that returns a session gets it persisted, then minted; one that returns null or throws
 * is a failed rung and the ladder goes on. `climb()` never throws (cancellation excepted) and
 * never deletes session.json or profile/ — `bs auth logout` is the only command that does.
 * Every call ends by writing `cache/status.json` (atomic, 0600), the last ladder outcome.
 *
 * Ported from Brightspace-Bar `session-capture/src/orchestrate.mjs`.
 */
import { readdirSync } from 'node:fs';
import type { CliContext } from '../cli/context.js';
import { readJsonFile, SECRET_FILE_MODE, writeJsonAtomic } from '../core/atomic.js';
import type { TenantConfig } from '../core/config.js';
import { isoAtMs } from '../core/dates.js';
import { AuthRequiredError, CancelledError, RetryableError } from '../core/errors.js';
import { type HttpClient, withBearer } from '../core/http/index.js';
import { type BsPaths, ensureDirs } from '../core/paths.js';
import { type MintResult, mintJwt } from './mint.js';
import { jwtIsFresh, readSession, type Session, writeSession } from './session.js';

export const HINT_LOGIN = 'Run: bs auth login';
export const HINT_REFRESH = 'Run: bs auth refresh';
export const HINT_RETRY = 'Retry; if it persists run: bs auth doctor';

export type RungKind = 'silent' | 'full';
export type RungUsed = 'none' | RungKind;
export type LadderState = 'fresh' | 'expired' | 'none';

export interface RungContext {
  paths: BsPaths;
  config: TenantConfig;
  /** Verbose diagnostics; never pass a secret. */
  log: (line: string) => void;
  /** A line the user sees regardless of --verbose (the "no browser" hint); never a secret. */
  warn?: (line: string) => void;
}

/** A rung tries to produce live credentials; success is a Session, failure null or a throw. */
export interface Rung {
  kind: RungKind;
  attempt(ctx: RungContext): Promise<Session | null>;
}

export type ClimbResult =
  | { state: 'fresh'; session: Session; rungUsed: RungUsed }
  | { state: 'expired'; session: Session; reason: string; hint: string; retryable: boolean }
  | { state: 'none'; session: null; reason: string; hint: string; retryable: boolean };

export interface ClimbInput {
  paths: BsPaths;
  http: HttpClient;
  config: TenantConfig;
  rungs?: readonly Rung[];
  /** Only `bs auth login` sets this: a full rung puts a browser in front of a human. */
  allowFull?: boolean;
  /** Skip the cached-JWT shortcut (a data route answered 401/sessionExpired). */
  forceMint?: boolean;
  log?: (line: string) => void;
  /** Forwarded to the rungs as `RungContext.warn`. */
  warn?: (line: string) => void;
  /** Milliseconds since the epoch; defaults to Date.now. */
  now?: () => number;
}

/** `cache/status.json`: the last ladder outcome. Secret-free by construction. */
export interface LadderStatus {
  checkedAt: string;
  state: LadderState;
  baseUrl: string | null;
  capturedAt: string | null;
  jwtExpiresAt: string | null;
  rungUsed: RungUsed;
  lastError: string | null;
}

const STATES: readonly LadderState[] = ['fresh', 'expired', 'none'];

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Persists a minted token; a cache that cannot be written costs nothing this run. */
function persistJwt(
  paths: BsPaths,
  session: Session,
  minted: Extract<MintResult, { kind: 'ok' }>,
  log: (line: string) => void,
): Session {
  const next: Session = { ...session, jwt: minted.jwt, jwtExpiresAt: minted.expiresAt };
  try {
    writeSession(paths, next);
  } catch (err) {
    log(`auth: could not cache the JWT in session.json: ${describe(err)}`);
  }
  return next;
}

async function climbRungs(
  input: Required<Pick<ClimbInput, 'paths' | 'http' | 'config' | 'log' | 'now'>> & ClimbInput,
): Promise<ClimbResult> {
  const { paths, http, config, log, now } = input;
  const rungs = input.rungs ?? [];
  let session = readSession(paths);
  let silentTried = false;

  if (session === null) {
    log('auth: no session.json');
  } else if (!input.forceMint && jwtIsFresh(session, now())) {
    log('auth: cached JWT is fresh');
    return { state: 'fresh', session, rungUsed: 'none' };
  } else {
    const minted = await mintJwt(http, session, { now, log });
    if (minted.kind === 'ok') {
      return { state: 'fresh', session: persistJwt(paths, session, minted, log), rungUsed: 'none' };
    }
    if (minted.kind === 'transport') {
      return {
        state: 'expired',
        session,
        reason: minted.reason,
        hint: HINT_RETRY,
        retryable: true,
      };
    }
  }

  for (const [index, rung] of rungs.entries()) {
    const name = `rung ${index + 1} (${rung.kind})`;
    if (rung.kind === 'full' && !input.allowFull) {
      log(`auth: skipping ${name}: a full login needs bs auth login`);
      continue;
    }
    if (rung.kind === 'silent') silentTried = true;
    let restored: Session | null;
    try {
      restored = await rung.attempt({ paths, config, log, warn: input.warn });
    } catch (err) {
      if (err instanceof CancelledError) throw err;
      log(`auth: ${name} threw: ${describe(err)}`);
      continue;
    }
    if (restored === null) {
      log(`auth: ${name} could not restore the session`);
      continue;
    }
    try {
      writeSession(paths, restored);
    } catch (err) {
      log(`auth: ${name}: could not write session.json: ${describe(err)}`);
      continue;
    }
    session = restored;
    log(`auth: ${name} restored the session`);
    const minted = await mintJwt(http, session, { now, log });
    if (minted.kind === 'ok') {
      return {
        state: 'fresh',
        session: persistJwt(paths, session, minted, log),
        rungUsed: rung.kind,
      };
    }
    if (minted.kind === 'transport') {
      return {
        state: 'expired',
        session,
        reason: minted.reason,
        hint: HINT_RETRY,
        retryable: true,
      };
    }
    log(`auth: ${name} restored a session that still mints expired; climbing on`);
  }

  if (session === null) {
    return {
      state: 'none',
      session: null,
      reason: `no session at ${paths.sessionFile}`,
      hint: HINT_LOGIN,
      retryable: false,
    };
  }
  return {
    state: 'expired',
    session,
    reason: silentTried
      ? 'the session is expired and the silent rung could not restore it'
      : 'the session is expired',
    hint: silentTried ? HINT_LOGIN : HINT_REFRESH,
    retryable: false,
  };
}

function writeStatus(
  paths: BsPaths,
  result: ClimbResult,
  nowMs: number,
  log: (l: string) => void,
): void {
  const session = result.session;
  const status: LadderStatus = {
    checkedAt: isoAtMs(nowMs),
    state: result.state,
    baseUrl: session?.baseUrl ?? null,
    capturedAt: session?.capturedAt ?? null,
    jwtExpiresAt: session?.jwtExpiresAt ?? null,
    rungUsed: result.state === 'fresh' ? result.rungUsed : 'none',
    lastError: result.state === 'fresh' ? null : result.reason,
  };
  try {
    ensureDirs(paths);
    writeJsonAtomic(paths.statusFile, status, { mode: SECRET_FILE_MODE });
  } catch (err) {
    log(`auth: could not write status.json: ${describe(err)}`);
  }
}

/** Runs the ladder to a verdict and records it in cache/status.json. Never throws. */
export async function climb(input: ClimbInput): Promise<ClimbResult> {
  const log = input.log ?? (() => {});
  const now = input.now ?? Date.now;
  const result = await climbRungs({ ...input, log, now });
  writeStatus(input.paths, result, now(), log);
  return result;
}

/** The last recorded ladder outcome, or null when missing or corrupt. */
export function readStatus(paths: BsPaths): LadderStatus | null {
  const raw = readJsonFile(paths.statusFile);
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  if (typeof record.checkedAt !== 'string') return null;
  if (!STATES.includes(record.state as LadderState)) return null;
  return record as unknown as LadderStatus;
}

/** True when profile/ exists and holds anything: an empty directory is not a profile. */
export function profileExists(paths: BsPaths): boolean {
  try {
    return readdirSync(paths.profileDir).length > 0;
  } catch {
    return false;
  }
}

/** An HttpClient that attaches `Authorization: Bearer <jwt>` to every request. */
export function bearerHttp(http: HttpClient, jwt: string): HttpClient {
  return {
    timeoutMs: http.timeoutMs,
    request: (req) => http.request(withBearer(req, jwt)),
    requestStream: (req) => http.requestStream(withBearer(req, jwt)),
    json: (req, options) => http.json(withBearer(req, jwt), options),
  };
}

export interface Authorized {
  http: HttpClient;
  session: Session;
}

export interface AuthorizedHttpOptions {
  /** Defaults to the rungs registered on the context. */
  rungs?: readonly Rung[];
  /** Defaults to `ctx.http()`. */
  http?: HttpClient;
  allowFull?: boolean;
  forceMint?: boolean;
  now?: () => number;
}

/**
 * What data commands call: climbs the ladder with the context's rungs (silent at most unless
 * `allowFull`) and returns a Bearer-attaching client. Throws AuthRequiredError (exit 4, hint
 * `Run: bs auth login`) when no rung could produce a fresh token, or RetryableError (exit 8)
 * when the mint itself failed for a non-session reason.
 */
export async function authorizedHttp(
  ctx: CliContext,
  options: AuthorizedHttpOptions = {},
): Promise<Authorized> {
  const http = options.http ?? ctx.http();
  const result = await climb({
    paths: ctx.paths(),
    config: ctx.config(),
    http,
    rungs: options.rungs ?? ctx.rungs,
    allowFull: options.allowFull ?? false,
    forceMint: options.forceMint ?? false,
    log: (line) => ctx.debug(line),
    warn: (line) => ctx.warn(line),
    now: options.now,
  });
  if (result.state === 'fresh' && result.session.jwt !== undefined) {
    return { http: bearerHttp(http, result.session.jwt), session: result.session };
  }
  if (result.state !== 'fresh' && result.retryable) {
    throw new RetryableError(result.reason, { hint: result.hint });
  }
  const reason = result.state === 'fresh' ? 'the session carries no JWT' : result.reason;
  throw new AuthRequiredError(reason, { hint: HINT_LOGIN });
}

/**
 * Runs `fn` with an authorized client; if it fails with AuthRequiredError (a bearer route
 * answered 401 `Couldn't parse token` or the sessionExpired stub), re-climbs once with a forced
 * mint and runs `fn` again. Any other error passes straight through.
 */
export async function retryOnceOnSessionExpired<T>(
  ctx: CliContext,
  fn: (auth: Authorized) => Promise<T>,
  options: AuthorizedHttpOptions = {},
): Promise<T> {
  const first = await authorizedHttp(ctx, options);
  try {
    return await fn(first);
  } catch (err) {
    if (!(err instanceof AuthRequiredError)) throw err;
    ctx.debug(`auth: ${err.message}; re-minting once`);
    const second = await authorizedHttp(ctx, { ...options, forceMint: true });
    return fn(second);
  }
}
