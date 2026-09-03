/**
 * Response classification (PRD 9, 6.4): pure functions of (status, headers, body) that map a
 * response to a kind, an RFC-7807 problem (when the body is one), a message and a BsError.
 *
 * Order matters: the `sessionExpired=1` marker is the only ladder-climb signal and is checked
 * before the status (Brightspace-Bar Extra 2: the mint answers HTTP 200 with a redirect stub).
 */
import {
  AuthRequiredError,
  BsError,
  NotFoundError,
  PermissionDeniedError,
  RateLimitedError,
  RetryableError,
} from '../errors.js';
import { displayPath, type HttpResponse } from './types.js';

export const SESSION_EXPIRED_MARKER = 'sessionExpired=1';

/**
 * The hint on every PermissionDeniedError. Neutral by construction (bs-6j8): `classify()` sees
 * a status and a body, never the course, so it cannot know whether the term has ended. Commands
 * that already hold the enrollment append a diagnosis of their own — see `forbiddenNote()` in
 * `src/cli/data.ts`.
 */
export const FORBIDDEN_HINT =
  'Brightspace denied this route (HTTP 403). Your role may lack this permission in this course, or the course may be past-term.';

export type ClassKind =
  | 'ok'
  | 'SessionExpired'
  | 'AuthRequired'
  | 'NotFound'
  | 'Forbidden'
  | 'RateLimited'
  | 'Retryable'
  | 'Transport'
  | 'BadShape'
  | 'Failed';

export interface ProblemDetails {
  /** True when the body was a JSON object carrying `title` or `detail`. */
  isProblem: boolean;
  type?: string;
  status?: number;
  title?: string;
  detail?: string;
  instance?: string;
  /** Trimmed raw body; the fallback when the body is not problem+json. */
  text: string;
}

export interface Classification {
  kind: ClassKind;
  /** 0 for transport failures. */
  status: number;
  problem: ProblemDetails;
  /** Diagnosis line: `GET /path: HTTP 401 Unauthorized: Couldn't parse token`. */
  message: string;
  /** Method and path of the request, for callers composing their own messages. */
  route: string;
}

export interface ClassifyOptions {
  /** The JWT mint route: a 403 there means the session cookie died, not a permission gap. */
  mint?: boolean;
  /** A 2xx whose body does not decode as JSON becomes `BadShape`. */
  expectJson?: boolean;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/** Parses an RFC-7807 body when it is one; otherwise returns the trimmed text. */
export function problemDetails(body: string): ProblemDetails {
  const text = body.trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { isProblem: false, text };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { isProblem: false, text };
  }
  const record = parsed as Record<string, unknown>;
  const title = optionalString(record.title);
  const detail = optionalString(record.detail);
  if (title === undefined && detail === undefined) return { isProblem: false, text };
  const rawStatus = record.status;
  const status =
    typeof rawStatus === 'number'
      ? rawStatus
      : typeof rawStatus === 'string' && /^\d+$/.test(rawStatus)
        ? Number(rawStatus)
        : undefined;
  return {
    isProblem: true,
    type: optionalString(record.type),
    status,
    title,
    detail,
    instance: optionalString(record.instance),
    text,
  };
}

const MESSAGE_TEXT_LIMIT = 160;

/** One line, bounded length, for error messages built from arbitrary (often HTML) bodies. */
function summarize(text: string): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  return collapsed.length > MESSAGE_TEXT_LIMIT
    ? `${collapsed.slice(0, MESSAGE_TEXT_LIMIT - 1)}…`
    : collapsed;
}

function describeHttp(status: number, problem: ProblemDetails): string {
  if (problem.isProblem) {
    const title = problem.title ? ` ${problem.title}` : '';
    const detail = problem.detail ? `: ${problem.detail}` : '';
    return `HTTP ${status}${title}${detail}`;
  }
  const text = summarize(problem.text);
  return text === '' ? `HTTP ${status}` : `HTTP ${status}: ${text}`;
}

function isJson(body: string): boolean {
  try {
    JSON.parse(body);
    return true;
  } catch {
    return false;
  }
}

export function classify(
  input: HttpResponse | Error,
  options: ClassifyOptions = {},
): Classification {
  if (input instanceof Error) {
    return {
      kind: 'Transport',
      status: 0,
      problem: { isProblem: false, text: '' },
      message: input.message,
      route: '',
    };
  }
  const response = input;
  const route = `${response.method.toUpperCase()} ${displayPath(response.url)}`;
  const problem = problemDetails(response.body);
  const status = response.status;
  const kind = classifyKind(response, options);
  const message =
    kind === 'SessionExpired'
      ? `${route}: session expired`
      : kind === 'BadShape'
        ? `${route}: expected JSON but the ${status} body did not decode`
        : `${route}: ${describeHttp(status, problem)}`;
  return { kind, status, problem, message, route };
}

function classifyKind(response: HttpResponse, options: ClassifyOptions): ClassKind {
  const { status, body } = response;
  if (body.includes(SESSION_EXPIRED_MARKER)) return 'SessionExpired';
  if (status >= 200 && status < 300) {
    return options.expectJson && !isJson(body) ? 'BadShape' : 'ok';
  }
  if (status === 401) return 'AuthRequired';
  if (status === 403) return options.mint ? 'SessionExpired' : 'Forbidden';
  if (status === 404) return 'NotFound';
  if (status === 429) return 'RateLimited';
  if (status >= 500) return 'Retryable';
  return 'Failed';
}

/** Maps a classification to the BsError subclass carrying the right exit code and hint. */
export function toError(c: Classification): BsError {
  switch (c.kind) {
    case 'ok':
      return new BsError('error', `${c.message} (unexpected: response was ok)`);
    case 'SessionExpired':
    case 'AuthRequired':
      return new AuthRequiredError(c.message);
    case 'NotFound':
      return new NotFoundError(c.message, {
        hint: 'Check the id and the trailing slash: collections end with "/", single items do not.',
      });
    case 'Forbidden':
      return new PermissionDeniedError(c.message, { hint: FORBIDDEN_HINT });
    case 'RateLimited':
      return new RateLimitedError(c.message);
    case 'Retryable':
    case 'Transport':
      return new RetryableError(c.message);
    case 'BadShape':
      return new BsError('error', c.message, { hint: 'Run: bs auth doctor' });
    default:
      return new BsError('error', c.message);
  }
}

/** Classifies then parses: the typed value on an ok JSON response, a BsError otherwise. */
export function readJson<T>(response: HttpResponse, options: ClassifyOptions = {}): T {
  const c = classify(response, { ...options, expectJson: true });
  if (c.kind !== 'ok') throw toError(c);
  return JSON.parse(response.body) as T;
}
