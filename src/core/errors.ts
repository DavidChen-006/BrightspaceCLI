/**
 * Typed errors and the exit-code contract (PRD 6.4).
 *
 * This module is the ONLY source of exit codes. Commands throw a BsError subclass; the
 * root runner maps it with exitCodeFor() and prints formatError() to stderr. Nothing
 * outside src/bin/bs.ts calls process.exit.
 */

export const EXIT_CODES = {
  ok: 0,
  error: 1,
  usage: 2,
  empty_results: 3,
  auth_required: 4,
  not_found: 5,
  permission_denied: 6,
  rate_limited: 7,
  retryable: 8,
  config: 10,
  cancelled: 130,
} as const;

export type ExitCodeName = keyof typeof EXIT_CODES;
export type ExitCode = (typeof EXIT_CODES)[ExitCodeName];

export interface BsErrorOptions {
  /** A copy-pasteable next step, e.g. "Run: bs auth login". Printed indented under the message. */
  hint?: string;
  cause?: unknown;
  /** Silent errors set the exit code but print nothing (empty results, cancellation). */
  silent?: boolean;
}

export class BsError extends Error {
  readonly exitName: ExitCodeName;
  readonly hint: string | undefined;
  readonly silent: boolean;

  constructor(exitName: ExitCodeName, message: string, options: BsErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'BsError';
    this.exitName = exitName;
    this.hint = options.hint;
    this.silent = options.silent ?? false;
  }

  get exitCode(): ExitCode {
    return EXIT_CODES[this.exitName];
  }
}

function subclass(name: string, exitName: ExitCodeName, defaults: BsErrorOptions = {}) {
  return class extends BsError {
    constructor(message: string, options: BsErrorOptions = {}) {
      super(exitName, message, { ...defaults, ...options });
      this.name = name;
    }
  };
}

/** Bad flags/args, --json with --plain, refused prompt, mutation under readonly. */
export class UsageError extends subclass('UsageError', 'usage', {
  hint: 'Run: bs --help  (or: bs schema --json for the full contract)',
}) {}

/** A list command returned nothing and --fail-empty was given. Silent. */
export class EmptyResultsError extends subclass('EmptyResultsError', 'empty_results', {
  silent: true,
}) {
  constructor(message = 'no results', options: BsErrorOptions = {}) {
    super(message, options);
  }
}

/** No session, expired and the silent rung failed, or --no-input suppressed a login. */
export class AuthRequiredError extends subclass('AuthRequiredError', 'auth_required', {
  hint: 'Run: bs auth login',
}) {}

/** HTTP 404 (except the documented "no grades" 404s). */
export class NotFoundError extends subclass('NotFoundError', 'not_found') {}

/** HTTP 403 on a data route (past-term course, learner-blocked route). */
export class PermissionDeniedError extends subclass('PermissionDeniedError', 'permission_denied') {}

/** HTTP 429 after retries. */
export class RateLimitedError extends subclass('RateLimitedError', 'rate_limited', {
  hint: 'Wait a moment and retry.',
}) {}

/** HTTP 5xx after retry, network, timeout, DNS/TLS. */
export class RetryableError extends subclass('RetryableError', 'retryable', {
  hint: 'Retry; if it persists run: bs auth doctor',
}) {}

/** Root not writable, browser missing, unsupported API version, bad base URL. */
export class ConfigError extends subclass('ConfigError', 'config') {}

/** SIGINT / aborted. Silent. */
export class CancelledError extends subclass('CancelledError', 'cancelled', { silent: true }) {
  constructor(message = 'cancelled', options: BsErrorOptions = {}) {
    super(message, options);
  }
}

interface CommanderLikeError {
  code: string;
  message: string;
}

/** Duck-typed so this module never depends on commander. */
export function isCommanderError(err: unknown): err is CommanderLikeError {
  return (
    typeof err === 'object' &&
    err !== null &&
    typeof (err as { code?: unknown }).code === 'string' &&
    (err as { code: string }).code.startsWith('commander.')
  );
}

const COMMANDER_OK = new Set(['commander.helpDisplayed', 'commander.version']);

export function exitCodeFor(err: unknown): number {
  if (err instanceof BsError) return err.exitCode;
  if (isCommanderError(err)) {
    // commander.help = help shown because no subcommand was given: a usage problem.
    return COMMANDER_OK.has(err.code) ? EXIT_CODES.ok : EXIT_CODES.usage;
  }
  if (err instanceof Error && err.name === 'AbortError') return EXIT_CODES.cancelled;
  return EXIT_CODES.error;
}

export function isSilent(err: unknown): boolean {
  return err instanceof BsError && err.silent;
}

/**
 * gogcli 13 style: diagnosis line, blank line, indented copy-pasteable next step.
 * Commander errors return '' because commander has already written its own message.
 */
export function formatError(err: unknown): string {
  if (isCommanderError(err)) return '';
  if (err instanceof BsError) {
    return err.hint ? `bs: ${err.message}\n\n  ${err.hint}` : `bs: ${err.message}`;
  }
  if (err instanceof Error) return `bs: ${err.message}`;
  return `bs: ${String(err)}`;
}
