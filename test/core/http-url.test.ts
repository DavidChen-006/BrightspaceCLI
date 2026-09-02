import assert from 'node:assert/strict';
import { test } from 'node:test';
import { d2lUrl } from '../../src/core/http/index.js';

const BASE = 'https://purdue.brightspace.com';

test('d2lUrl joins base and path verbatim, never touching the trailing slash', () => {
  assert.equal(
    d2lUrl(BASE, '/d2l/api/lp/1.62/enrollments/myenrollments/'),
    `${BASE}/d2l/api/lp/1.62/enrollments/myenrollments/`,
  );
  assert.equal(
    d2lUrl(BASE, '/d2l/api/le/1.96/412690/quizzes/7'),
    `${BASE}/d2l/api/le/1.96/412690/quizzes/7`,
  );
});

test('d2lUrl encodes query values and repeats array values', () => {
  const url = d2lUrl(BASE, '/d2l/api/lp/1.62/enrollments/myenrollments/', {
    orgUnitTypeId: 3,
    sortBy: ['-EndDate', 'OrgUnitName'],
    startDateTime: '2026-09-02T00:00:00.000Z',
    canAccess: true,
    q: 'a b&c=d',
  });
  const parsed = new URL(url);
  assert.equal(parsed.pathname, '/d2l/api/lp/1.62/enrollments/myenrollments/');
  assert.equal(parsed.searchParams.get('orgUnitTypeId'), '3');
  assert.deepEqual(parsed.searchParams.getAll('sortBy'), ['-EndDate', 'OrgUnitName']);
  assert.equal(parsed.searchParams.get('startDateTime'), '2026-09-02T00:00:00.000Z');
  assert.equal(parsed.searchParams.get('canAccess'), 'true');
  assert.equal(parsed.searchParams.get('q'), 'a b&c=d');
  assert.doesNotMatch(url, /a b/);
});

test('d2lUrl skips undefined/null values and omits the ? when the query is empty', () => {
  assert.equal(d2lUrl(BASE, '/x/', {}), `${BASE}/x/`);
  assert.equal(d2lUrl(BASE, '/x/', { a: undefined, b: null }), `${BASE}/x/`);
  assert.equal(d2lUrl(BASE, '/x/', { a: undefined, b: 0, c: '' }), `${BASE}/x/?b=0&c=`);
});

test('d2lUrl rejects a path without a leading slash or a base with a trailing slash', () => {
  assert.throws(() => d2lUrl(BASE, 'd2l/api'), /leading/);
  assert.throws(() => d2lUrl(`${BASE}/`, '/d2l/api'), /trailing/);
  assert.throws(() => d2lUrl('', '/d2l/api'), /base/);
});
