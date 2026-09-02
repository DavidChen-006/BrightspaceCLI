import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  EVENT_TYPE_NAMES,
  EVENT_TYPES,
  eventOf,
  eventTypeName,
  MAX_ORG_UNITS_PER_REQUEST,
  myEventsUrl,
} from '../../src/d2l/calendar.js';

const BASE = 'https://purdue.brightspace.com';
const CFG = { baseUrl: BASE, leVersion: '1.96' };
const FROM = new Date('2026-09-02T12:00:00.000Z');
const TO = new Date('2026-10-02T12:00:00.000Z');

const FIXTURES = new URL('../fixtures/', import.meta.url);
function fixture<T = unknown>(name: string): T {
  return JSON.parse(readFileSync(new URL(name, FIXTURES), 'utf8')) as T;
}
const EVENTS = fixture<{ Objects: Record<string, unknown>[] }>('calendar-events-doc-shaped.json');

function query(url: string): URLSearchParams {
  return new URL(url).searchParams;
}

test('myEventsUrl: orgUnitIdsCSV joined by commas, dates as UTCDateTime with milliseconds, optional eventType', () => {
  const url = myEventsUrl(CFG, { orgUnitIds: [412690, 440703], from: FROM, to: TO });
  assert.ok(url.startsWith(`${BASE}/d2l/api/le/1.96/calendar/events/myEvents/?`), url);
  const q = query(url);
  assert.equal(q.get('orgUnitIdsCSV'), '412690,440703');
  assert.equal(q.get('startDateTime'), '2026-09-02T12:00:00.000Z');
  assert.equal(q.get('endDateTime'), '2026-10-02T12:00:00.000Z');
  assert.equal(q.has('eventType'), false);

  const due = myEventsUrl(CFG, { orgUnitIds: [1], from: FROM, to: TO, eventType: 'due' });
  assert.equal(query(due).get('eventType'), '6');
  assert.equal(query(due).get('orgUnitIdsCSV'), '1');
  assert.ok(
    myEventsUrl({ ...CFG, leVersion: '1.80' }, { orgUnitIds: [1], from: FROM, to: TO }).includes(
      '/d2l/api/le/1.80/calendar/events/myEvents/?',
    ),
  );
  assert.equal(MAX_ORG_UNITS_PER_REQUEST, 100);
});

test('EVENTTYPE_T names map to the documented numbers', () => {
  assert.deepEqual(EVENT_TYPES, {
    reminder: 1,
    'availability-starts': 2,
    'availability-ends': 3,
    'unlock-starts': 4,
    'unlock-ends': 5,
    due: 6,
  });
  assert.deepEqual([...EVENT_TYPE_NAMES], Object.keys(EVENT_TYPES));
  assert.equal(eventTypeName(6), 'due');
  assert.equal(eventTypeName(1), 'reminder');
  assert.equal(eventTypeName(99), null);
  assert.equal(eventTypeName(null), null);
  assert.equal(eventTypeName('6'), null);
});

test('eventOf: PRD 6.3 Event shape; url from CalendarEventViewUrl, else the course calendar link', () => {
  const [due, holiday] = EVENTS.Objects;
  assert.deepEqual(eventOf(due, BASE), {
    id: 91002,
    courseId: 412690,
    courseCode: 'CIVICS-TEST',
    title: 'Problem Set 2 - Due',
    description: 'Submit via the dropbox. Late work loses 10%/day.',
    start: '2026-09-10T03:59:00Z',
    end: '2026-09-10T03:59:00Z',
    allDay: false,
    type: 'due',
    associated: {
      type: 'Dropbox',
      id: 440703,
      link: `${BASE}/d2l/lms/dropbox/user/folder_submit_files.d2l?db=440703&grpid=0&ou=412690`,
    },
    url: `${BASE}/d2l/le/calendar/412690/event/91002/detailsview`,
  });
  assert.deepEqual(eventOf(holiday, BASE), {
    id: 91001,
    courseId: 1498777,
    courseCode: 'SOME-101',
    title: 'Labor Day - no class',
    description: '',
    start: '2026-09-07T04:00:00Z',
    end: '2026-09-08T03:59:59Z',
    allDay: true,
    type: 'reminder',
    associated: null,
    url: `${BASE}/d2l/le/calendar/1498777`,
  });
});

test('eventOf: no numeric CalendarEventId → null; OrgUnitId strings become numbers; sparse defaults', () => {
  assert.equal(eventOf({ Title: 'no id' }, BASE), null);
  assert.equal(eventOf({ CalendarEventId: '91001' }, BASE), null);
  assert.equal(eventOf(null, BASE), null);
  assert.equal(eventOf(EVENTS, BASE), null, 'the page envelope is not an event');
  assert.deepEqual(eventOf({ CalendarEventId: 5, OrgUnitId: '77', EventType: 42 }, BASE), {
    id: 5,
    courseId: 77,
    courseCode: null,
    title: '',
    description: null,
    start: null,
    end: null,
    allDay: false,
    type: null,
    associated: null,
    url: `${BASE}/d2l/le/calendar/77`,
  });
  const noOu = eventOf({ CalendarEventId: 6 }, BASE);
  assert.equal(noOu?.courseId, null);
  assert.equal(noOu?.url, null, 'no deep link without an org unit');
});
