/**
 * The HTTP layer (PRD 9): one client seam, classification, pagination, fan-out and URLs.
 * Commands import from here: `import { createHttp, withBearer, d2lUrl } from '../core/http/index.js'`.
 */
export {
  type Classification,
  type ClassifyOptions,
  type ClassKind,
  classify,
  FORBIDDEN_HINT,
  type ProblemDetails,
  problemDetails,
  readJson,
  SESSION_EXPIRED_MARKER,
  toError,
} from './classify.js';
export {
  createHttp,
  DEFAULT_TIMEOUT_MS,
  fetchTransport,
  type HttpClient,
  type HttpOptions,
  MAX_5XX_RETRIES,
  MAX_NETWORK_RETRIES,
  MAX_RATE_LIMIT_RETRIES,
  NETWORK_RETRY_DELAY_MS,
  RATE_LIMIT_BASE_DELAY_MS,
  SERVER_ERROR_RETRY_DELAY_MS,
  type Sleep,
  withBearer,
} from './client.js';
export {
  collect,
  DEFAULT_MAX_PAGES,
  type FetchPage,
  type ObjectListPage,
  objectListPage,
  type PagedResultSet,
  type PageOptions,
  pagedResultSet,
  pageNumbered,
} from './paginate.js';
export { boundedPool, type PoolResult } from './pool.js';
export {
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
export { d2lUrl, type Query, type QueryValue } from './url.js';
