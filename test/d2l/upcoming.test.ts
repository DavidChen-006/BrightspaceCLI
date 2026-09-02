import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { assignmentOf } from '../../src/d2l/assignments.js';
import { topicOf } from '../../src/d2l/discussions.js';
import { quizOf } from '../../src/d2l/quizzes.js';
import {
  chunkOrgUnits,
  DEFAULT_UPCOMING_DAYS,
  MAX_ORG_UNITS_PER_REQUEST,
  mergeUpcoming,
  myItemsDueUrl,
  scheduledItemOf,
  UPCOMING_COLUMNS,
  UPCOMING_KINDS,
  type UpcomingCandidate,
  type UpcomingFailure,
} from '../../src/d2l/upcoming.js';

const FIXTURES = new URL('../fixtures/', import.meta.url);
function fixture<T = unknown>(name: string): T {
  return JSON.parse(readFileSync(new URL(name, FIXTURES), 'utf8')) as T;
}
type Raw = Record<string, unknown>;
const DROPBOX = fixture<Raw[]>('dropbox-folders-with-due-date.json');
const QUIZZES = fixture<{ Objects: Raw[] }>('quizzes-with-due-date.json').Objects;
const TOPICS = fixture<Raw[]>('discussion-topics-12001-doc-shaped.json');
const MY_ITEMS = fixture<{ Objects: Raw[] }>('content-my-items-due-doc-shaped.json').Objects;

const BASE = 'https://purdue.brightspace.com';
const CFG = { baseUrl: BASE, leVersion: '1.96' };
const OU = 412690;

function nonNull<T>(value: T | null): T {
  assert.notEqual(value, null);
  return value as T;
}
const assignments = DROPBOX.map((f) => nonNull(assignmentOf(f, OU, BASE)));
const quizzes = QUIZZES.map((q) => nonNull(quizOf(q, OU, BASE)));
const topics = TOPICS.map((t) => nonNull(topicOf(t, OU, BASE, 12001)));
const content = MY_ITEMS.map((i) => nonNull(scheduledItemOf(i, BASE)));

test('myItemsDueUrl joins the org units into orgUnitIdsCSV and refuses more than 100', () => {
  const url = myItemsDueUrl(CFG, [412690, 440703]);
  const u = new URL(url);
  assert.equal(`${u.origin}${u.pathname}`, `${BASE}/d2l/api/le/1.96/content/myItems/due/`);
  assert.equal(u.searchParams.get('orgUnitIdsCSV'), '412690,440703');
  assert.throws(() => myItemsDueUrl(CFG, []), /at least one/);
  assert.throws(
    () =>
      myItemsDueUrl(
        CFG,
        Array.from({ length: 101 }, (_, i) => i + 1),
      ),
    /at most 100/,
  );
  assert.equal(MAX_ORG_UNITS_PER_REQUEST, 100);
  assert.equal(DEFAULT_UPCOMING_DAYS, 14);
  assert.deepEqual([...UPCOMING_KINDS], ['assignment', 'quiz', 'discussion', 'content']);
  assert.deepEqual(
    [...UPCOMING_COLUMNS],
    ['kind', 'courseId', 'courseName', 'id', 'title', 'dueDate', 'url'],
  );
});

test('chunkOrgUnits splits into chunks of 100 in order', () => {
  const ids = Array.from({ length: 250 }, (_, i) => 1000 + i);
  const chunks = chunkOrgUnits(ids);
  assert.deepEqual(
    chunks.map((c) => c.length),
    [100, 100, 50],
  );
  assert.equal(chunks[0]?.[0], 1000);
  assert.equal(chunks[2]?.[49], 1249);
  assert.deepEqual(chunkOrgUnits([]), []);
});

test('scheduledItemOf maps a ScheduledItem onto the Item shape with kind content', () => {
  assert.deepEqual(content[0], {
    id: 4000001,
    courseId: 412690,
    courseName: null,
    kind: 'content',
    title: 'Week 3 reading: The Federalist Papers',
    dueDate: '2026-09-10T03:59:00Z',
    startDate: '2026-09-01T04:00:00Z',
    endDate: null,
    url: `${BASE}/d2l/le/content/412690/viewContent/4000001/View`,
    gradeItemId: null,
  });
  // A module: whole-second date, no url.
  assert.equal(content[1]?.id, 3000002);
  assert.equal(content[1]?.dueDate, '2026-09-15T23:59:00Z');
  assert.equal(content[1]?.url, null);
  // Absolute ItemUrl kept as is; undated stays undated; unreadable date → null.
  assert.equal(content[2]?.url, `${BASE}/d2l/le/content/440703/viewContent/4000003/View`);
  assert.equal(content[2]?.courseId, 440703);
  assert.equal(content[2]?.dueDate, null);
  assert.equal(content[2]?.endDate, '2026-09-30T03:59:00Z');
  assert.equal(content[3]?.dueDate, null);
  // Undecodable: no ItemId, or a non-numeric OrgUnitId.
  assert.equal(scheduledItemOf({ ItemName: 'x', OrgUnitId: '1' }, BASE), null);
  assert.equal(scheduledItemOf({ ItemId: 1, OrgUnitId: 'abc' }, BASE), null);
  assert.equal(scheduledItemOf(null, BASE), null);
  assert.equal(scheduledItemOf([], BASE), null);
});

