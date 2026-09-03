import assert from 'node:assert/strict';
import { readFileSync, rmSync } from 'node:fs';
import { test } from 'node:test';
import { HINT_LOGIN } from '../../src/auth/ladder.js';
import { writeSession } from '../../src/auth/session.js';
import { EXIT_CODES } from '../../src/core/errors.js';
import { MARKER_END, MARKER_START } from '../../src/core/output.js';
import { bogusBearerStep, fakeJwt, fakeSession, mintOkStep, tempRoot } from '../helpers/auth.js';
import { parseJson, runCli } from '../helpers/cli.js';
import { fakeTransport, jsonStep, type Step } from '../helpers/http.js';

interface RawItem {
  OrgUnit: { Id: number; Name: string; Code: string | null; HomeUrl: string | null };
  Access: { StartDate: string | null; EndDate: string | null; ClasslistRoleName: string };
}
interface Page {
  PagingInfo: { Bookmark: string; HasMoreItems: boolean };
  Items: RawItem[];
}
interface Course {
  id: number;
  name: string;
  code: string | null;
  role: string | null;
  isActive: boolean;
  canAccess: boolean;
  startDate: string | null;
  endDate: string | null;
  homeUrl: string | null;
  url: string;
}
interface CourseDetail extends Course {
  path: string | null;
  description: string | null;
  descriptionHtml: string | null;
  semester: { id: number; name: string; code: string } | null;
  department: { id: number; name: string; code: string } | null;
}
interface ListOut {
  items: Course[];
  count: number;
  fetchedAt: string;
}

const FIXTURES = new URL('../fixtures/', import.meta.url);
const FULL: Page = JSON.parse(readFileSync(new URL('myenrollments-200.json', FIXTURES), 'utf8'));
const OFFERING = JSON.parse(
  readFileSync(new URL('course-offering-1498777.json', FIXTURES), 'utf8'),
);
const BASE = 'https://purdue.brightspace.com';
const LIST_PATH = '/d2l/api/lp/1.62/enrollments/myenrollments/';
const ISO_MS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const ISO_S = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

/** Splits the real capture into two bookmark segments (synthetic paging over faithful items). */
function twoPages(): [Page, Page] {
  const cut = 13;
  const first = FULL.Items.slice(0, cut);
  const second = FULL.Items.slice(cut);
  const lastOfFirst = first[first.length - 1]?.OrgUnit.Id;
  return [
    { PagingInfo: { Bookmark: String(lastOfFirst), HasMoreItems: true }, Items: first },
    { PagingInfo: { Bookmark: FULL.PagingInfo.Bookmark, HasMoreItems: false }, Items: second },
  ];
}
const EMPTY: Page = { PagingInfo: { Bookmark: '', HasMoreItems: false }, Items: [] };
const ENROLLMENT_1498777 = FULL.Items.find((i) => i.OrgUnit.Id === 1498777) as RawItem;

const FAR_FUTURE = '2999-01-01T00:00:00Z';
const FRESH_JWT = fakeJwt({ exp: Date.parse(FAR_FUTURE) / 1000, sub: 'first' });
const NEW_JWT = fakeJwt({ exp: Date.parse(FAR_FUTURE) / 1000, sub: 'second' });

function seeded() {
  const t = tempRoot('bs-courses-');
  writeSession(t.paths, fakeSession({ jwt: FRESH_JWT, jwtExpiresAt: FAR_FUTURE }));
  return t;
}

async function courses(root: string, steps: Step[], args: string[]) {
  const ft = fakeTransport(steps);
  const r = await runCli(['--root', root, 'courses', ...args], { transport: ft.transport });
  return { ...r, calls: ft.calls };
}

function queryOf(url: string | undefined): URLSearchParams {
  return new URL(url ?? 'http://invalid').searchParams;
}

