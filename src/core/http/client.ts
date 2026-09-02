/**
 * The one HTTP seam (PRD 9). Every request bs makes goes through `createHttp()`:
 *
 * - read-only guard before dispatch (GET/HEAD/OPTIONS; the mint's `allowMutation` is the only
 *   escape; `X-HTTP-Method-Override` is always rejected) — gogcli §7;
 * - time-to-first-byte timeout via AbortSignal; a streaming body is never cut off once headers
 *   have arrived — gogcli §10;
 * - retries: 429 ×3 honoring Retry-After else 1s<<attempt + jitter in [0, base/2); 5xx ×1 after
 *   1 s; network/timeout ×1; 4xx never. After exhaustion the last response is returned so the
 *   classifier maps it to exit 7/8 — gogcli §9;
 * - `--verbose` logs method, path, status, elapsed, X-Request-Cost and X-Rate-Limit-Remaining;
 *   never a header value (PRD 8.2).
 */
import { CancelledError, RetryableError, UsageError } from '../errors.js';
import { type ClassifyOptions, readJson } from './classify.js';
import {
  displayPath,
  type HeaderMap,
  type HttpRequest,
  type HttpResponse,
  type HttpStream,
  normalizeHeaders,
  type StreamOutcome,
  type Transport,
  type TransportRequest,
  type TransportResponse,
} from './types.js';

export const MAX_RATE_LIMIT_RETRIES = 3;
export const RATE_LIMIT_BASE_DELAY_MS = 1000;
export const MAX_5XX_RETRIES = 1;
export const SERVER_ERROR_RETRY_DELAY_MS = 1000;
export const MAX_NETWORK_RETRIES = 1;
export const NETWORK_RETRY_DELAY_MS = 1000;
export const DEFAULT_TIMEOUT_MS = 30_000;

const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const METHOD_OVERRIDE_HEADER = 'x-http-method-override';

export type Sleep = (ms: number, signal?: AbortSignal) => Promise<void>;

export interface HttpOptions {
  /** Defaults to global fetch. Tests inject a fake. */
  transport?: Transport;
  /** Milliseconds since the epoch; used for elapsed time and Retry-After dates. */
  clock?: () => number;
  sleep?: Sleep;
  /** Uniform in [0, 1); used for retry jitter. */
  random?: () => number;
  /** Receives verbose lines (secret-free by construction). */
  log?: (line: string) => void;
  /** Time to first byte; from `--timeout` (seconds × 1000). */
  timeoutMs?: number;
  verbose?: boolean;
}

export interface HttpClient {
  readonly timeoutMs: number;
  /** Buffered request. Throws UsageError (guard), CancelledError, RetryableError (network). */
  request(req: HttpRequest): Promise<HttpResponse>;
  /** Streaming request: the body stream on 2xx, else a buffered response for classification. */
  requestStream(req: HttpRequest): Promise<StreamOutcome>;
  /** `request` + `readJson`: the typed value, or the classified BsError. */
  json<T>(req: HttpRequest, options?: ClassifyOptions): Promise<T>;
}

/** Attaches `Authorization: Bearer <token>` without mutating the input. */
export function withBearer(req: HttpRequest, token: string): HttpRequest {
  return { ...req, headers: { ...req.headers, Authorization: `Bearer ${token}` } };
}

/** The production transport: global fetch, headers as given, body as a stream. */
export const fetchTransport: Transport = async (req, signal) => {
  const res = await fetch(req.url, {
    method: req.method,
    headers: req.headers,
    body: req.body,
    signal,
  });
  return { status: res.status, headers: res.headers, body: res.body };
};

const defaultSleep: Sleep = (ms, signal) =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    function onAbort() {
      clearTimeout(timer);
      reject(signal?.reason);
    }
    signal?.addEventListener('abort', onAbort, { once: true });
  });

function readOnlyError(message: string): UsageError {
  return new UsageError(message, {
    hint: 'bs only sends GET/HEAD/OPTIONS requests (PRD 3: read-only in v1).',
  });
}

