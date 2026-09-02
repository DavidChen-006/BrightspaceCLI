import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BsError } from '../../src/core/errors.js';
import {
  collect,
  DEFAULT_MAX_PAGES,
  objectListPage,
  pagedResultSet,
  pageNumbered,
} from '../../src/core/http/index.js';

const BASE = 'https://purdue.brightspace.com';
const ENROLL = `${BASE}/d2l/api/lp/1.62/enrollments/myenrollments/?orgUnitTypeId=3&sortBy=-EndDate&sortBy=OrgUnitName`;

function recorder<T>(pages: Record<string, T> | ((url: string) => T)) {
  const urls: string[] = [];
  return {
    urls,
    fetchPage: async (url: string): Promise<unknown> => {
      urls.push(url);
      if (typeof pages === 'function') return pages(url);
      const page = pages[url];
      if (page === undefined) throw new Error(`unexpected url ${url}`);
      return page;
    },
  };
}

// ---------------------------------------------------------------- PagedResultSet (bookmark)

test('pagedResultSet follows HasMoreItems/Bookmark via ?bookmark= and repeats the other params', async () => {
  const r = recorder({
    [ENROLL]: { PagingInfo: { Bookmark: '100', HasMoreItems: true }, Items: [1, 2] },
    [`${ENROLL}&bookmark=100`]: {
      PagingInfo: { Bookmark: '200', HasMoreItems: true },
      Items: [3],
    },
    [`${ENROLL}&bookmark=200`]: {
      PagingInfo: { Bookmark: '300', HasMoreItems: false },
      Items: [4],
    },
  });
  const items = await collect(pagedResultSet<number>(ENROLL, r.fetchPage));
  assert.deepEqual(items, [1, 2, 3, 4]);
  assert.equal(r.urls.length, 3);
  assert.ok(r.urls.every((u) => u.includes('sortBy=-EndDate&sortBy=OrgUnitName')));
});

test('pagedResultSet replaces an existing bookmark param instead of appending a second one', async () => {
  const first = `${BASE}/x/?bookmark=old&a=1`;
  const r = recorder((url) =>
    url === first
      ? { PagingInfo: { Bookmark: 'new', HasMoreItems: true }, Items: ['a'] }
      : { PagingInfo: { Bookmark: '', HasMoreItems: false }, Items: ['b'] },
  );
  assert.deepEqual(await collect(pagedResultSet<string>(first, r.fetchPage)), ['a', 'b']);
  assert.equal(r.urls[1], `${BASE}/x/?bookmark=new&a=1`);
});

test('pagedResultSet with an empty set yields nothing and makes one call', async () => {
  const r = recorder({
    [ENROLL]: { PagingInfo: { Bookmark: '', HasMoreItems: false }, Items: [] },
  });
  assert.deepEqual(await collect(pagedResultSet(ENROLL, r.fetchPage)), []);
  assert.equal(r.urls.length, 1);
});

test('pagedResultSet stops when HasMoreItems is true but the bookmark is missing (no infinite loop)', async () => {
  const r = recorder({ [ENROLL]: { PagingInfo: { HasMoreItems: true }, Items: [1] } });
  assert.deepEqual(await collect(pagedResultSet(ENROLL, r.fetchPage)), [1]);
  assert.equal(r.urls.length, 1);
});

test('pagedResultSet caps at 50 pages and warns', async () => {
  assert.equal(DEFAULT_MAX_PAGES, 50);
  const r = recorder(() => ({ PagingInfo: { Bookmark: 'b', HasMoreItems: true }, Items: [1] }));
  const warnings: string[] = [];
  const items = await collect(
    pagedResultSet<number>(ENROLL, r.fetchPage, { warn: (m) => warnings.push(m) }),
  );
  assert.equal(items.length, 50);
  assert.equal(r.urls.length, 50);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0] ?? '', /50 pages/);
  assert.match(warnings[0] ?? '', /incomplete/);
});

test('pagedResultSet honors a custom maxPages', async () => {
  const r = recorder(() => ({ PagingInfo: { Bookmark: 'b', HasMoreItems: true }, Items: [1] }));
  const items = await collect(pagedResultSet<number>(ENROLL, r.fetchPage, { maxPages: 2 }));
  assert.equal(items.length, 2);
});

test('pagedResultSet rejects a page that is not a PagedResultSet', async () => {
  for (const bad of [null, [], { Items: 'nope' }, { Objects: [] }, { PagingInfo: {}, Items: {} }]) {
    const r = recorder(() => bad);
    await assert.rejects(collect(pagedResultSet(ENROLL, r.fetchPage)), (err: unknown) => {
      assert.ok(err instanceof BsError);
      assert.equal(err.exitCode, 1);
      assert.match(err.message, /PagedResultSet/);
      assert.match(err.message, /myenrollments/);
      return true;
    });
  }
});

