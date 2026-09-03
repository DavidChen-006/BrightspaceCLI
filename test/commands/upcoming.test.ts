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

type Raw = Record<string, unknown>;
interface Page {
  Objects: Raw[];
  Next: string | null;
}
interface Enrollments {
  PagingInfo: { Bookmark: string; HasMoreItems: boolean };
  Items: { OrgUnit: { Id: number; Name: string } }[];
}
interface Item {
  id: number;
  courseId: number;
  courseName: string | null;
  kind: string;
  title: string;
  dueDate: string;
  startDate: string | null;
  endDate: string | null;
  url: string | null;
  gradeItemId: number | null;
}
interface Failure {
  courseId: number | null;
  courseName: string | null;
  status: number | null;
  message: string;
}
interface ListOut {
  items: Item[];
  count: number;
  fetchedAt: string;
  failures: Failure[];
}

const FIXTURES = new URL('../fixtures/', import.meta.url);
function fixture<T = unknown>(name: string): T {
  return JSON.parse(readFileSync(new URL(name, FIXTURES), 'utf8')) as T;
}
const ALL_ENROLLMENTS = fixture<Enrollments>('myenrollments-200.json');
/** The first two real enrollments: 412690 "Purdue Civics Knowledge Test", 440703 "Scholarly Project Milestones". */
const ENROLLMENTS: Enrollments = {
  PagingInfo: { Bookmark: '', HasMoreItems: false },
  Items: ALL_ENROLLMENTS.Items.slice(0, 2),
};
/** Five real enrollments, for the "name three and count the rest" summary. */
const FIVE_ENROLLMENTS: Enrollments = {
  PagingInfo: { Bookmark: '', HasMoreItems: false },
  Items: ALL_ENROLLMENTS.Items.slice(0, 5),
};
const NO_ENROLLMENTS: Enrollments = {
  PagingInfo: { Bookmark: '', HasMoreItems: false },
  Items: [],
};

const BASE = 'https://purdue.brightspace.com';
const LE = '/d2l/api/le/1.96';
const ENROLLMENTS_PATH = '/d2l/api/lp/1.62/enrollments/myenrollments/';
const MINT_PATH = '/d2l/lp/auth/oauth2/token';
const MY_ITEMS_PATH = `${LE}/content/myItems/due/`;
const folders = (ou: number) => `${LE}/${ou}/dropbox/folders/`;
const quizzes = (ou: number) => `${LE}/${ou}/quizzes/`;
const forums = (ou: number) => `${LE}/${ou}/discussions/forums/`;
const topics = (ou: number, f: number) => `${LE}/${ou}/discussions/forums/${f}/topics/`;
const ISO_S = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
const DAY_MS = 86_400_000;

const FAR_FUTURE = '2999-01-01T00:00:00Z';
const FRESH_JWT = fakeJwt({ exp: Date.parse(FAR_FUTURE) / 1000, sub: 'first' });
const NEW_JWT = fakeJwt({ exp: Date.parse(FAR_FUTURE) / 1000, sub: 'second' });

/**
 * The window is computed from the wall clock, so the fixtures' due dates are shifted relative
 * to "now" at test time (the recorded values are kept for the pure merger tests in
 * test/d2l/upcoming.test.ts). `at(n)` is whole-second so it round-trips through isoSeconds.
 */
const NOW = Date.now();
const at = (days: number) => `${new Date(NOW + days * DAY_MS).toISOString().slice(0, 19)}Z`;
const atMs = (days: number) => new Date(NOW + days * DAY_MS).toISOString();

