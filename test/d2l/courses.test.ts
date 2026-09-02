import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  courseDetailOf,
  courseOf,
  courseUrl,
  enrollmentsUrl,
  enrollmentUrl,
} from '../../src/d2l/courses.js';
import {
  announcementsUrl,
  assignmentUrl,
  courseHomeUrl,
  gradebookUrl,
  quizUrl,
} from '../../src/d2l/links.js';
import { userOf, whoamiUrl } from '../../src/d2l/users.js';

const BASE = 'https://purdue.brightspace.com';
const CFG = { baseUrl: BASE, lpVersion: '1.62', courseTypeId: 3 };
const NOW = new Date('2026-09-02T12:00:00.000Z');

const FIXTURES = new URL('../fixtures/', import.meta.url);
const enrollments = JSON.parse(readFileSync(new URL('myenrollments-200.json', FIXTURES), 'utf8'));
const offering = JSON.parse(
  readFileSync(new URL('course-offering-1498777.json', FIXTURES), 'utf8'),
);

function query(url: string): URLSearchParams {
  return new URL(url).searchParams;
}

test('enrollmentsUrl: default filters to course offerings, active, not ended; no sortBy', () => {
  const url = enrollmentsUrl(CFG, { now: NOW });
  assert.ok(url.startsWith(`${BASE}/d2l/api/lp/1.62/enrollments/myenrollments/?`), url);
  const q = query(url);
  assert.equal(q.get('orgUnitTypeId'), '3');
  assert.equal(q.get('isActive'), 'true');
  assert.equal(q.get('startDateTime'), '2026-09-02T12:00:00.000Z');
  assert.equal(q.has('sortBy'), false);
  assert.equal(q.has('bookmark'), false);
});

test('enrollmentsUrl: --all drops the type filter, --inactive drops isActive, --ended drops the window', () => {
  const q = query(enrollmentsUrl(CFG, { all: true, inactive: true, ended: true, now: NOW }));
  assert.equal(q.has('orgUnitTypeId'), false);
  assert.equal(q.has('isActive'), false);
  assert.equal(q.has('startDateTime'), false);
  assert.equal([...q.keys()].length, 0);
});

test('enrollmentsUrl: sort keys map to the documented sortBy values; type id comes from config', () => {
  assert.equal(query(enrollmentsUrl(CFG, { sort: 'name', now: NOW })).get('sortBy'), 'OrgUnitName');
  assert.equal(query(enrollmentsUrl(CFG, { sort: 'start', now: NOW })).get('sortBy'), 'StartDate');
  assert.equal(query(enrollmentsUrl(CFG, { sort: 'end', now: NOW })).get('sortBy'), 'EndDate');
  assert.equal(
    query(enrollmentsUrl({ ...CFG, courseTypeId: 7 }, { now: NOW })).get('orgUnitTypeId'),
    '7',
  );
});

test('single-item routes have no trailing slash and honour the LP version', () => {
  assert.equal(
    enrollmentUrl({ ...CFG, lpVersion: '1.70' }, 1498777),
    `${BASE}/d2l/api/lp/1.70/enrollments/myenrollments/1498777`,
  );
  assert.equal(courseUrl(CFG, 1498777), `${BASE}/d2l/api/lp/1.62/courses/1498777`);
  assert.equal(whoamiUrl(CFG), `${BASE}/d2l/api/lp/1.62/users/whoami`);
});

test('courseOf: reads every value, computes only url, normalises dates to whole seconds', () => {
  const [civics, cgt] = enrollments.Items;
  assert.deepEqual(courseOf(civics, BASE), {
    id: 412690,
    name: 'Purdue Civics Knowledge Test',
    code: 'wl.nc.civics.test',
    role: 'Learner',
    isActive: true,
    canAccess: true,
    startDate: null,
    endDate: null,
    homeUrl: 'https://purdue.brightspace.com/d2l/home/412690',
    url: 'https://purdue.brightspace.com/d2l/home/412690',
  });
  const third = courseOf(enrollments.Items[2], BASE);
  assert.equal(third?.id, 1092755);
  assert.equal(third?.homeUrl, null, 'HomeUrl null passes through (25/27 in the capture)');
  assert.equal(third?.url, `${BASE}/d2l/home/1092755`);
  assert.equal(third?.startDate, '2024-08-14T04:00:00Z');
  assert.equal(third?.endDate, '2024-12-29T04:59:00Z');
  assert.equal(third?.canAccess, false);
  assert.ok(cgt);
});

