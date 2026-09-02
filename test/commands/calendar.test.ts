import assert from 'node:assert/strict';
import { readFileSync, rmSync } from 'node:fs';
import { test } from 'node:test';
import { HINT_LOGIN } from '../../src/auth/ladder.js';
import { writeSession } from '../../src/auth/session.js';
import { EXIT_CODES } from '../../src/core/errors.js';
import type { TransportResponse } from '../../src/core/http/index.js';
import { MARKER_END, MARKER_START } from '../../src/core/output.js';
import { bogusBearerStep, fakeJwt, fakeSession, mintOkStep, tempRoot } from '../helpers/auth.js';
import { parseJson, runCli } from '../helpers/cli.js';
import { fakeTransport, jsonStep, type Step } from '../helpers/http.js';

type Raw = Record<string, unknown>;
interface Page {
  Objects: Raw[];
  Next: string | null;
}
interface Enrollments {
  PagingInfo: { Bookmark: string; HasMoreItems: boolean };
  Items: { OrgUnit: { Id: number } }[];
}
interface Event {
  id: number;
  courseId: number | string | null;
  courseCode: string | null;
  title: string;
  description: string | null;
  start: string | null;
  end: string | null;
  allDay: boolean;
  type: string | null;
  associated: { type: string | null; id: number | string | null; link: string | null } | null;
  url: string | null;
}
interface ListOut<T> {
  items: T[];
  count: number;
  fetchedAt: string;
}

const FIXTURES = new URL('../fixtures/', import.meta.url);
function fixture<T = unknown>(name: string): T {
  return JSON.parse(readFileSync(new URL(name, FIXTURES), 'utf8')) as T;
}
const EVENTS = fixture<Page>('calendar-events-doc-shaped.json');
const EMPTY = fixture<Page>('calendar-events-empty.json');
const ENROLLMENTS = fixture<Enrollments>('myenrollments-200.json');
const ENROLLED_IDS = ENROLLMENTS.Items.map((i) => i.OrgUnit.Id);

const BASE = 'https://purdue.brightspace.com';
const EVENTS_URL = `${BASE}/d2l/api/le/1.96/calendar/events/myEvents/`;
const ENROLLMENTS_URL = `${BASE}/d2l/api/lp/1.62/enrollments/myenrollments/`;
const ISO_MS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const ISO_S = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
const DAY_MS = 86_400_000;

const FAR_FUTURE = '2999-01-01T00:00:00Z';
const FRESH_JWT = fakeJwt({ exp: Date.parse(FAR_FUTURE) / 1000, sub: 'first' });
const NEW_JWT = fakeJwt({ exp: Date.parse(FAR_FUTURE) / 1000, sub: 'second' });

function seeded() {
  const t = tempRoot('bs-calendar-');
  writeSession(t.paths, fakeSession({ jwt: FRESH_JWT, jwtExpiresAt: FAR_FUTURE }));
  return t;
}

async function calendar(root: string, steps: Step[], args: string[], env = {}) {
  const ft = fakeTransport(steps);
  const r = await runCli(['--root', root, 'calendar', ...args], { transport: ft.transport, env });
  return { ...r, calls: ft.calls };
}

function split(url: string): { path: string; query: URLSearchParams } {
  const u = new URL(url);
  return { path: `${u.origin}${u.pathname}`, query: u.searchParams };
}

const DUE: Event = {
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
};

