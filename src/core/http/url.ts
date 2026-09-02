/**
 * URL builder with the D2L trailing-slash discipline (d2l-api-web Extra B): collections end
 * with `/`, single items do not, and a wrong slash is a 404. The builder therefore never adds
 * or removes slashes — the caller's `path` is used verbatim.
 */

export type QueryValue =
  | string
  | number
  | boolean
  | null
  | undefined
  | readonly (string | number | boolean)[];

export type Query = Record<string, QueryValue>;

/**
 * `baseUrl` must have no trailing slash (config.ts normalises it); `path` must start with `/`.
 * Query values are encoded with URLSearchParams; arrays repeat the key (`sortBy=a&sortBy=b`);
 * `undefined`/`null` values are omitted.
 */
export function d2lUrl(baseUrl: string, path: string, query: Query = {}): string {
  if (baseUrl === '') throw new Error('d2lUrl: base URL is empty');
  if (baseUrl.endsWith('/'))
    throw new Error(`d2lUrl: base URL must not end with a trailing slash: ${baseUrl}`);
  if (!path.startsWith('/'))
    throw new Error(`d2lUrl: path must start with a leading slash: ${path}`);
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) {
      for (const item of value) params.append(key, String(item));
    } else {
      params.append(key, String(value));
    }
  }
  const qs = params.toString();
  return qs === '' ? `${baseUrl}${path}` : `${baseUrl}${path}?${qs}`;
}