class TimeoutError extends Error {
  constructor(ms: number) {
    super(`timed out after ${ms} ms waiting for response headers`);
    this.name = 'TimeoutError';
  }
}

/** Errors thrown by fetch on network trouble carry a nested cause with the real reason. */
function describeFailure(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const cause = (err as { cause?: unknown }).cause;
  const causeText =
    cause instanceof Error ? cause.message : typeof cause === 'string' ? cause : undefined;
  return causeText && causeText !== err.message ? `${err.message} (${causeText})` : err.message;
}

const SECRET_HEADERS = ['authorization', 'cookie', 'x-csrf-token'] as const;

/** Header secrets must never reach a log line or an error message, even via a transport error. */
function scrub(text: string, headers: HeaderMap): string {
  let out = text.replace(/Bearer\s+\S+/gi, 'Bearer <redacted>');
  for (const name of SECRET_HEADERS) {
    const value = headers[name];
    if (value !== undefined && value !== '') out = out.split(value).join('<redacted>');
    const bare = value?.replace(/^Bearer\s+/i, '');
    if (bare !== undefined && bare !== '') out = out.split(bare).join('<redacted>');
  }
  return out;
}

function parseRetryAfter(value: string | undefined, now: number): number | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1000;
  const at = Date.parse(trimmed);
  if (Number.isNaN(at)) return undefined;
  return Math.max(0, at - now);
}

async function drain(body: TransportResponse['body']): Promise<void> {
  if (typeof body === 'object' && body !== null) {
    try {
      await body.cancel();
    } catch {
      // A body we are discarding anyway.
    }
  }
}