test('mergeUpcoming keeps dated items in [now, now + days], sorted by dueDate then title', () => {
  const now = new Date('2026-09-02T00:00:00Z');
  const names = new Map<number, string | null>([[OU, 'Purdue Civics Knowledge Test']]);
  const { items, failures } = mergeUpcoming(
    { assignments, quizzes, topics, content },
    { now, days: 14 },
    names,
  );
  assert.deepEqual(failures, []);
  assert.deepEqual(
    items.map((i) => [i.kind, i.id, i.dueDate]),
    [
      ['discussion', 31002, '2026-09-08T03:59:00Z'],
      ['content', 4000001, '2026-09-10T03:59:00Z'],
      ['quiz', 900102, '2026-09-15T23:59:00Z'],
      ['assignment', 700002, '2026-09-15T23:59:00Z'],
      ['content', 3000002, '2026-09-15T23:59:00Z'],
    ],
    'past (03-01, 09-01), undated and unreadable items are dropped; ties sort by title',
  );
  assert.deepEqual(items[0], {
    id: 31002,
    courseId: OU,
    courseName: 'Purdue Civics Knowledge Test',
    kind: 'discussion',
    title: 'Week 2: Reading response',
    dueDate: '2026-09-08T03:59:00Z',
    startDate: '2026-08-31T04:00:00Z',
    endDate: '2026-09-15T03:59:00Z',
    url: `${BASE}/d2l/le/${OU}/discussions/topics/31002/View`,
    gradeItemId: null,
  });
  assert.equal(items[2]?.title, 'Final Exam');
  assert.equal(items[3]?.title, 'Group Project Milestone');
  assert.equal(items[3]?.gradeItemId, null);
  assert.equal(items[4]?.courseName, 'Purdue Civics Knowledge Test');
  // Content items from a course the map does not know keep the name they came with (null).
  const other = mergeUpcoming({ content }, { now: new Date('2026-09-20T00:00:00Z'), days: 30 });
  assert.deepEqual(other.items, []);

  // The window is inclusive at both ends and starts at `now`, not midnight.
  const edge = mergeUpcoming({ quizzes }, { now: new Date('2026-09-15T23:59:00Z'), days: 0 });
  assert.deepEqual(
    edge.items.map((i) => i.id),
    [900102],
  );
  const justAfter = mergeUpcoming({ quizzes }, { now: new Date('2026-09-15T23:59:01Z'), days: 0 });
  assert.deepEqual(justAfter.items, []);
  const upTo = mergeUpcoming({ quizzes }, { now: new Date('2026-09-01T23:59:00Z'), days: 14 });
  assert.deepEqual(
    upTo.items.map((i) => i.id),
    [900102],
    'now + 14 days lands exactly on the due date',
  );
});

test('mergeUpcoming dedupes by (kind, id), first wins, and passes failures through', () => {
  const now = new Date('2026-09-02T00:00:00Z');
  const twice: UpcomingCandidate[] = [
    { ...(content[0] as UpcomingCandidate), title: 'first' },
    { ...(content[0] as UpcomingCandidate), title: 'second' },
  ];
  const sameIdOtherKind = { ...(quizzes[1] as (typeof quizzes)[number]), id: 4000001 };
  const failures: UpcomingFailure[] = [
    {
      courseId: 1092755,
      courseName: 'Fall 2024 CGT 11800-013 LEC',
      status: 403,
      message: 'GET /d2l/api/le/1.96/1092755/dropbox/folders/: HTTP 403: Not authorized',
    },
  ];
  const r = mergeUpcoming(
    { content: twice, quizzes: [sameIdOtherKind], assignments, failures },
    { now, days: 14 },
  );
  assert.deepEqual(
    r.items.map((i) => [i.kind, i.id, i.title]),
    [
      ['content', 4000001, 'first'],
      ['quiz', 4000001, 'Final Exam'],
      ['assignment', 700002, 'Group Project Milestone'],
    ],
    'the same id under another kind is a different item; equal due dates sort by title',
  );
  assert.deepEqual(r.failures, failures);
  assert.notEqual(r.failures, failures, "a copy, never the caller's array");
});
