/**
 * Helpers every data command shares: the authorized call (ladder + one re-mint), the list
 * envelope with `--fail-empty`, and `--raw` emission. Commands stay thin: parse flags, call a
 * `src/d2l/` route through `withData`, shape, emit.
 */
import { type Authorized, retryOnceOnSessionExpired } from '../auth/ladder.js';
import type { Session } from '../auth/session.js';
import type { TenantConfig } from '../core/config.js';
import { isoAtMs } from '../core/dates.js';
import {
  type BsError,
  EmptyResultsError,
  NotFoundError,
  PermissionDeniedError,
  RateLimitedError,
} from '../core/errors.js';
import type { HttpClient } from '../core/http/index.js';
import { type Column, type Row, writeJson } from '../core/output.js';
import { type CliContext, emit } from './context.js';

/**
 * Data routes go to the tenant the session was captured on: the JWT is only valid there. A
 * differing --base-url / BS_BASE_URL is reported once and ignored for this invocation.
 */
function tenantFor(ctx: CliContext, session: Session, warned: { done: boolean }): TenantConfig {
  const cfg = ctx.config();
  if (cfg.baseUrl === session.baseUrl) return cfg;
  if (!warned.done) {
    warned.done = true;
    ctx.warn(
      `the session belongs to ${session.baseUrl}; ignoring base URL ${cfg.baseUrl} (run: bs auth login to switch tenants)`,
    );
  }
  return { ...cfg, baseUrl: session.baseUrl };
}

/**
 * Runs `fn` with a Bearer-attaching client against the session's tenant, climbing the ladder
 * (silent rung at most; never a browser) and re-minting once if the first call says the
 * session expired. Throws AuthRequiredError (exit 4, `Run: bs auth login`) with no data
 * request made when there is no usable session.
 */
export function withData<T>(
  ctx: CliContext,
  fn: (http: HttpClient, cfg: TenantConfig) => Promise<T>,
): Promise<T> {
  const warned = { done: false };
  return retryOnceOnSessionExpired(ctx, (auth: Authorized) =>
    fn(auth.http, tenantFor(ctx, auth.session, warned)),
  );
}

// ---------------------------------------------------------------------------------------------
// Partial results (bs-6j8): the machine-readable half of a stderr warning
// ---------------------------------------------------------------------------------------------

/**
 * One route that failed inside an otherwise successful result. Both strings are composed by
 * `bs` (a method and a path, the classifier's diagnosis line), never by the tenant, so
 * `--wrap-untrusted` leaves them alone — see METADATA_KEYS_BY_ANCESTOR in `src/core/output.ts`.
 */
export interface RouteFailure {
  /** `GET /d2l/api/lp/1.62/courses/1498777`. */
  route: string;
  /** The HTTP status when the failure was a response, else null. */
  status: number | null;
  message: string;
}

/** The HTTP status behind a classified route error, when there was one. */
export function httpStatusOf(err: BsError): number | null {
  if (err instanceof PermissionDeniedError) return 403;
  if (err instanceof NotFoundError) return 404;
  if (err instanceof RateLimitedError) return 429;
  const m = /HTTP (\d{3})/.exec(err.message);
  return m ? Number(m[1]) : null;
}

export function routeFailure(route: string, err: BsError): RouteFailure {
  return { route, status: httpStatusOf(err), message: err.message };
}

/**
 * The 403 sentence a command may add once it holds the course's access window (bs-6j8).
 * `FORBIDDEN_HINT` has to stay neutral because `classify()` only ever sees a status and a body;
 * this is the diagnosis the neutral hint cannot make. Null when neither case applies.
 */
export function forbiddenNote(
  course: { endDate: string | null; isActive: boolean },
  nowMs: number = Date.now(),
): string | null {
  const { endDate } = course;
  if (endDate !== null && Date.parse(endDate) <= nowMs) {
    return `This course ended on ${endDate.slice(0, 10)}; 403 is normal after the term.`;
  }
  if (course.isActive) {
    return 'The course is active; the tool is probably disabled for learners here.';
  }
  return null;
}

/** PRD 6.3 list envelope. */
export interface ListEnvelope<T> {
  items: T[];
  count: number;
  fetchedAt: string;
}

export function listEnvelope<T>(items: T[], nowMs = Date.now()): ListEnvelope<T> {
  return { items, count: items.length, fetchedAt: isoAtMs(nowMs) };
}

export interface EmitListOptions {
  tsv?: { columns: readonly (string | Column)[]; rows?: readonly Row[] };
  human?: string | (() => string);
  /** Lossless payload: `--select` is ignored, `--wrap-untrusted` still applies. */
  raw?: boolean;
}

/** Writes a list in the chosen mode, then honours --fail-empty (exit 3, silent, output kept). */
export function emitList<T>(
  ctx: CliContext,
  envelope: ListEnvelope<T>,
  options: EmitListOptions = {},
): void {
  if (options.raw) {
    emitRaw(ctx, envelope);
  } else {
    emit(ctx, {
      value: envelope,
      tsv: options.tsv
        ? { columns: options.tsv.columns, rows: options.tsv.rows ?? (envelope.items as Row[]) }
        : undefined,
      human: options.human,
    });
  }
  if (ctx.globals.failEmpty && envelope.count === 0) throw new EmptyResultsError();
}

/** `--raw`: the payload as decoded, without `--select`; JSON in every mode but --plain. */
export function emitRaw(ctx: CliContext, value: unknown): void {
  const g = ctx.globals;
  if (g.outputMode === 'plain') {
    emit(ctx, { value });
    return;
  }
  const wrap = g.wrapUntrusted ? { id: ctx.markerId } : false;
  writeJson(ctx.stdout, value, { resultsOnly: g.resultsOnly, wrap });
}