test('courses list --json walks two bookmark pages and emits the curated Course rows', async () => {
  const { root } = seeded();
  try {
    const [p1, p2] = twoPages();
    const r = await courses(root, [jsonStep(p1), jsonStep(p2)], ['list', '--json']);
    assert.equal(r.code, 0, r.stderr);
    const out = parseJson<ListOut>(r.stdout);
    assert.equal(out.count, 27);
    assert.equal(out.items.length, 27);
    assert.match(out.fetchedAt, ISO_S);
    assert.deepEqual(out.items[0], {
      id: 412690,
      name: 'Purdue Civics Knowledge Test',
      code: 'wl.nc.civics.test',
      role: 'Learner',
      isActive: true,
      canAccess: true,
      startDate: null,
      endDate: null,
      homeUrl: `${BASE}/d2l/home/412690`,
      url: `${BASE}/d2l/home/412690`,
    });
    const phil = out.items.find((c) => c.id === 1498777);
    assert.deepEqual(phil, {
      id: 1498777,
      name: 'Spring 2026 PHIL 49000-003 LEC',
      code: 'wl.202620.PHIL.49000.003',
      role: 'Learner',
      isActive: true,
      canAccess: false,
      startDate: '2026-01-07T05:00:00Z',
      endDate: '2026-05-24T03:59:00Z',
      homeUrl: null,
      url: `${BASE}/d2l/home/1498777`,
    });

    assert.equal(r.calls.length, 2);
    for (const call of r.calls) {
      assert.equal(call.method, 'GET');
      assert.equal(new URL(call.url).pathname, LIST_PATH);
      assert.equal(call.headers.authorization, `Bearer ${FRESH_JWT}`);
    }
    const q1 = queryOf(r.calls[0]?.url);
    assert.equal(q1.get('orgUnitTypeId'), '3');
    assert.equal(q1.get('isActive'), 'true');
    assert.match(q1.get('startDateTime') ?? '', ISO_MS, 'default hides ended courses');
    assert.ok(Math.abs(Date.parse(q1.get('startDateTime') ?? '') - Date.now()) < 60_000);
    assert.equal(q1.has('bookmark'), false);
    const q2 = queryOf(r.calls[1]?.url);
    assert.equal(q2.get('bookmark'), p1.PagingInfo.Bookmark);
    assert.equal(q2.get('orgUnitTypeId'), '3', 'other params repeat on every segment');
    assert.equal(q2.get('isActive'), 'true');
    assert.equal(r.stderr, '');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('courses list flags: --all, --inactive, --ended, --sort shape the query; sortBy repeats', async () => {
  const { root } = seeded();
  try {
    const [p1, p2] = twoPages();
    const r = await courses(
      root,
      [jsonStep(p1), jsonStep(p2)],
      ['list', '--json', '--all', '--inactive', '--ended', '--sort', 'name'],
    );
    assert.equal(r.code, 0, r.stderr);
    for (const call of r.calls) {
      const q = queryOf(call.url);
      assert.equal(q.has('orgUnitTypeId'), false);
      assert.equal(q.has('isActive'), false);
      assert.equal(q.has('startDateTime'), false);
      assert.equal(q.get('sortBy'), 'OrgUnitName');
    }
    assert.equal(queryOf(r.calls[1]?.url).get('bookmark'), p1.PagingInfo.Bookmark);

    const bad = await courses(root, [jsonStep(FULL)], ['list', '--json', '--sort', 'colour']);
    assert.equal(bad.code, EXIT_CODES.usage);
    assert.equal(bad.calls.length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('courses list --limit stops early: no second page is fetched', async () => {
  const { root } = seeded();
  try {
    const [p1, p2] = twoPages();
    const r = await courses(root, [jsonStep(p1), jsonStep(p2)], ['list', '--json', '--limit', '5']);
    assert.equal(r.code, 0, r.stderr);
    const out = parseJson<ListOut>(r.stdout);
    assert.equal(out.count, 5);
    assert.deepEqual(
      out.items.map((c) => c.id),
      p1.Items.slice(0, 5).map((i) => i.OrgUnit.Id),
    );
    assert.equal(r.calls.length, 1);

    for (const bad of ['0', '-1', 'ten']) {
      const b = await courses(root, [jsonStep(FULL)], ['list', '--json', '--limit', bad]);
      assert.equal(b.code, EXIT_CODES.usage, bad);
      assert.equal(b.calls.length, 0);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('courses list with nothing enrolled: exit 0 and an empty envelope; --fail-empty makes it exit 3 silently', async () => {
  const { root } = seeded();
  try {
    const ok = await courses(root, [jsonStep(EMPTY)], ['list', '--json']);
    assert.equal(ok.code, 0, ok.stderr);
    const out = parseJson<ListOut>(ok.stdout);
    assert.deepEqual(out.items, []);
    assert.equal(out.count, 0);

    const empty = await courses(root, [jsonStep(EMPTY)], ['list', '--json', '--fail-empty']);
    assert.equal(empty.code, EXIT_CODES.empty_results);
    assert.equal(parseJson<ListOut>(empty.stdout).count, 0, 'output still written');
    assert.equal(empty.stderr, '');

    const plain = await courses(root, [jsonStep(EMPTY)], ['list', '--plain', '--fail-empty']);
    assert.equal(plain.code, EXIT_CODES.empty_results);
    assert.equal(plain.stdout.trimEnd().split('\n').length, 1, 'header row only');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('courses list --select and --results-only come from the output seam', async () => {
  const { root } = seeded();
  try {
    const r = await courses(
      root,
      [jsonStep(FULL)],
      ['list', '--json', '--results-only', '--select', 'id,code', '--limit', '2'],
    );
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(parseJson(r.stdout), [
      { id: 412690, code: 'wl.nc.civics.test' },
      { id: 440703, code: 'scholarly_project_milestones' },
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('courses list --plain: fixed columns, one line per course, empty cells for null', async () => {
  const { root } = seeded();
  try {
    const r = await courses(root, [jsonStep(FULL)], ['list', '--plain', '--limit', '3']);
    assert.equal(r.code, 0, r.stderr);
    const lines = r.stdout.trimEnd().split('\n');
    assert.equal(
      lines[0],
      'id\tname\tcode\trole\tisActive\tcanAccess\tstartDate\tendDate\thomeUrl\turl',
    );
    assert.equal(lines.length, 4);
    assert.equal(
      lines[3],
      `1092755\tFall 2024 CGT 11800-013 LEC\twl.202510.CGT.11800.013\tLearner\ttrue\tfalse\t2024-08-14T04:00:00Z\t2024-12-29T04:59:00Z\t\t${BASE}/d2l/home/1092755`,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('courses list human mode renders a table with a header', async () => {
  const { root } = seeded();
  try {
    const r = await courses(root, [jsonStep(FULL)], ['list', '--limit', '2']);
    assert.equal(r.code, 0, r.stderr);
    const lines = r.stdout.trimEnd().split('\n');
    assert.equal(lines.length, 3);
    assert.match(lines[0] ?? '', /^ID\s+NAME\s+CODE/);
    assert.ok(lines[1]?.includes('Purdue Civics Knowledge Test'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('courses list --raw emits the MyOrgUnitInfo items across pages, --select ignored', async () => {
  const { root } = seeded();
  try {
    const [p1, p2] = twoPages();
    const r = await courses(
      root,
      [jsonStep(p1), jsonStep(p2)],
      ['list', '--json', '--raw', '--select', 'id'],
    );
    assert.equal(r.code, 0, r.stderr);
    const out = parseJson<{ items: RawItem[]; count: number }>(r.stdout);
    assert.equal(out.count, 27);
    assert.deepEqual(out.items, FULL.Items);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('courses list skips an undecodable item with a warning; nothing decodable is an error', async () => {
  const { root } = seeded();
  try {
    const page: Page = {
      PagingInfo: { Bookmark: '1', HasMoreItems: false },
      Items: [
        FULL.Items[0] as RawItem,
        { OrgUnit: { Name: 'mid-deletion' } } as unknown as RawItem,
      ],
    };
    const r = await courses(root, [jsonStep(page)], ['list', '--json']);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(parseJson<ListOut>(r.stdout).count, 1);
    assert.match(r.stderr, /warning: .*1 .*undecodable/);

    const none: Page = { ...page, Items: [{ OrgUnit: {} } as unknown as RawItem] };
    const bad = await courses(root, [jsonStep(none)], ['list', '--json']);
    assert.equal(bad.code, EXIT_CODES.error);
    assert.equal(bad.stdout, '');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('courses list with no session: exit 4, login hint, no data request', async () => {
  const { root } = tempRoot('bs-courses-');
  try {
    const r = await courses(root, [jsonStep(FULL)], ['list', '--json']);
    assert.equal(r.code, EXIT_CODES.auth_required);
    assert.equal(r.stdout, '');
    assert.ok(r.stderr.includes(HINT_LOGIN), r.stderr);
    assert.equal(r.calls.length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('courses list whose first page answers 401 re-mints once and resumes from page one', async () => {
  const { root } = seeded();
  try {
    const [p1, p2] = twoPages();
    const r = await courses(
      root,
      [bogusBearerStep, mintOkStep(NEW_JWT), jsonStep(p1), jsonStep(p2)],
      ['list', '--json'],
    );
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(
      r.calls.map((c) => c.method),
      ['GET', 'POST', 'GET', 'GET'],
    );
    assert.equal(r.calls[2]?.headers.authorization, `Bearer ${NEW_JWT}`);
    assert.equal(r.calls[3]?.headers.authorization, `Bearer ${NEW_JWT}`);
    assert.equal(parseJson<ListOut>(r.stdout).count, 27);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('courses get merges the enrollment with the course offering', async () => {
  const { root } = seeded();
  try {
    const r = await courses(
      root,
      [jsonStep(ENROLLMENT_1498777), jsonStep(OFFERING)],
      ['get', '1498777', '--json'],
    );
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(
      r.calls.map((c) => c.url),
      [
        `${BASE}/d2l/api/lp/1.62/enrollments/myenrollments/1498777`,
        `${BASE}/d2l/api/lp/1.62/courses/1498777`,
      ],
    );
    const out = parseJson<CourseDetail>(r.stdout);
    assert.deepEqual(out, {
      id: 1498777,
      name: 'Spring 2026 PHIL 49000-003 LEC',
      code: 'wl.202620.PHIL.49000.003',
      role: 'Learner',
      isActive: true,
      canAccess: false,
      startDate: '2026-01-07T05:00:00Z',
      endDate: '2026-05-24T03:59:00Z',
      homeUrl: null,
      url: `${BASE}/d2l/home/1498777`,
      path: '/content/enforced/1498777-wl.202620.PHIL.49000.003/',
      description: OFFERING.Description.Text,
      descriptionHtml: OFFERING.Description.Html,
      semester: { id: 1480001, name: 'Spring 2026', code: '202620' },
      department: { id: 6813, name: 'Philosophy', code: 'PHIL' },
    });
    assert.equal(r.stderr, '');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('courses get: the offering call failing costs only its fields (warning on stderr)', async () => {
  const { root } = seeded();
  try {
    const r = await courses(
      root,
      [jsonStep(ENROLLMENT_1498777), { status: 403, body: 'Not authorized' }],
      ['get', '1498777', '--json'],
    );
    assert.equal(r.code, 0, r.stderr);
    const out = parseJson<CourseDetail>(r.stdout);
    assert.equal(out.id, 1498777);
    assert.equal(out.role, 'Learner');
    assert.equal(out.description, null);
    assert.equal(out.semester, null);
    assert.equal(out.department, null);
    assert.equal(out.path, null);
    assert.match(r.stderr, /warning: .*courses\/1498777.*403/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('courses get 404 → exit 5 with a hint; 403 → exit 6 with the neutral denied hint', async () => {
  const { root } = seeded();
  try {
    const missing = await courses(
      root,
      [jsonStep({ title: 'Not Found', status: 404, detail: 'No enrollment' }, 404)],
      ['get', '999', '--json'],
    );
    assert.equal(missing.code, EXIT_CODES.not_found);
    assert.equal(missing.stdout, '');
    assert.match(missing.stderr, /bs: .*999.*404/);
    assert.match(missing.stderr, /courses list/);
    assert.equal(missing.calls.length, 1, 'no offering call after a missing enrollment');

    const denied = await courses(
      root,
      [{ status: 403, body: 'Not authorized' }],
      ['get', '1092755'],
    );
    assert.equal(denied.code, EXIT_CODES.permission_denied);
    assert.equal(denied.stdout, '');
    assert.match(denied.stderr, /denied this route/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('courses get --wrap-untrusted wraps name and description, never id, code, url or dates', async () => {
  const { root } = seeded();
  try {
    const r = await courses(
      root,
      [jsonStep(ENROLLMENT_1498777), jsonStep(OFFERING)],
      ['get', '1498777', '--json', '--wrap-untrusted'],
    );
    assert.equal(r.code, 0, r.stderr);
    const out = parseJson<Record<string, unknown>>(r.stdout);
    const marker = new RegExp(
      `^${MARKER_START} id="([0-9a-f]{16})">>>\\nSource: brightspace\\n---\\n[\\s\\S]*\\n${MARKER_END} id="\\1">>>$`,
    );
    assert.match(String(out.description), marker);
    assert.match(String(out.descriptionHtml), marker);
    assert.match(String(out.name), marker);
    assert.ok(String(out.description).includes(OFFERING.Description.Text));
    assert.equal(out.id, 1498777);
    assert.equal(out.code, 'wl.202620.PHIL.49000.003');
    assert.equal(out.url, `${BASE}/d2l/home/1498777`);
    assert.equal(out.startDate, '2026-01-07T05:00:00Z');
    assert.equal(out.path, OFFERING.Path);
    assert.deepEqual(out.externalContent, {
      untrusted: true,
      source: 'brightspace',
      wrapped: true,
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('courses get --plain and human modes; --raw returns both payloads', async () => {
  const { root } = seeded();
  try {
    const plain = await courses(
      root,
      [jsonStep(ENROLLMENT_1498777), jsonStep(OFFERING)],
      ['get', '1498777', '--plain'],
    );
    assert.equal(plain.code, 0, plain.stderr);
    const lines = plain.stdout.trimEnd().split('\n');
    assert.equal(lines[0], 'key\tvalue');
    const map = new Map(lines.slice(1).map((l) => l.split('\t') as [string, string]));
    assert.equal(map.get('id'), '1498777');
    assert.equal(map.get('semester'), '{"id":1480001,"name":"Spring 2026","code":"202620"}');

    const human = await courses(
      root,
      [jsonStep(ENROLLMENT_1498777), jsonStep(OFFERING)],
      ['get', '1498777'],
    );
    assert.equal(human.code, 0, human.stderr);
    assert.ok(human.stdout.includes('Spring 2026 PHIL 49000-003 LEC'));

    const raw = await courses(
      root,
      [jsonStep(ENROLLMENT_1498777), jsonStep(OFFERING)],
      ['get', '1498777', '--json', '--raw'],
    );
    assert.equal(raw.code, 0, raw.stderr);
    assert.deepEqual(parseJson(raw.stdout), { enrollment: ENROLLMENT_1498777, offering: OFFERING });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('courses get rejects a non-numeric org unit id before any request', async () => {
  const { root } = seeded();
  try {
    for (const bad of ['abc', '0', '-3', '1.5']) {
      const r = await courses(root, [jsonStep(OFFERING)], ['get', bad, '--json']);
      assert.equal(r.code, EXIT_CODES.usage, bad);
      assert.equal(r.calls.length, 0);
    }
    const none = await courses(root, [jsonStep(OFFERING)], ['get', '--json']);
    assert.equal(none.code, EXIT_CODES.usage);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('courses --help and schema create no state directory', async () => {
  const { root } = tempRoot('bs-courses-');
  const state = `${root}/state`;
  try {
    for (const argv of [
      ['courses', '--help'],
      ['courses', 'list', '--help'],
      ['schema', 'courses', 'get'],
    ]) {
      const r = await runCli(['--root', state, ...argv]);
      assert.equal(r.code, 0, argv.join(' '));
      assert.throws(() => readFileSync(state), argv.join(' '));
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
