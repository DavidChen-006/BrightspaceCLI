/**
 * `bs api <METHOD> <path> [--query k=v]... [--raw]` (PRD 6.2 api row, 9, 10; gogcli §7, §14):
 * one authenticated request against any `/d2l/...` route, the payload emitted losslessly.
 *
 * - METHOD is GET, HEAD or OPTIONS, checked here before any request (exit 2); the HTTP layer's
 *   read-only guard is the second line of defence. There is no `--header` flag, so
 *   `X-HTTP-Method-Override` cannot be smuggled in, and no `--body`: nothing bs sends has one.
 * - `path` must start with `/d2l/` (after URL normalisation, so `..` cannot escape it); a query
 *   already in the path is kept and `--query k=v` pairs are appended, URL-encoded by `d2lUrl`.
 * - The Bearer comes from `withData` (ladder, one re-mint on a 401). Non-2xx responses are
 *   classified like every other route (404 → 5, 403 → 6, 401 → re-mint once, then 4).
 * - A JSON body is emitted as the parsed value: `--select` projects it, `--wrap-untrusted` wraps
 *   its free-text leaves, `--plain` flattens it; a non-JSON body is printed as text (a JSON
 *   string under --json, so stdout stays JSON); `--raw` prints the body exactly as received in
 *   every mode. HEAD prints the response headers as an object.
 */
import { Argument, type Command, InvalidArgumentError, Option } from 'commander';
import type { TenantConfig } from '../../core/config.js';
import { UsageError } from '../../core/errors.js';
import { classify, d2lUrl, type HttpResponse, toError } from '../../core/http/index.js';
import { wrapUntrustedText } from '../../core/output.js';
import { type CliContext, emit } from '../context.js';
import { withData } from '../data.js';
import { typed } from '../options.js';

export const API_METHODS = ['GET', 'HEAD', 'OPTIONS'] as const;
export type ApiMethod = (typeof API_METHODS)[number];
const EXAMPLE_PATH = '/d2l/api/lp/1.62/users/whoami';

export function parseMethod(value: string): ApiMethod {
  const method = value.trim().toUpperCase();
  if (!(API_METHODS as readonly string[]).includes(method)) {
    throw new InvalidArgumentError(
      `expected GET, HEAD or OPTIONS; bs is read-only in v1, so ${method || value} is refused before any request.`,
    );
  }
  return method as ApiMethod;
}

export function parseApiPath(value: string): string {
  const path = value.trim();
  if (!path.startsWith('/d2l/')) {
    throw new InvalidArgumentError(
      `expected a path under /d2l/ on the session's tenant, e.g. ${EXAMPLE_PATH} (no scheme or host).`,
    );
  }
  return path;
}

export interface QueryPair {
  key: string;
  value: string;
}

/** Repeatable `--query k=v`: split at the first `=`; an empty value is allowed, an empty key is not. */
export function collectQuery(value: string, previous: QueryPair[] = []): QueryPair[] {
  const eq = value.indexOf('=');
  const key = eq < 0 ? '' : value.slice(0, eq);
  if (eq < 0 || key.trim() === '') {
    throw new InvalidArgumentError('expected key=value (repeat --query for several parameters).');
  }
  return [...previous, { key, value: value.slice(eq + 1) }];
}

/**
 * The request URL: the path normalised against the tenant (so it can neither leave `/d2l/` nor
 * name another host), its own query kept, the `--query` pairs appended.
 */
export function apiUrl(
  cfg: Pick<TenantConfig, 'baseUrl'>,
  path: string,
  query: QueryPair[],
): string {
  const tenant = new URL(cfg.baseUrl);
  const target = new URL(path, tenant);
  if (target.origin !== tenant.origin || !target.pathname.startsWith('/d2l/')) {
    throw new UsageError(`path must stay under /d2l/ on ${tenant.origin}: ${path}`, {
      hint: `Example: bs api GET ${EXAMPLE_PATH}`,
    });
  }
  const merged: Record<string, string[]> = {};
  const add = (k: string, v: string) => {
    const values = merged[k] ?? [];
    values.push(v);
    merged[k] = values;
  };
  for (const [k, v] of target.searchParams) add(k, v);
  for (const q of query) add(q.key, q.value);
  return d2lUrl(cfg.baseUrl, target.pathname, merged);
}

function parseJsonBody(body: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(body) };
  } catch {
    return { ok: false };
  }
}

/** Text passthrough: verbatim (one trailing newline), a JSON string under --json unless --raw. */
function emitText(ctx: CliContext, text: string, raw: boolean): void {
  const g = ctx.globals;
  if (g.outputMode === 'json' && !raw) {
    emit(ctx, { value: text });
    return;
  }
  if (text === '') return;
  const out = g.wrapUntrusted ? wrapUntrustedText(text, { id: ctx.markerId }) : text;
  ctx.stdout.write(out.endsWith('\n') ? out : `${out}\n`);
}

interface ApiOptions {
  query?: QueryPair[];
  raw?: boolean;
}

export function register(program: Command, ctx: CliContext): void {
  program
    .command('api')
    .description(
      'One authenticated request against any /d2l/ route (GET, HEAD or OPTIONS only); prints the lossless payload. For routes bs has no command for.',
    )
    .addArgument(
      new Argument('<method>', 'GET, HEAD or OPTIONS (bs is read-only)')
        .choices([...API_METHODS])
        .argParser(parseMethod),
    )
    .addArgument(
      new Argument(
        '<path>',
        `route path starting with /d2l/, e.g. ${EXAMPLE_PATH} (a ?query in it is kept)`,
      ).argParser(parseApiPath),
    )
    .addOption(
      typed(
        new Option('--query <k=v>', 'query parameter, URL-encoded for you (repeatable)').argParser(
          collectQuery,
        ),
        'list',
      ),
    )
    .option('--raw', 'print the response body exactly as received, even when it is JSON')
    .action(async (method: ApiMethod, path: string, opts: ApiOptions) => {
      const query = opts.query ?? [];
      const response = await withData(ctx, async (http, cfg): Promise<HttpResponse> => {
        const res = await http.request({ method, url: apiUrl(cfg, path, query) });
        const c = classify(res);
        if (c.kind !== 'ok') throw toError(c);
        return res;
      });

      if (method === 'HEAD') {
        emit(ctx, { value: response.headers, wrap: false });
        return;
      }
      if (opts.raw) {
        emitText(ctx, response.body, true);
        return;
      }
      const parsed = parseJsonBody(response.body);
      if (!parsed.ok) {
        emitText(ctx, response.body, false);
        return;
      }
      emit(ctx, { value: parsed.value });
    });
}