test('early stop: breaking out of the iterator issues no further page fetches', async () => {
  const r = recorder(() => ({ PagingInfo: { Bookmark: 'b', HasMoreItems: true }, Items: [1, 2] }));
  const seen: number[] = [];
  for await (const item of pagedResultSet<number>(ENROLL, r.fetchPage)) {
    seen.push(item);
    if (seen.length === 3) break;
  }
  assert.deepEqual(seen, [1, 2, 1]);
  assert.equal(r.urls.length, 2);
});

test('collect(iterable, limit) stops early at the limit', async () => {
  const r = recorder(() => ({ PagingInfo: { Bookmark: 'b', HasMoreItems: true }, Items: [1, 2] }));
  assert.deepEqual(await collect(pagedResultSet<number>(ENROLL, r.fetchPage), 3), [1, 2, 1]);
  assert.equal(r.urls.length, 2);
  assert.deepEqual(await collect(pagedResultSet<number>(ENROLL, r.fetchPage), 0), []);
});

// ---------------------------------------------------------------- ObjectListPage (Next)

test('objectListPage follows the absolute Next URL until it is null', async () => {
  const first = `${BASE}/d2l/api/le/1.96/412690/quizzes/`;
  const r = recorder({
    [first]: { Objects: ['q1', 'q2'], Next: `${BASE}/d2l/api/le/1.96/412690/quizzes/?bookmark=2` },
    [`${BASE}/d2l/api/le/1.96/412690/quizzes/?bookmark=2`]: { Objects: ['q3'], Next: null },
  });
  assert.deepEqual(await collect(objectListPage<string>(first, r.fetchPage)), ['q1', 'q2', 'q3']);
  assert.equal(r.urls.length, 2);
});

test('objectListPage treats a missing or empty Next as the last page', async () => {
  for (const last of [{ Objects: ['a'] }, { Objects: ['a'], Next: '' }]) {
    const r = recorder(() => last);
    assert.deepEqual(await collect(objectListPage<string>(`${BASE}/q/`, r.fetchPage)), ['a']);
    assert.equal(r.urls.length, 1);
  }
});

test('objectListPage caps at 50 pages and warns; stops on a Next that repeats itself', async () => {
  const url = `${BASE}/q/`;
  const loop = recorder(() => ({ Objects: [1], Next: url }));
  const warnings: string[] = [];
  const items = await collect(
    objectListPage<number>(url, loop.fetchPage, { warn: (m) => warnings.push(m) }),
  );
  assert.equal(items.length, 50);
  assert.equal(warnings.length, 1);
});

test('objectListPage rejects a page without an Objects array', async () => {
  const r = recorder(() => ({ Items: [] }));
  await assert.rejects(
    collect(objectListPage(`${BASE}/q/`, r.fetchPage)),
    (err: unknown) => err instanceof BsError && /ObjectListPage/.test(err.message),
  );
});

// ---------------------------------------------------------------- page-numbered

test('pageNumbered sets pageSize/pageNumber from 1 and stops on a short page', async () => {
  const posts = `${BASE}/d2l/api/le/1.96/1/discussions/forums/2/topics/3/posts/?threadsOnly=true`;
  const r = recorder((url) => {
    const n = Number(new URL(url).searchParams.get('pageNumber'));
    if (n === 1) return ['p1', 'p2'];
    if (n === 2) return ['p3', 'p4'];
    return ['p5'];
  });
  const items = await collect(pageNumbered<string>(posts, r.fetchPage, 2));
  assert.deepEqual(items, ['p1', 'p2', 'p3', 'p4', 'p5']);
  assert.deepEqual(r.urls, [
    `${posts}&pageSize=2&pageNumber=1`,
    `${posts}&pageSize=2&pageNumber=2`,
    `${posts}&pageSize=2&pageNumber=3`,
  ]);
});

test('pageNumbered stops on an empty page and on an exact-multiple set', async () => {
  const empty = recorder(() => []);
  assert.deepEqual(await collect(pageNumbered(`${BASE}/p/`, empty.fetchPage, 10)), []);
  assert.equal(empty.urls.length, 1);
  const exact = recorder((url) =>
    new URL(url).searchParams.get('pageNumber') === '1' ? [1, 2] : [],
  );
  assert.deepEqual(await collect(pageNumbered<number>(`${BASE}/p/`, exact.fetchPage, 2)), [1, 2]);
  assert.equal(exact.urls.length, 2);
});

test('pageNumbered caps at 50 pages and rejects non-array pages and a bad pageSize', async () => {
  const forever = recorder(() => [1]);
  const warnings: string[] = [];
  const items = await collect(
    pageNumbered<number>(`${BASE}/p/`, forever.fetchPage, 1, { warn: (m) => warnings.push(m) }),
  );
  assert.equal(items.length, 50);
  assert.equal(warnings.length, 1);
  const bad = recorder(() => ({ Objects: [] }));
  await assert.rejects(
    collect(pageNumbered(`${BASE}/p/`, bad.fetchPage, 5)),
    (err: unknown) => err instanceof BsError && /array/.test(err.message),
  );
  assert.throws(() => pageNumbered(`${BASE}/p/`, bad.fetchPage, 0), /pageSize/);
});