test('calendar events <ou> --json: one myEvents request with orgUnitIdsCSV and a now → +30d window', async () => {
  const { root } = seeded();
  try {
    const before = Date.now();
    const r = await calendar(root, [jsonStep(EVENTS)], ['events', '412690', '--json']);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.calls.length, 1);
    const { path, query } = split(r.calls[0]?.url ?? '');
    assert.equal(path, EVENTS_URL);
    assert.equal(query.get('orgUnitIdsCSV'), '412690');
    const start = query.get('startDateTime') ?? '';
    const end = query.get('endDateTime') ?? '';
    assert.match(start, ISO_MS, 'UTCDateTime with milliseconds');
    assert.match(end, ISO_MS);
    assert.ok(Date.parse(start) >= before - 1000 && Date.parse(start) <= Date.now() + 1000, start);
    assert.equal(Date.parse(end) - Date.parse(start), 30 * DAY_MS);
    assert.equal(query.has('eventType'), false);
    assert.equal(r.calls[0]?.headers.authorization, `Bearer ${FRESH_JWT}`);

    const out = parseJson<ListOut<Event>>(r.stdout);
    assert.equal(out.count, 2);
    assert.match(out.fetchedAt, ISO_S);
    assert.deepEqual(out.items[0], DUE);
    assert.deepEqual(out.items[1], {
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
    assert.equal(r.stderr, '');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('calendar events without an org unit resolves active enrollments first and sends every id', async () => {
  const { root } = seeded();
  try {
    const r = await calendar(root, [jsonStep(ENROLLMENTS), jsonStep(EVENTS)], ['events', '--json']);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.calls.length, 2);
    const first = split(r.calls[0]?.url ?? '');
    assert.equal(first.path, ENROLLMENTS_URL);
    assert.equal(first.query.get('orgUnitTypeId'), '3');
    assert.equal(first.query.get('isActive'), 'true');
    assert.match(first.query.get('startDateTime') ?? '', ISO_MS, 'ended courses hidden');
    const second = split(r.calls[1]?.url ?? '');
    assert.equal(second.path, EVENTS_URL);
    assert.equal(second.query.get('orgUnitIdsCSV'), ENROLLED_IDS.join(','));
    assert.equal(ENROLLED_IDS.length, 27);
    assert.equal(parseJson<ListOut<Event>>(r.stdout).count, 2);
    assert.equal(r.stderr, '');

    const none = await calendar(
      root,
      [jsonStep({ PagingInfo: { Bookmark: '', HasMoreItems: false }, Items: [] })],
      ['events', '--json'],
    );
    assert.equal(none.code, 0, none.stderr);
    assert.equal(none.calls.length, 1, 'no calendar request without org units');
    assert.equal(parseJson<ListOut<Event>>(none.stdout).count, 0);
    assert.match(none.stderr, /warning: .*no active course/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('calendar events --from/--to/--type shape the query; several org units join the CSV', async () => {
  const { root } = seeded();
  try {
    const r = await calendar(
      root,
      [jsonStep(EVENTS)],
      [
        'events',
        '412690',
        '440703',
        '--from',
        '2026-09-01',
        '--to',
        '2026-09-30T23:59:59Z',
        '--type',
        'due',
        '--json',
      ],
    );
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.calls.length, 1);
    const { query } = split(r.calls[0]?.url ?? '');
    assert.equal(query.get('orgUnitIdsCSV'), '412690,440703');
    assert.equal(query.get('startDateTime'), '2026-09-01T00:00:00.000Z');
    assert.equal(query.get('endDateTime'), '2026-09-30T23:59:59.000Z');
    assert.equal(query.get('eventType'), '6');

    // --from alone keeps the 30-day window from that instant; --to alone starts now.
    const from = await calendar(
      root,
      [jsonStep(EVENTS)],
      ['events', '1', '--from', '2026-09-01T00:00:00Z', '--json'],
    );
    const fq = split(from.calls[0]?.url ?? '').query;
    assert.equal(fq.get('startDateTime'), '2026-09-01T00:00:00.000Z');
    assert.equal(fq.get('endDateTime'), '2026-10-01T00:00:00.000Z');
    const to = await calendar(
      root,
      [jsonStep(EVENTS)],
      ['events', '1', '--to', '2999-01-01', '--json'],
    );
    const tq = split(to.calls[0]?.url ?? '').query;
    assert.ok(Math.abs(Date.parse(tq.get('startDateTime') ?? '') - Date.now()) < 60_000);
    assert.equal(tq.get('endDateTime'), '2999-01-01T00:00:00.000Z');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('calendar events follows Next paging and --limit stops before the second page', async () => {
  const { root } = seeded();
  try {
    const next = `${EVENTS_URL}?orgUnitIdsCSV=412690&bookmark=91002`;
    const p1: Page = { Objects: EVENTS.Objects.slice(0, 1), Next: next };
    const p2: Page = { Objects: EVENTS.Objects.slice(1), Next: null };
    const paged = await calendar(
      root,
      [jsonStep(p1), jsonStep(p2)],
      ['events', '412690', '--json'],
    );
    assert.equal(paged.code, 0, paged.stderr);
    assert.equal(paged.calls.length, 2);
    assert.equal(paged.calls[1]?.url, next);
    assert.equal(parseJson<ListOut<Event>>(paged.stdout).count, 2);

    const limited = await calendar(
      root,
      [jsonStep(p1), jsonStep(p2)],
      ['events', '412690', '--json', '--limit', '1'],
    );
    assert.equal(limited.code, 0, limited.stderr);
    assert.equal(limited.calls.length, 1);
    assert.equal(parseJson<ListOut<Event>>(limited.stdout).count, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('calendar events: the tenant answers an empty page → exit 0; --fail-empty → exit 3 after the output', async () => {
  const { root } = seeded();
  try {
    const ok = await calendar(root, [jsonStep(EMPTY)], ['events', '412690', '--json']);
    assert.equal(ok.code, 0, ok.stderr);
    assert.deepEqual(parseJson<ListOut<Event>>(ok.stdout).items, []);
    assert.equal(ok.stderr, '');

    const empty = await calendar(
      root,
      [jsonStep(EMPTY)],
      ['events', '412690', '--json', '--fail-empty'],
    );
    assert.equal(empty.code, EXIT_CODES.empty_results);
    assert.equal(parseJson<ListOut<Event>>(empty.stdout).count, 0, 'output still written');
    assert.equal(empty.stderr, '');

    const plain = await calendar(
      root,
      [jsonStep(EMPTY)],
      ['events', '412690', '--plain', '--fail-empty'],
    );
    assert.equal(plain.code, EXIT_CODES.empty_results);
    assert.equal(plain.stdout.trimEnd().split('\n').length, 1, 'header row only');

    const human = await calendar(root, [jsonStep(EMPTY)], ['events', '412690']);
    assert.equal(human.code, 0, human.stderr);
    assert.match(human.stdout, /No calendar events/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('calendar events: --plain columns, human table, --select, --raw, --wrap-untrusted', async () => {
  const { root } = seeded();
  try {
    const plain = await calendar(root, [jsonStep(EVENTS)], ['events', '412690', '--plain']);
    assert.equal(plain.code, 0, plain.stderr);
    const lines = plain.stdout.trimEnd().split('\n');
    assert.equal(
      lines[0],
      'id\tcourseId\tcourseCode\ttitle\tdescription\tstart\tend\tallDay\ttype\tassociatedType\tassociatedId\tassociatedLink\turl',
    );
    assert.equal(lines.length, 3);
    assert.equal(
      lines[1],
      `91002\t412690\tCIVICS-TEST\tProblem Set 2 - Due\tSubmit via the dropbox. Late work loses 10%/day.\t2026-09-10T03:59:00Z\t2026-09-10T03:59:00Z\tfalse\tdue\tDropbox\t440703\t${DUE.associated?.link}\t${DUE.url}`,
    );
    assert.equal(
      lines[2],
      `91001\t1498777\tSOME-101\tLabor Day - no class\t\t2026-09-07T04:00:00Z\t2026-09-08T03:59:59Z\ttrue\treminder\t\t\t\t${BASE}/d2l/le/calendar/1498777`,
    );

    const human = await calendar(root, [jsonStep(EVENTS)], ['events', '412690']);
    assert.equal(human.code, 0, human.stderr);
    const hl = human.stdout.trimEnd().split('\n');
    assert.equal(hl.length, 3);
    assert.match(hl[0] ?? '', /^ID\s+START\s+/);
    assert.ok(hl[1]?.includes('Problem Set 2 - Due'));

    const sel = await calendar(
      root,
      [jsonStep(EVENTS)],
      ['events', '412690', '--json', '--results-only', '--select', 'id,type,associated.id'],
    );
    assert.deepEqual(parseJson(sel.stdout), [
      { id: 91002, type: 'due', 'associated.id': 440703 },
      { id: 91001, type: 'reminder' },
    ]);

    const raw = await calendar(
      root,
      [jsonStep(EVENTS)],
      ['events', '412690', '--json', '--raw', '--select', 'id'],
    );
    assert.equal(raw.code, 0, raw.stderr);
    assert.deepEqual(parseJson<ListOut<Raw>>(raw.stdout).items, EVENTS.Objects);

    const wrapped = await calendar(
      root,
      [jsonStep(EVENTS)],
      ['events', '412690', '--json', '--wrap-untrusted'],
    );
    assert.equal(wrapped.code, 0, wrapped.stderr);
    const out = parseJson<ListOut<Raw> & { externalContent: unknown }>(wrapped.stdout);
    const marker = new RegExp(
      `^${MARKER_START} id="([0-9a-f]{16})">>>\\nSource: brightspace\\n---\\n[\\s\\S]*\\n${MARKER_END} id="\\1">>>$`,
    );
    assert.match(String(out.items[0]?.title), marker);
    assert.match(String(out.items[0]?.description), marker);
    assert.equal(out.items[0]?.id, 91002);
    assert.equal(out.items[0]?.courseCode, 'CIVICS-TEST');
    assert.equal(out.items[0]?.type, 'due');
    assert.equal(out.items[0]?.start, '2026-09-10T03:59:00Z');
    assert.equal(out.items[0]?.url, DUE.url);
    assert.deepEqual(out.items[0]?.associated, DUE.associated, 'ids and links are never wrapped');
    assert.deepEqual(out.externalContent, {
      untrusted: true,
      source: 'brightspace',
      wrapped: true,
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('calendar events: 403 → exit 6 with the past-term hint; 404 → exit 5; bad shape → error', async () => {
  const { root } = seeded();
  try {
    const denied = await calendar(
      root,
      [{ status: 403, body: 'Not authorized' }],
      ['events', '1092755', '--json'],
    );
    assert.equal(denied.code, EXIT_CODES.permission_denied);
    assert.equal(denied.stdout, '');
    assert.match(denied.stderr, /bs: GET .*myEvents\/.*: HTTP 403/);
    assert.match(denied.stderr, /past-term/);

    const missing = await calendar(
      root,
      [jsonStep({ title: 'Not Found', status: 404 }, 404)],
      ['events', '999', '--json'],
    );
    assert.equal(missing.code, EXIT_CODES.not_found);
    assert.equal(missing.stdout, '');

    const bare = await calendar(root, [jsonStep(EVENTS.Objects)], ['events', '412690', '--json']);
    assert.equal(bare.code, EXIT_CODES.error);
    assert.equal(bare.stdout, '');
    assert.match(bare.stderr, /unexpected response shape, expected ObjectListPage/);

    const enrollmentsDenied = await calendar(
      root,
      [{ status: 403, body: 'Not authorized' }],
      ['events', '--json'],
    );
    assert.equal(enrollmentsDenied.code, EXIT_CODES.permission_denied);
    assert.equal(enrollmentsDenied.calls.length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('calendar events chunks more than 100 org units into several requests under BS_CONCURRENCY', async () => {
  const { root } = seeded();
  try {
    const ids = Array.from({ length: 101 }, (_, i) => String(1000 + i));
    let inFlight = 0;
    let peak = 0;
    const step: Step = async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight -= 1;
      return {
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(EMPTY),
      };
    };
    const r = await calendar(root, [step], ['events', ...ids, '--json'], { BS_CONCURRENCY: '1' });
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.calls.length, 2);
    const csv = r.calls.map((c) => split(c.url).query.get('orgUnitIdsCSV') ?? '');
    assert.equal(csv[0]?.split(',').length, 100);
    assert.equal(csv[1], '1100');
    assert.equal(peak, 1, 'BS_CONCURRENCY=1 serialises the fan-out');
    assert.equal(parseJson<ListOut<Event>>(r.stdout).count, 0);

    // One chunk failing costs only its events, with a warning; every chunk failing is the error.
    let n = 0;
    const flaky: Step = (req): Promise<TransportResponse> => {
      n += 1;
      const first = (split(req.url).query.get('orgUnitIdsCSV') ?? '').startsWith('1000,');
      return Promise.resolve<TransportResponse>(
        first
          ? {
              status: 200,
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify(EVENTS),
            }
          : { status: 403, headers: {}, body: 'Not authorized' },
      );
    };
    const partial = await calendar(root, [flaky], ['events', ...ids, '--json']);
    assert.equal(partial.code, 0, partial.stderr);
    assert.equal(n, 2);
    assert.equal(parseJson<ListOut<Event>>(partial.stdout).count, 2);
    assert.match(partial.stderr, /warning: .*403/);

    const all = await calendar(
      root,
      [{ status: 403, body: 'Not authorized' }],
      ['events', ...ids, '--json'],
    );
    assert.equal(all.code, EXIT_CODES.permission_denied);
    assert.equal(all.stdout, '');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('calendar events with no session: exit 4, no data request; a 401 re-mints once and re-runs', async () => {
  const { root } = tempRoot('bs-calendar-');
  try {
    const r = await calendar(root, [jsonStep(EVENTS)], ['events', '412690', '--json']);
    assert.equal(r.code, EXIT_CODES.auth_required);
    assert.equal(r.stdout, '');
    assert.ok(r.stderr.includes(HINT_LOGIN), r.stderr);
    assert.equal(r.calls.length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }

  const s = seeded();
  try {
    const r = await calendar(
      s.root,
      [bogusBearerStep, mintOkStep(NEW_JWT), jsonStep(ENROLLMENTS), jsonStep(EVENTS)],
      ['events', '--json'],
    );
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(
      r.calls.map((c) => c.method),
      ['GET', 'POST', 'GET', 'GET'],
    );
    assert.equal(split(r.calls[2]?.url ?? '').path, ENROLLMENTS_URL);
    assert.equal(r.calls[2]?.headers.authorization, `Bearer ${NEW_JWT}`);
    assert.equal(r.calls[3]?.headers.authorization, `Bearer ${NEW_JWT}`);
    assert.equal(parseJson<ListOut<Event>>(r.stdout).count, 2);
  } finally {
    rmSync(s.root, { recursive: true, force: true });
  }
});

test('calendar events rejects bad org units, dates, windows, types and limits before any request', async () => {
  const { root } = seeded();
  try {
    const cases: string[][] = [
      ['events', 'abc'],
      ['events', '0'],
      ['events', '412690', '-1'],
      ['events', '412690', '--from', 'yesterday'],
      ['events', '412690', '--from', '2026-13-45'],
      ['events', '412690', '--to', '2026-09-31T00:00:00Z'],
      ['events', '412690', '--from', '2026-09-10', '--to', '2026-09-01'],
      ['events', '412690', '--from', '2026-09-10', '--to', '2026-09-10'],
      ['events', '412690', '--type', 'bogus'],
      ['events', '412690', '--limit', '0'],
      ['events', '412690', '--json', '--plain'],
      ['bogus'],
    ];
    for (const argv of cases) {
      const r = await calendar(root, [jsonStep(EVENTS)], [...argv, '--json']);
      assert.equal(r.code, EXIT_CODES.usage, argv.join(' '));
      assert.equal(r.calls.length, 0, argv.join(' '));
      assert.equal(r.stdout, '', argv.join(' '));
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('calendar --help and schema create no state directory', async () => {
  const { root } = tempRoot('bs-calendar-');
  const state = `${root}/state`;
  try {
    for (const argv of [
      ['calendar', '--help'],
      ['calendar', 'events', '--help'],
      ['schema', 'calendar', 'events'],
    ]) {
      const r = await runCli(['--root', state, ...argv]);
      assert.equal(r.code, 0, argv.join(' '));
      assert.throws(() => readFileSync(state), argv.join(' '));
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
