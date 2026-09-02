/**
 * Pagination helpers for the three D2L list shapes (d2l-api-web A-09, A-13, A-20):
 *
 * - PagedResultSet `{PagingInfo:{Bookmark,HasMoreItems}, Items}` — follow via `?bookmark=`,
 *   repeating every other query parameter (`sortBy` must match across segments);
 * - ObjectListPage `{Objects, Next}` — follow the absolute `Next` URL until null;
 * - page-numbered lists (`pageSize`/`pageNumber`, no HasMore) — stop on a short page.
 *
 * Each helper is an async iterable so `--limit` can stop early (breaking out of the loop issues
 * no further fetches), capped at DEFAULT_MAX_PAGES pages as a runaway guard. `fetchPage`
 * receives the URL of each page and returns the decoded JSON; the helper validates the shape.
 */
import { BsError } from '../errors.js';
import { displayPath } from './types.js';

export const DEFAULT_MAX_PAGES = 50;

export type FetchPage = (url: string) => Promise<unknown>;

export interface PageOptions {
  /** Runaway guard; default DEFAULT_MAX_PAGES. */
  maxPages?: number;
  /** Told when the cap stops the walk early ("results may be incomplete"). */
  warn?: (message: string) => void;
}

export interface PagedResultSet<T> {
  PagingInfo: { Bookmark?: string; HasMoreItems: boolean };
  Items: T[];
}

export interface ObjectListPage<T> {
  Objects: T[];
  Next?: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function badShape(expected: string, url: string): BsError {
  return new BsError(
    'error',
    `GET ${displayPath(url)}: unexpected response shape, expected ${expected}`,
    {
      hint: 'Run: bs auth doctor',
    },
  );
}

function asPagedResultSet<T>(page: unknown, url: string): PagedResultSet<T> {
  if (!isRecord(page) || !Array.isArray(page.Items) || !isRecord(page.PagingInfo)) {
    throw badShape('PagedResultSet {PagingInfo, Items}', url);
  }
  const info = page.PagingInfo;
  return {
    Items: page.Items as T[],
    PagingInfo: {
      Bookmark: typeof info.Bookmark === 'string' ? info.Bookmark : undefined,
      HasMoreItems: info.HasMoreItems === true,
    },
  };
}

function asObjectListPage<T>(page: unknown, url: string): ObjectListPage<T> {
  if (!isRecord(page) || !Array.isArray(page.Objects)) {
    throw badShape('ObjectListPage {Objects, Next}', url);
  }
  return {
    Objects: page.Objects as T[],
    Next: typeof page.Next === 'string' && page.Next !== '' ? page.Next : null,
  };
}

function asArray<T>(page: unknown, url: string): T[] {
  if (!Array.isArray(page)) throw badShape('a JSON array', url);
  return page as T[];
}

function withParam(url: string, key: string, value: string): string {
  const parsed = new URL(url);
  parsed.searchParams.set(key, value);
  return parsed.toString();
}

function capWarning(pages: number, url: string): string {
  return `stopped after ${pages} pages of GET ${displayPath(url)}; results may be incomplete`;
}

/** Walks a PagedResultSet collection following `HasMoreItems`/`Bookmark`. */
export async function* pagedResultSet<T>(
  url: string,
  fetchPage: FetchPage,
  options: PageOptions = {},
): AsyncGenerator<T, void, undefined> {
  const maxPages = options.maxPages ?? DEFAULT_MAX_PAGES;
  let next = url;
  for (let pages = 1; ; pages += 1) {
    const page = asPagedResultSet<T>(await fetchPage(next), next);
    yield* page.Items;
    const bookmark = page.PagingInfo.Bookmark;
    if (!page.PagingInfo.HasMoreItems || bookmark === undefined || bookmark === '') return;
    if (pages >= maxPages) {
      options.warn?.(capWarning(pages, url));
      return;
    }
    next = withParam(url, 'bookmark', bookmark);
  }
}

/** Walks an ObjectListPage collection following the absolute `Next` URL. */
export async function* objectListPage<T>(
  url: string,
  fetchPage: FetchPage,
  options: PageOptions = {},
): AsyncGenerator<T, void, undefined> {
  const maxPages = options.maxPages ?? DEFAULT_MAX_PAGES;
  let next: string | null = url;
  for (let pages = 1; next !== null; pages += 1) {
    const page: ObjectListPage<T> = asObjectListPage<T>(await fetchPage(next), next);
    yield* page.Objects;
    next = page.Next ?? null;
    if (next !== null && pages >= maxPages) {
      options.warn?.(capWarning(pages, url));
      return;
    }
  }
}

/** Walks a `pageSize`/`pageNumber` list (pageNumber from 1), stopping on a short page. */
export function pageNumbered<T>(
  url: string,
  fetchPage: FetchPage,
  pageSize: number,
  options: PageOptions = {},
): AsyncGenerator<T, void, undefined> {
  if (!Number.isInteger(pageSize) || pageSize < 1) {
    throw new Error(`pageNumbered: pageSize must be a positive integer (got ${pageSize})`);
  }
  const maxPages = options.maxPages ?? DEFAULT_MAX_PAGES;
  return (async function* walk() {
    for (let pages = 1; ; pages += 1) {
      const pageUrl = withParam(
        withParam(url, 'pageSize', String(pageSize)),
        'pageNumber',
        String(pages),
      );
      const items = asArray<T>(await fetchPage(pageUrl), pageUrl);
      yield* items;
      if (items.length < pageSize) return;
      if (pages >= maxPages) {
        options.warn?.(capWarning(pages, url));
        return;
      }
    }
  })();
}

/** Gathers an async iterable into an array, stopping after `limit` items when given. */
export async function collect<T>(iterable: AsyncIterable<T>, limit?: number): Promise<T[]> {
  const out: T[] = [];
  if (limit !== undefined && limit <= 0) return out;
  for await (const item of iterable) {
    out.push(item);
    if (limit !== undefined && out.length >= limit) break;
  }
  return out;
}