async function readText(body: TransportResponse['body']): Promise<string> {
  if (body === null) return '';
  if (typeof body === 'string') return body;
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function toStream(body: TransportResponse['body']): ReadableStream<Uint8Array> {
  if (typeof body === 'object' && body !== null) return body;
  const bytes = new TextEncoder().encode(body ?? '');
  return new ReadableStream<Uint8Array>({
    start(controller) {
      if (bytes.length > 0) controller.enqueue(bytes);
      controller.close();
    },
  });
}

export function createHttp(options: HttpOptions = {}): HttpClient {
  const transport = options.transport ?? fetchTransport;
  const clock = options.clock ?? Date.now;
  const sleep = options.sleep ?? defaultSleep;
  const random = options.random ?? Math.random;
  const verbose = options.verbose ?? false;
  const log = verbose && options.log ? options.log : () => {};
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  function guard(req: HttpRequest, headers: HeaderMap, method: string): void {
    const path = displayPath(req.url);
    if (METHOD_OVERRIDE_HEADER in headers) {
      throw readOnlyError(`refusing ${method} ${path}: X-HTTP-Method-Override is not allowed`);
    }
    if (READ_METHODS.has(method) || req.allowMutation === true) return;
    throw readOnlyError(`refusing ${method} ${path}: bs is read-only`);
  }

  /** One attempt: header timeout armed, cleared as soon as the transport resolves. */
  async function attempt(treq: TransportRequest, req: HttpRequest): Promise<TransportResponse> {
    const ms = req.timeoutMs ?? timeoutMs;
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort(new TimeoutError(ms));
    }, ms);
    const onCancel = () => controller.abort(req.signal?.reason ?? new CancelledError());
    req.signal?.addEventListener('abort', onCancel, { once: true });
    try {
      return await transport(treq, controller.signal);
    } catch (err) {
      if (req.signal?.aborted) throw new CancelledError();
      if (timedOut) throw new TimeoutError(ms);
      throw err;
    } finally {
      clearTimeout(timer);
      req.signal?.removeEventListener('abort', onCancel);
    }
  }

  /** Guard, then the retry loop. Returns the final raw response; throws only for the guard,
   *  cancellation, or a network failure that survived its retry. */
  async function dispatch(req: HttpRequest): Promise<TransportResponse> {
    const method = req.method.toUpperCase();
    const headers = normalizeHeaders(req.headers);
    guard(req, headers, method);
    if (req.signal?.aborted) throw new CancelledError();
    const treq: TransportRequest = { method, url: req.url, headers, body: req.body };
    const path = displayPath(req.url);
    let retries429 = 0;
    let retries5xx = 0;
    let retriesNet = 0;

    for (;;) {
      const started = clock();
      let res: TransportResponse;
      try {
        res = await attempt(treq, req);
      } catch (err) {
        if (err instanceof CancelledError) throw err;
        const elapsed = clock() - started;
        const reason = scrub(describeFailure(err), headers);
        if (retriesNet < MAX_NETWORK_RETRIES) {
          retriesNet += 1;
          log(
            `http ${method} ${path} -> failed (${elapsed} ms): ${reason}; retry ${retriesNet}/${MAX_NETWORK_RETRIES} in ${NETWORK_RETRY_DELAY_MS} ms (network)`,
          );
          await sleep(NETWORK_RETRY_DELAY_MS, req.signal);
          continue;
        }
        log(`http ${method} ${path} -> failed (${elapsed} ms): ${reason}`);
        throw new RetryableError(`${method} ${path}: ${reason}`, { cause: err });
      }

      const elapsed = clock() - started;
      const resHeaders = normalizeHeaders(res.headers);
      const cost = resHeaders['x-request-cost'];
      const remaining = resHeaders['x-rate-limit-remaining'];
      const meta = `${cost === undefined ? '' : ` cost=${cost}`}${remaining === undefined ? '' : ` remaining=${remaining}`}`;
      const line = `http ${method} ${path} -> ${res.status} (${elapsed} ms)${meta}`;

      if (res.status === 429 && retries429 < MAX_RATE_LIMIT_RETRIES) {
        const retryAfter = parseRetryAfter(resHeaders['retry-after'], clock());
        const base = RATE_LIMIT_BASE_DELAY_MS * 2 ** retries429;
        const delay = retryAfter ?? Math.floor(base + random() * (base / 2));
        retries429 += 1;
        log(
          `${line}; retry ${retries429}/${MAX_RATE_LIMIT_RETRIES} in ${delay} ms (${retryAfter === undefined ? 'backoff' : 'Retry-After'})`,
        );
        await drain(res.body);
        await sleep(delay, req.signal);
        continue;
      }
      if (res.status >= 500 && retries5xx < MAX_5XX_RETRIES) {
        retries5xx += 1;
        log(
          `${line}; retry ${retries5xx}/${MAX_5XX_RETRIES} in ${SERVER_ERROR_RETRY_DELAY_MS} ms (5xx)`,
        );
        await drain(res.body);
        await sleep(SERVER_ERROR_RETRY_DELAY_MS, req.signal);
        continue;
      }
      log(line);
      return res;
    }
  }

  async function request(req: HttpRequest): Promise<HttpResponse> {
    const res = await dispatch(req);
    return {
      status: res.status,
      headers: normalizeHeaders(res.headers),
      body: await readText(res.body),
      method: req.method.toUpperCase(),
      url: req.url,
    };
  }

  async function requestStream(req: HttpRequest): Promise<StreamOutcome> {
    const res = await dispatch(req);
    const method = req.method.toUpperCase();
    const headers = normalizeHeaders(res.headers);
    if (res.status >= 200 && res.status < 300) {
      const stream: HttpStream = {
        status: res.status,
        headers,
        body: toStream(res.body),
        method,
        url: req.url,
      };
      return { ok: true, stream };
    }
    const response: HttpResponse = {
      status: res.status,
      headers,
      body: await readText(res.body),
      method,
      url: req.url,
    };
    return { ok: false, response };
  }

  return {
    timeoutMs,
    request,
    requestStream,
    async json<T>(req: HttpRequest, opts: ClassifyOptions = {}): Promise<T> {
      return readJson<T>(await request(req), opts);
    },
  };
}