function withDue<T extends Raw>(items: T[], dues: (string | null | undefined)[]): T[] {
  return items.map((item, i) => (dues[i] === undefined ? item : { ...item, DueDate: dues[i] }));
}
const DROPBOX = withDue(fixture<Raw[]>('dropbox-folders-with-due-date.json'), [atMs(2), at(20)]);
const QUIZ_PAGE = fixture<Page>('quizzes-with-due-date.json');
const QUIZZES: Page = { Objects: withDue(QUIZ_PAGE.Objects, [at(5), atMs(20)]), Next: null };
const FORUMS = fixture<Raw[]>('discussion-forums-doc-shaped.json');
const TOPICS_1 = withDue(fixture<Raw[]>('discussion-topics-12001-doc-shaped.json'), [
  at(-1),
  atMs(6),
]);
const TOPICS_2 = fixture<Raw[]>('discussion-topics-12002-doc-shaped.json');
const MY_ITEMS_PAGE = fixture<Page>('content-my-items-due-doc-shaped.json');
const MY_ITEMS: Page = { Objects: withDue(MY_ITEMS_PAGE.Objects, [atMs(8), at(20)]), Next: null };
const EMPTY_PAGE: Page = { Objects: [], Next: null };

const NOT_FOUND = jsonStep({ title: 'Not Found', status: 404, detail: 'Not Found' }, 404);
const FORBIDDEN: Step = { status: 403, body: 'Not authorized' };

function seeded() {
  const t = tempRoot('bs-upcoming-');
  writeSession(t.paths, fakeSession({ jwt: FRESH_JWT, jwtExpiresAt: FAR_FUTURE }));
  return t;
}

/** Routes fan out concurrently, so the script is keyed by path; unknown paths answer 404. */
function byPath(routes: Record<string, Step[]>, fallback: Step = NOT_FOUND): Step {
  const seen = new Map<string, number>();
  return async (req, signal) => {
    const path = new URL(req.url).pathname;
    const steps = routes[path] ?? [fallback];
    const i = seen.get(path) ?? 0;
    seen.set(path, i + 1);
    const step = steps[Math.min(i, steps.length - 1)] as Step;
    if (step instanceof Error) throw step;
    if (typeof step === 'function') return step(req, signal);
    return { status: 200, headers: {}, body: '', ...step };
  };
}

/** Every route answering: two courses, one with content, one empty. */
function healthy(): Record<string, Step[]> {
  return {
    [ENROLLMENTS_PATH]: [jsonStep(ENROLLMENTS)],
    [folders(412690)]: [jsonStep(DROPBOX)],
    [quizzes(412690)]: [jsonStep(QUIZZES)],
    [forums(412690)]: [jsonStep(FORUMS)],
    [topics(412690, 12001)]: [jsonStep(TOPICS_1)],
    [topics(412690, 12002)]: [jsonStep(TOPICS_2)],
    [folders(440703)]: [jsonStep([])],
    [quizzes(440703)]: [jsonStep(EMPTY_PAGE)],
    [forums(440703)]: [jsonStep([])],
    [MY_ITEMS_PATH]: [jsonStep(MY_ITEMS)],
  };
}

async function upcoming(
  root: string,
  routes: Record<string, Step[]>,
  args: string[],
  env: Record<string, string> = {},
  fallback?: Step,
) {
  const ft = fakeTransport([byPath(routes, fallback)]);
  const r = await runCli(['--root', root, 'upcoming', ...args], { transport: ft.transport, env });
  return { ...r, calls: ft.calls, paths: ft.calls.map((c) => new URL(c.url).pathname) };
}

const CIVICS = 'Purdue Civics Knowledge Test';
const HOMEWORK: Item = {
  id: 700001,
  courseId: 412690,
  courseName: CIVICS,
  kind: 'assignment',
  title: 'Homework 3',
  dueDate: at(2),
  startDate: null,
  endDate: null,
  url: `${BASE}/d2l/lms/dropbox/user/folder_submit_files.d2l?db=700001&grpid=0&ou=412690`,
  gradeItemId: 8801,
};