test('courseOf: an item without a numeric OrgUnit.Id is undecodable; nullable fields survive', () => {
  assert.equal(courseOf({ OrgUnit: { Name: 'x' }, Access: {} }, BASE), null);
  assert.equal(courseOf(null, BASE), null);
  assert.equal(courseOf('nope', BASE), null);
  const sparse = courseOf(
    {
      OrgUnit: { Id: 5, Name: 'Sparse', Code: null, HomeUrl: null },
      Access: { IsActive: false, CanAccess: true, StartDate: 'garbage', EndDate: null },
    },
    BASE,
  );
  assert.deepEqual(sparse, {
    id: 5,
    name: 'Sparse',
    code: null,
    role: null,
    isActive: false,
    canAccess: true,
    startDate: null,
    endDate: null,
    homeUrl: null,
    url: `${BASE}/d2l/home/5`,
  });
});

test('courseDetailOf: merges the enrollment with the offering; missing offering costs only its fields', () => {
  const item = enrollments.Items.find((i: { OrgUnit: { Id: number } }) => i.OrgUnit.Id === 1498777);
  const full = courseDetailOf(item, offering, BASE);
  assert.ok(full);
  assert.equal(full.id, 1498777);
  assert.equal(full.role, 'Learner');
  assert.equal(full.startDate, '2026-01-07T05:00:00Z');
  assert.equal(full.endDate, '2026-05-24T03:59:00Z');
  assert.equal(full.path, '/content/enforced/1498777-wl.202620.PHIL.49000.003/');
  assert.equal(full.description, offering.Description.Text);
  assert.equal(full.descriptionHtml, offering.Description.Html);
  assert.deepEqual(full.semester, { id: 1480001, name: 'Spring 2026', code: '202620' });
  assert.deepEqual(full.department, { id: 6813, name: 'Philosophy', code: 'PHIL' });

  const partial = courseDetailOf(item, null, BASE);
  assert.ok(partial);
  assert.equal(partial.id, 1498777);
  assert.equal(partial.path, null);
  assert.equal(partial.description, null);
  assert.equal(partial.descriptionHtml, null);
  assert.equal(partial.semester, null);
  assert.equal(partial.department, null);

  assert.equal(courseDetailOf({ OrgUnit: {} }, offering, BASE), null);
});

test('userOf: numeric Identifier becomes a number; other strings pass through; missing is null', () => {
  assert.deepEqual(
    userOf({
      Identifier: '123456',
      FirstName: 'Ada',
      LastName: 'Lovelace',
      UniqueName: 'alovelace',
      ProfileIdentifier: 'p1',
      Pronouns: 'she/her',
    }),
    {
      id: 123456,
      firstName: 'Ada',
      lastName: 'Lovelace',
      uniqueName: 'alovelace',
      pronouns: 'she/her',
    },
  );
  assert.equal(userOf({ Identifier: 'guid-like' }).id, 'guid-like');
  assert.deepEqual(userOf({}), {
    id: null,
    firstName: null,
    lastName: null,
    uniqueName: null,
    pronouns: null,
  });
});

test('deep-link templates follow PRD 6.3 exactly', () => {
  assert.equal(courseHomeUrl(BASE, 7), `${BASE}/d2l/home/7`);
  assert.equal(
    assignmentUrl(BASE, 7, 99),
    `${BASE}/d2l/lms/dropbox/user/folder_submit_files.d2l?db=99&grpid=0&ou=7`,
  );
  assert.equal(quizUrl(BASE, 7, 42), `${BASE}/d2l/lms/quizzing/user/quiz_summary.d2l?qi=42&ou=7`);
  assert.equal(gradebookUrl(BASE, 7), `${BASE}/d2l/lms/grades/my_grades/main.d2l?ou=7`);
  assert.equal(announcementsUrl(BASE, 7), `${BASE}/d2l/lms/news/main.d2l?ou=7`);
});
