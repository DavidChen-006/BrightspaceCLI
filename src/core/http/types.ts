/**
 * Wire-level types shared by the HTTP client, the classifier and the pagination helpers.
 */

/** Header names are lowercased on the way in so lookups never depend on casing. */
export type HeaderMap = Record<string, string>;

export interface HttpRequest {
  /** Case-insensitive; normalised to upper case before dispatch. */
  method: string;
  url: string;
  headers?: Record<string, string>;
  body?: string;
  /**
   * The read-only guard's single escape hatch (PRD 9): only the JWT mint POST may set it.
   * `X-HTTP-Method-Override` is rejected regardless.
   */
  allowMutation?: boolean;
  /** Caller cancellation (SIGINT). An abort here is exit 130 and is never retried. */
  signal?: AbortSignal;
  /** Time to first byte for this request; overrides the client default. */
  timeoutMs?: number;
}

/** A fully buffered response: what JSON routes and error classification work on. */
export interface HttpResponse {
  status: number;
  headers: HeaderMap;
  body: string;
  method: string;
  url: string;
}

/** A 2xx response whose body is still on the wire (file downloads). */
export interface HttpStream {
  status: number;
  headers: HeaderMap;
  body: ReadableStream<Uint8Array>;
  method: string;
  url: string;
}

export type StreamOutcome =
  | { ok: true; stream: HttpStream }
  | { ok: false; response: HttpResponse };

/** What the transport receives: headers already lowercased, secrets included. */
export interface TransportRequest {
  method: string;
  url: string;
  headers: HeaderMap;
  body?: string;
}

/** What a transport returns. Fakes may hand back a string body; fetch hands back a stream. */
export interface TransportResponse {
  status: number;
  headers: HeaderMap | Headers;
  body: string | ReadableStream<Uint8Array> | null;
}

export type Transport = (req: TransportRequest, signal: AbortSignal) => Promise<TransportResponse>;

/** Lowercases header names; accepts a plain record or a fetch `Headers`. */
export function normalizeHeaders(headers: HeaderMap | Headers | undefined): HeaderMap {
  const out: HeaderMap = {};
  if (headers === undefined) return out;
  if (typeof (headers as Headers).forEach === 'function' && !isPlainObject(headers)) {
    (headers as Headers).forEach((value, key) => {
      out[key.toLowerCase()] = value;
    });
    return out;
  }
  for (const [key, value] of Object.entries(headers as HeaderMap)) {
    out[key.toLowerCase()] = value;
  }
  return out;
}

function isPlainObject(value: unknown): boolean {
  return Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null;
}

/** `pathname?search` of a URL for logs and messages; never the host, never headers. */
export function displayPath(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.pathname}${parsed.search}`;
  } catch {
    return url;
  }
}