test('upcoming --json fans out over the active courses and merges the four sources, sorted by due date', async () => {
  const { root } = seeded();
  try {
    const r = await upcoming(root, healthy(), ['--json']);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.stderr, '');
    assert.deepEqual(
      [...r.paths].sort(),
      [
        ENROLLMENTS_PATH,
        folders(412690),
        quizzes(412690),
        forums(412690),
        topics(412690, 12001),
        topics(412690, 12002),
        folders(440703),
        quizzes(440703),
        forums(440703),
        MY_ITEMS_PATH,
      ].sort(),
    );
    assert.equal(r.paths[0], ENROLLMENTS_PATH, 'enrollments first');
    const myItems = r.calls.find((c) => new URL(c.url).pathname === MY_ITEMS_PATH);
    assert.equal(new URL(myItems?.url ?? '').searchParams.get('orgUnitIdsCSV'), '412690,440703');
    for (const c of r.calls) assert.equal(c.headers.authorization, `Bearer ${FRESH_JWT}`);

    const out = parseJson<ListOut>(r.stdout);
    assert.equal(out.count, 4);
    assert.match(out.fetchedAt, ISO_S);
    assert.deepEqual(out.failures, []);
    assert.deepEqual(
      out.items.map((i) => [i.kind, i.id, i.dueDate]),
      [
        ['assignment', 700001, at(2)],
        ['quiz', 900101, at(5)],
        ['discussion', 31002, at(6)],
        ['content', 4000001, at(8)],
      ],
    );
    assert.deepEqual(out.items[0], HOMEWORK);
    assert.equal(
      out.items[1]?.url,
      `${BASE}/d2l/lms/quizzing/user/quiz_summary.d2l?qi=900101&ou=412690`,
    );
    assert.equal(out.items[2]?.url, `${BASE}/d2l/le/412690/discussions/topics/31002/View`);
    assert.equal(out.items[2]?.title, 'Week 2: Reading response');
    assert.equal(out.items[3]?.url, `${BASE}/d2l/le/content/412690/viewContent/4000001/View`);
    assert.equal(out.items[3]?.courseName, CIVICS);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('upcoming --days widens the window (ties sort by title); --limit caps the sorted list', async () => {
  const { root } = seeded();
  try {
    const r = await upcoming(root, healthy(), ['--json', '--days', '30']);
    assert.equal(r.code, 0, r.stderr);
    const out = parseJson<ListOut>(r.stdout);
    assert.deepEqual(
      out.items.map((i) => [i.kind, i.id, i.title]),
      [
        ['assignment', 700001, 'Homework 3'],
        ['quiz', 900101, 'Midterm Exam'],
        ['discussion', 31002, 'Week 2: Reading response'],
        ['content', 4000001, 'Week 3 reading: The Federalist Papers'],
        ['quiz', 900102, 'Final Exam'],
        ['assignment', 700002, 'Group Project Milestone'],
        ['content', 3000002, 'Module 2: Branches of government'],
      ],
    );
    assert.equal(out.items[6]?.url, null, 'a module has no ItemUrl');

    const limited = await upcoming(root, healthy(), ['--json', '--days', '30', '--limit', '2']);
    assert.equal(limited.code, 0, limited.stderr);
    assert.deepEqual(
      parseJson<ListOut>(limited.stdout).items.map((i) => i.id),
      [700001, 900101],
    );
    assert.equal(limited.paths.length, 10, 'every course is still fetched: the sort needs them');

    const one = await upcoming(root, healthy(), ['--json', '--days', '1']);
    assert.equal(parseJson<ListOut>(one.stdout).count, 0);
    assert.equal(one.code, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('upcoming --kinds requests only the routes of the named kinds', async () => {
  const { root } = seeded();
  try {
    const r = await upcoming(root, healthy(), [
      '--json',
      '--kinds',
      'quiz,content',
      '--days',
      '30',
    ]);
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(
      [...r.paths].sort(),
      [ENROLLMENTS_PATH, quizzes(412690), quizzes(440703), MY_ITEMS_PATH].sort(),
    );
    assert.deepEqual(
      parseJson<ListOut>(r.stdout).items.map((i) => i.kind),
      ['quiz', 'content', 'quiz', 'content'],
    );

    const disc = await upcoming(root, healthy(), ['--json', '--kinds', 'discussion']);
    assert.deepEqual(
      [...disc.paths].sort(),
      [
        ENROLLMENTS_PATH,
        forums(412690),
        topics(412690, 12001),
        topics(412690, 12002),
        forums(440703),
      ].sort(),
    );
    assert.deepEqual(
      parseJson<ListOut>(disc.stdout).items.map((i) => i.id),
      [31002],
    );

    const spaced = await upcoming(root, healthy(), ['--json', '--kinds', ' assignment , quiz ']);
    assert.equal(spaced.code, 0, spaced.stderr);
    assert.equal(parseJson<ListOut>(spaced.stdout).count, 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('upcoming --course skips the enrollment listing, dedupes ids and leaves courseName null', async () => {
  const { root } = seeded();
  try {
    const r = await upcoming(root, healthy(), [
      '--json',
      '--course',
      '412690',
      '--course',
      '412690',
    ]);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.paths.includes(ENROLLMENTS_PATH), false);
    assert.equal(r.paths.filter((p) => p === folders(412690)).length, 1);
    assert.equal(r.paths.length, 6);
    const myItems = r.calls.find((c) => new URL(c.url).pathname === MY_ITEMS_PATH);
    assert.equal(new URL(myItems?.url ?? '').searchParams.get('orgUnitIdsCSV'), '412690');
    const out = parseJson<ListOut>(r.stdout);
    assert.equal(out.count, 4);
    assert.deepEqual(out.items[0], { ...HOMEWORK, courseName: null });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('upcoming: one course answering 403 is summarised in one stderr line; its items are the only loss', async () => {
  const { root } = seeded();
  try {
    const routes = {
      ...healthy(),
      [folders(440703)]: [FORBIDDEN],
      [quizzes(440703)]: [FORBIDDEN],
      [forums(440703)]: [FORBIDDEN],
    };
    const r = await upcoming(root, routes, ['--json']);
    assert.equal(r.code, 0, r.stderr);
    // bs-6j8: the line names the course, and drops the unfounded "past-term" claim.
    assert.equal(
      r.stderr,
      'warning: 1 course returned 403: Scholarly Project Milestones (440703)\n',
    );
    const out = parseJson<ListOut>(r.stdout);
    assert.equal(out.count, 4);
    assert.equal(out.failures.length, 1);
    assert.equal(out.failures[0]?.courseId, 440703);
    assert.equal(out.failures[0]?.courseName, 'Scholarly Project Milestones');
    assert.equal(out.failures[0]?.status, 403);
    assert.match(
      out.failures[0]?.message ?? '',
      /GET \/d2l\/api\/le\/1\.96\/440703\/dropbox\/folders\/: HTTP 403/,
    );

    assert.equal(
      r.paths.filter((p) => p.startsWith(`${LE}/440703/`)).length,
      1,
      'the first 403 ends the course; its remaining routes are skipped',
    );

    const verbose = await upcoming(root, routes, ['--json', '--verbose']);
    assert.equal(verbose.code, 0);
    assert.match(verbose.stderr, /warning: 1 course returned 403: Scholarly Project/);
    assert.match(verbose.stderr, /440703 .*Scholarly Project Milestones.*HTTP 403/);
    // The enrollment says the course is current, so the detail line does not blame the term.
    assert.match(
      verbose.stderr,
      /The course is active; the tool is probably disabled for learners/,
    );
    assert.equal(verbose.stderr.includes(FRESH_JWT), false, 'never the token');

    const both = await upcoming(root, { ...routes, [folders(412690)]: [FORBIDDEN] }, ['--json']);
    assert.equal(both.code, 0, both.stderr);
    assert.equal(
      both.stderr,
      'warning: 2 courses returned 403: Purdue Civics Knowledge Test (412690), Scholarly Project Milestones (440703)\n',
    );
    assert.equal(parseJson<ListOut>(both.stdout).count, 1, 'only the content item is left');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('upcoming: every course 403 → exit 0 with an empty list (3 under --fail-empty)', async () => {
  const { root } = seeded();
  try {
    const routes = {
      [ENROLLMENTS_PATH]: [jsonStep(ENROLLMENTS)],
      [MY_ITEMS_PATH]: [jsonStep(EMPTY_PAGE)],
    };
    const r = await upcoming(root, routes, ['--json'], {}, FORBIDDEN);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(
      r.stderr,
      'warning: 2 courses returned 403: Purdue Civics Knowledge Test (412690), Scholarly Project Milestones (440703)\n',
    );
    const out = parseJson<ListOut>(r.stdout);
    assert.deepEqual(out.items, []);
    assert.equal(out.failures.length, 2);
    assert.equal(r.paths.length, 4, 'enrollments, one route per denied course, the content chunk');

    const empty = await upcoming(root, routes, ['--json', '--fail-empty'], {}, FORBIDDEN);
    assert.equal(empty.code, EXIT_CODES.empty_results);
    assert.equal(parseJson<ListOut>(empty.stdout).count, 0, 'output still written');

    const human = await upcoming(root, healthy(), ['--days', '1']);
    assert.equal(human.code, 0, human.stderr);
    assert.match(human.stdout, /Nothing due in the next 1 day/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('upcoming: more than three denied courses names three and counts the rest (bs-6j8)', async () => {
  const { root } = seeded();
  try {
    const routes = {
      [ENROLLMENTS_PATH]: [jsonStep(FIVE_ENROLLMENTS)],
      [MY_ITEMS_PATH]: [jsonStep(EMPTY_PAGE)],
    };
    const r = await upcoming(root, routes, ['--json'], {}, FORBIDDEN);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(
      r.stderr,
      'warning: 5 courses returned 403: Purdue Civics Knowledge Test (412690), ' +
        'Scholarly Project Milestones (440703), Fall 2024 CGT 11800-013 LEC (1092755) ' +
        'and 2 more; details with --verbose\n',
    );
    const out = parseJson<ListOut>(r.stdout);
    assert.equal(out.failures.length, 5, 'the JSON failures array is unchanged');
    assert.deepEqual(
      out.failures.map((f) => f.courseId),
      [412690, 440703, 1092755, 1095299, 1095315],
    );

    // --select projects the items; failures is envelope metadata and survives.
    const selected = await upcoming(root, routes, ['--json', '--select', 'id'], {}, FORBIDDEN);
    assert.equal(selected.code, 0, selected.stderr);
    const projected = parseJson<ListOut>(selected.stdout);
    assert.equal(projected.failures.length, 5);
    assert.equal(projected.failures[0]?.status, 403);

    // A course whose term is over is named as such under --verbose.
    const verbose = await upcoming(root, routes, ['--json', '--verbose'], {}, FORBIDDEN);
    assert.match(verbose.stderr, /1092755 .*This course ended on 2024-12-29; 403 is normal/);
    assert.match(verbose.stderr, /412690 .*The course is active; the tool is probably disabled/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('upcoming: a non-403 route failure warns and costs only its items; nothing succeeding is the error', async () => {
  const { root } = seeded();
  try {
    const routes = { ...healthy(), [forums(412690)]: [NOT_FOUND] };
    const r = await upcoming(root, routes, ['--json']);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stderr, /^warning: GET .*412690\/discussions\/forums\/: HTTP 404.*omitted\n$/);
    const out = parseJson<ListOut>(r.stdout);
    assert.deepEqual(
      out.items.map((i) => i.kind),
      ['assignment', 'quiz', 'content'],
    );
    assert.equal(out.failures[0]?.status, 404);
    assert.equal(
      r.paths.filter((p) => p.startsWith(`${LE}/412690/`)).length,
      3,
      'a 404 does not skip the other routes',
    );

    const chunk = await upcoming(root, { ...healthy(), [MY_ITEMS_PATH]: [NOT_FOUND] }, ['--json']);
    assert.equal(chunk.code, 0, chunk.stderr);
    assert.match(
      chunk.stderr,
      /^warning: GET .*content\/myItems\/due\/.*HTTP 404.*2 courses.*omitted\n$/,
    );
    const chunkOut = parseJson<ListOut>(chunk.stdout);
    assert.equal(chunkOut.count, 3);
    assert.deepEqual(
      chunkOut.failures.map((f) => [f.courseId, f.status]),
      [[null, 404]],
    );

    const nothing = await upcoming(root, { [ENROLLMENTS_PATH]: [jsonStep(ENROLLMENTS)] }, [
      '--json',
    ]);
    assert.equal(nothing.code, EXIT_CODES.not_found);
    assert.equal(nothing.stdout, '');
    assert.match(nothing.stderr, /HTTP 404/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('upcoming with no active course warns and makes no data request', async () => {
  const { root } = seeded();
  try {
    const r = await upcoming(root, { [ENROLLMENTS_PATH]: [jsonStep(NO_ENROLLMENTS)] }, ['--json']);
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(r.paths, [ENROLLMENTS_PATH]);
    assert.equal(parseJson<ListOut>(r.stdout).count, 0);
    assert.match(r.stderr, /warning: .*no active course/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('upcoming never has more than BS_CONCURRENCY requests in flight', async () => {
  const { root } = seeded();
  try {
    for (const limit of [1, 2]) {
      let inFlight = 0;
      let peak = 0;
      const counting = (step: Step): Step => {
        return async (req, signal) => {
          inFlight += 1;
          peak = Math.max(peak, inFlight);
          await new Promise((resolve) => setTimeout(resolve, 5));
          inFlight -= 1;
          if (typeof step === 'function') return step(req, signal);
          if (step instanceof Error) throw step;
          return { status: 200, headers: {}, body: '', ...step };
        };
      };
      const routes = Object.fromEntries(
        Object.entries(healthy()).map(([path, steps]) => [path, steps.map(counting)]),
      );
      const r = await upcoming(root, routes, ['--json', '--days', '30'], {
        BS_CONCURRENCY: String(limit),
      });
      assert.equal(r.code, 0, r.stderr);
      assert.equal(r.paths.length, 10);
      assert.ok(peak <= limit, `BS_CONCURRENCY=${limit}: peak ${peak}`);
      assert.ok(peak >= 1);
      assert.equal(parseJson<ListOut>(r.stdout).count, 7);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('upcoming: --plain columns, human table, --select, --results-only, --wrap-untrusted', async () => {
  const { root } = seeded();
  try {
    const plain = await upcoming(root, healthy(), ['--plain']);
    assert.equal(plain.code, 0, plain.stderr);
    const lines = plain.stdout.trimEnd().split('\n');
    assert.equal(lines[0], 'kind\tcourseId\tcourseName\tid\ttitle\tdueDate\turl');
    assert.equal(lines.length, 5);
    assert.equal(
      lines[1],
      `assignment\t412690\t${CIVICS}\t700001\tHomework 3\t${at(2)}\t${HOMEWORK.url}`,
    );
    assert.equal(
      lines[4],
      `content\t412690\t${CIVICS}\t4000001\tWeek 3 reading: The Federalist Papers\t${at(8)}\t${BASE}/d2l/le/content/412690/viewContent/4000001/View`,
    );

    const human = await upcoming(root, healthy(), []);
    assert.equal(human.code, 0, human.stderr);
    const hl = human.stdout.trimEnd().split('\n');
    assert.equal(hl.length, 5);
    assert.match(hl[0] ?? '', /^DUE\s+KIND\s+COURSE\s+ID\s+TITLE$/);
    assert.ok(hl[1]?.includes('Homework 3'), hl[1]);
    assert.ok(hl[1]?.includes(CIVICS));

    const sel = await upcoming(root, healthy(), [
      '--json',
      '--results-only',
      '--select',
      'kind,id',
    ]);
    assert.deepEqual(parseJson(sel.stdout), [
      { kind: 'assignment', id: 700001 },
      { kind: 'quiz', id: 900101 },
      { kind: 'discussion', id: 31002 },
      { kind: 'content', id: 4000001 },
    ]);

    const wrapped = await upcoming(root, healthy(), ['--json', '--wrap-untrusted']);
    assert.equal(wrapped.code, 0, wrapped.stderr);
    const out = parseJson<ListOut & { externalContent: unknown }>(wrapped.stdout);
    const marker = new RegExp(
      `^${MARKER_START} id="([0-9a-f]{16})">>>\\nSource: brightspace\\n---\\n[\\s\\S]*\\n${MARKER_END} id="\\1">>>$`,
    );
    for (const item of out.items) {
      assert.match(item.title, marker);
      // courseName is tenant-authored text like Course.name (bs-ec4), so it wraps too.
      assert.match(String(item.courseName), marker);
      assert.ok(String(item.courseName).includes(CIVICS), 'the course name survives inside');
    }
    const first = out.items[0] as Item;
    assert.equal(first.id, 700001);
    assert.equal(first.kind, 'assignment');
    assert.equal(first.courseId, 412690);
    assert.equal(first.dueDate, at(2));
    assert.equal(first.url, HOMEWORK.url);
    assert.equal(first.gradeItemId, 8801);
    assert.deepEqual(out.externalContent, {
      untrusted: true,
      source: 'brightspace',
      wrapped: true,
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('upcoming with no session: exit 4, no request; a 401 re-mints once and re-runs the fan-out', async () => {
  const { root } = tempRoot('bs-upcoming-');
  try {
    const r = await upcoming(root, healthy(), ['--json']);
    assert.equal(r.code, EXIT_CODES.auth_required);
    assert.equal(r.stdout, '');
    assert.ok(r.stderr.includes(HINT_LOGIN), r.stderr);
    assert.equal(r.calls.length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }

  const s = seeded();
  try {
    const routes = {
      ...healthy(),
      [ENROLLMENTS_PATH]: [bogusBearerStep, jsonStep(ENROLLMENTS)],
      [MINT_PATH]: [mintOkStep(NEW_JWT)],
    };
    const r = await upcoming(s.root, routes, ['--json']);
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(r.paths.slice(0, 3), [ENROLLMENTS_PATH, MINT_PATH, ENROLLMENTS_PATH]);
    assert.equal(r.calls[1]?.method, 'POST');
    for (const c of r.calls.slice(2)) assert.equal(c.headers.authorization, `Bearer ${NEW_JWT}`);
    assert.equal(parseJson<ListOut>(r.stdout).count, 4);
  } finally {
    rmSync(s.root, { recursive: true, force: true });
  }
});

test('upcoming rejects bad days, kinds, courses and limits before any request', async () => {
  const { root } = seeded();
  try {
    const cases: string[][] = [
      ['--days', '0'],
      ['--days', 'soon'],
      ['--kinds', 'bogus'],
      ['--kinds', 'quiz,bogus'],
      ['--kinds', ''],
      ['--course', 'abc'],
      ['--course', '0'],
      ['--limit', '0'],
      ['--json', '--plain'],
      ['extra'],
    ];
    for (const argv of cases) {
      const r = await upcoming(root, healthy(), [...argv, '--json']);
      assert.equal(r.code, EXIT_CODES.usage, argv.join(' '));
      assert.equal(r.calls.length, 0, argv.join(' '));
      assert.equal(r.stdout, '', argv.join(' '));
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('upcoming --help and schema create no state directory', async () => {
  const { root } = tempRoot('bs-upcoming-');
  const state = `${root}/state`;
  try {
    for (const argv of [
      ['upcoming', '--help'],
      ['schema', 'upcoming'],
    ]) {
      const r = await runCli(['--root', state, ...argv]);
      assert.equal(r.code, 0, argv.join(' '));
      assert.throws(() => readFileSync(state), argv.join(' '));
    }
    const schema = await runCli(['--root', state, 'schema', 'upcoming', '--json']);
    const node = parseJson<{ command: { flags: { name: string; type: string }[] } }>(schema.stdout);
    const names = node.command.flags.map((f) => f.name);
    for (const flag of ['days', 'kinds', 'course', 'limit']) assert.ok(names.includes(flag), flag);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
