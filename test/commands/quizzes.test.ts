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

interface RawQuiz {
  QuizId: number;
  Name: string;
  [key: string]: unknown;
}
interface Page {
  Objects: RawQuiz[];
  Next: string | null;
}
interface Quiz {
  id: number;
  courseId: number;
  kind: 'quiz';
  title: string;
  dueDate: string | null;
  startDate: string | null;
  endDate: string | null;
  url: string;
  gradeItemId: number | null;
  isActive: boolean;
  attemptsAllowed: number | null;
  unlimitedAttempts: boolean;
  timeLimit: number | null;
  timeLimitEnforced: boolean;
}
interface QuizDetail extends Quiz {
  description: string | null;
  descriptionHtml: string | null;
  instructions: string | null;
  lateSubmissionOption: number | null;
  lateLimitMinutes: number | null;
  activityId: string | null;
}
interface Attempt {
  id: number;
  quizId: number;
  courseId: number;
  userId: number | string | null;
  attemptNumber: number | null;
  score: number | null;
  started: string | null;
  completed: string | null;
  dueDate: string | null;
  isPublished: boolean;
  feedback: string | null;
  url: string;
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
const FULL = fixture<Page>('quizzes-412690.json');
const EMPTY = fixture<Page>('quizzes-empty.json');
const DATED = fixture<Page>('quizzes-with-due-date.json');
const BARE = fixture<RawQuiz[]>('quizzes-bare-array.json');
const NOT_FOUND = fixture<Record<string, unknown>>('quizzes-malformed.json');
const DETAIL = fixture<RawQuiz>('quiz-790340-doc-shaped.json');
const ATTEMPTS = fixture<Page>('quiz-attempts-doc-shaped.json');
const WHOAMI = fixture<Record<string, unknown>>('whoami-doc-shaped.json');

const BASE = 'https://purdue.brightspace.com';
const OU = 412690;
const LIST_URL = `${BASE}/d2l/api/le/1.96/${OU}/quizzes/`;
const NEXT_URL = `${LIST_URL}?bookmark=619244`;
const ISO_S = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
const QUIZ_URL = (id: number) => `${BASE}/d2l/lms/quizzing/user/quiz_summary.d2l?qi=${id}&ou=${OU}`;

/** Splits the real capture into two `Next` pages (synthetic paging over faithful items). */
function twoPages(): [Page, Page] {
  return [
    { Objects: FULL.Objects.slice(0, 2), Next: NEXT_URL },
    { Objects: FULL.Objects.slice(2), Next: null },
  ];
}

const FAR_FUTURE = '2999-01-01T00:00:00Z';
const FRESH_JWT = fakeJwt({ exp: Date.parse(FAR_FUTURE) / 1000, sub: 'first' });
const NEW_JWT = fakeJwt({ exp: Date.parse(FAR_FUTURE) / 1000, sub: 'second' });

function seeded() {
  const t = tempRoot('bs-quizzes-');
  writeSession(t.paths, fakeSession({ jwt: FRESH_JWT, jwtExpiresAt: FAR_FUTURE }));
  return t;
}

async function quizzes(root: string, steps: Step[], args: string[]) {
  const ft = fakeTransport(steps);
  const r = await runCli(['--root', root, 'quizzes', ...args], { transport: ft.transport });
  return { ...r, calls: ft.calls };
}

const PLEDGE: Quiz = {
  id: 619243,
  courseId: OU,
  kind: 'quiz',
  title: 'Honor Pledge',
  dueDate: null,
  startDate: null,
  endDate: null,
  url: QUIZ_URL(619243),
  gradeItemId: null,
  isActive: true,
  attemptsAllowed: 1,
  unlimitedAttempts: false,
  timeLimit: null,
  timeLimitEnforced: false,
};

// ---------------------------------------------------------------------------------------------
// list
// ---------------------------------------------------------------------------------------------

test('quizzes list --json follows Next across two pages and emits curated quiz rows', async () => {
  const { root } = seeded();
  try {
    const [p1, p2] = twoPages();
    const r = await quizzes(root, [jsonStep(p1), jsonStep(p2)], ['list', String(OU), '--json']);
    assert.equal(r.code, 0, r.stderr);
    const out = parseJson<ListOut<Quiz>>(r.stdout);
    assert.equal(out.count, 3);
    assert.match(out.fetchedAt, ISO_S);
    assert.deepEqual(out.items[0], PLEDGE);
    assert.deepEqual(out.items[2], {
      id: 790340,
      courseId: OU,
      kind: 'quiz',
      title: 'Welcome Quiz',
      dueDate: null,
      startDate: null,
      endDate: null,
      url: QUIZ_URL(790340),
      gradeItemId: null,
      isActive: true,
      attemptsAllowed: 3,
      unlimitedAttempts: false,
      timeLimit: 30,
      timeLimitEnforced: true,
    });
    assert.equal(out.items[1]?.unlimitedAttempts, true);
    assert.equal(out.items[1]?.attemptsAllowed, null);

    assert.deepEqual(
      r.calls.map((c) => [c.method, c.url]),
      [
        ['GET', LIST_URL],
        ['GET', NEXT_URL],
      ],
    );
    for (const call of r.calls) assert.equal(call.headers.authorization, `Bearer ${FRESH_JWT}`);
    assert.equal(r.stderr, '');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('quizzes list normalises both D2L date variants and nulls an unreadable one', async () => {
  const { root } = seeded();
  try {
    const r = await quizzes(root, [jsonStep(DATED)], ['list', '1', '--json']);
    assert.equal(r.code, 0, r.stderr);
    const out = parseJson<ListOut<Quiz>>(r.stdout);
    assert.deepEqual(
      out.items.map((q) => q.dueDate),
      ['2026-03-01T04:59:00Z', '2026-09-15T23:59:00Z', null],
    );
    assert.equal(r.stderr, '');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('quizzes list --limit stops early: no second page is fetched', async () => {
  const { root } = seeded();
  try {
    const [p1, p2] = twoPages();
    const r = await quizzes(
      root,
      [jsonStep(p1), jsonStep(p2)],
      ['list', String(OU), '--json', '--limit', '1'],
    );
    assert.equal(r.code, 0, r.stderr);
    const out = parseJson<ListOut<Quiz>>(r.stdout);
    assert.equal(out.count, 1);
    assert.equal(out.items[0]?.id, 619243);
    assert.equal(r.calls.length, 1);

    for (const bad of ['0', '-1', 'ten']) {
      const b = await quizzes(
        root,
        [jsonStep(FULL)],
        ['list', String(OU), '--json', '--limit', bad],
      );
      assert.equal(b.code, EXIT_CODES.usage, bad);
      assert.equal(b.calls.length, 0);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('quizzes list empty: exit 0 and an empty envelope; --fail-empty makes it exit 3 silently', async () => {
  const { root } = seeded();
  try {
    const ok = await quizzes(root, [jsonStep(EMPTY)], ['list', String(OU), '--json']);
    assert.equal(ok.code, 0, ok.stderr);
    assert.deepEqual(parseJson<ListOut<Quiz>>(ok.stdout).items, []);

    const empty = await quizzes(
      root,
      [jsonStep(EMPTY)],
      ['list', String(OU), '--json', '--fail-empty'],
    );
    assert.equal(empty.code, EXIT_CODES.empty_results);
    assert.equal(parseJson<ListOut<Quiz>>(empty.stdout).count, 0, 'output still written');
    assert.equal(empty.stderr, '');

    const plain = await quizzes(
      root,
      [jsonStep(EMPTY)],
      ['list', String(OU), '--plain', '--fail-empty'],
    );
    assert.equal(plain.code, EXIT_CODES.empty_results);
    assert.equal(plain.stdout.trimEnd().split('\n').length, 1, 'header row only');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('quizzes list --select and --results-only come from the output seam', async () => {
  const { root } = seeded();
  try {
    const r = await quizzes(
      root,
      [jsonStep(FULL)],
      ['list', String(OU), '--json', '--results-only', '--select', 'id,title', '--limit', '2'],
    );
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(parseJson(r.stdout), [
      { id: 619243, title: 'Honor Pledge' },
      { id: 619244, title: 'Practice Quiz - Requires Respondus LockDown Browser' },
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('quizzes list --plain: fixed columns, one line per quiz, empty cells for null', async () => {
  const { root } = seeded();
  try {
    const r = await quizzes(root, [jsonStep(FULL)], ['list', String(OU), '--plain']);
    assert.equal(r.code, 0, r.stderr);
    const lines = r.stdout.trimEnd().split('\n');
    assert.equal(
      lines[0],
      'id\tcourseId\tkind\ttitle\tdueDate\tstartDate\tendDate\turl\tgradeItemId\tisActive\tattemptsAllowed\tunlimitedAttempts\ttimeLimit\ttimeLimitEnforced',
    );
    assert.equal(lines.length, 4);
    assert.equal(
      lines[3],
      `790340\t${OU}\tquiz\tWelcome Quiz\t\t\t\t${QUIZ_URL(790340)}\t\ttrue\t3\tfalse\t30\ttrue`,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('quizzes list human mode renders a table with a header', async () => {
  const { root } = seeded();
  try {
    const r = await quizzes(root, [jsonStep(FULL)], ['list', String(OU)]);
    assert.equal(r.code, 0, r.stderr);
    const lines = r.stdout.trimEnd().split('\n');
    assert.equal(lines.length, 4);
    assert.match(lines[0] ?? '', /^ID\s+TITLE\s+DUE/);
    assert.ok(lines[1]?.includes('Honor Pledge'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('quizzes list --raw emits the QuizReadData objects across pages, --select ignored', async () => {
  const { root } = seeded();
  try {
    const [p1, p2] = twoPages();
    const r = await quizzes(
      root,
      [jsonStep(p1), jsonStep(p2)],
      ['list', String(OU), '--json', '--raw', '--select', 'id'],
    );
    assert.equal(r.code, 0, r.stderr);
    const out = parseJson<{ items: RawQuiz[]; count: number }>(r.stdout);
    assert.equal(out.count, 3);
    assert.deepEqual(out.items, FULL.Objects);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('quizzes list --wrap-untrusted wraps title, never id, url, dates or numbers', async () => {
  const { root } = seeded();
  try {
    const r = await quizzes(
      root,
      [jsonStep(DATED)],
      ['list', '1', '--json', '--wrap-untrusted', '--limit', '1'],
    );
    assert.equal(r.code, 0, r.stderr);
    const out = parseJson<ListOut<Record<string, unknown>> & { externalContent: unknown }>(
      r.stdout,
    );
    const marker = new RegExp(
      `^${MARKER_START} id="([0-9a-f]{16})">>>\\nSource: brightspace\\n---\\nMidterm Exam\\n${MARKER_END} id="\\1">>>$`,
    );
    assert.match(String(out.items[0]?.title), marker);
    assert.equal(out.items[0]?.id, 900101);
    assert.equal(out.items[0]?.dueDate, '2026-03-01T04:59:00Z');
    assert.equal(out.items[0]?.timeLimit, 50);
    assert.equal(
      out.items[0]?.url,
      `${BASE}/d2l/lms/quizzing/user/quiz_summary.d2l?qi=900101&ou=1`,
    );
    assert.deepEqual(out.externalContent, {
      untrusted: true,
      source: 'brightspace',
      wrapped: true,
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('quizzes list rejects a bare array (the dropbox shape) as an unexpected response shape', async () => {
  const { root } = seeded();
  try {
    const r = await quizzes(root, [jsonStep(BARE)], ['list', String(OU), '--json']);
    assert.equal(r.code, EXIT_CODES.error);
    assert.equal(r.stdout, '');
    assert.match(
      r.stderr,
      /bs: GET .*quizzes\/: unexpected response shape, expected ObjectListPage/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('quizzes list skips an undecodable object with a warning; nothing decodable is an error', async () => {
  const { root } = seeded();
  try {
    const page: Page = {
      Objects: [FULL.Objects[0] as RawQuiz, { Name: 'mid-deletion' } as unknown as RawQuiz],
      Next: null,
    };
    const r = await quizzes(root, [jsonStep(page)], ['list', String(OU), '--json']);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(parseJson<ListOut<Quiz>>(r.stdout).count, 1);
    assert.match(r.stderr, /warning: .*1 .*undecodable/);

    const none: Page = { Objects: [{ Name: 'x' } as unknown as RawQuiz], Next: null };
    const bad = await quizzes(root, [jsonStep(none)], ['list', String(OU), '--json']);
    assert.equal(bad.code, EXIT_CODES.error);
    assert.equal(bad.stdout, '');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('quizzes list: 404 on an unknown org unit → exit 5; 403 → exit 6 with the neutral denied hint', async () => {
  const { root } = seeded();
  try {
    const missing = await quizzes(root, [jsonStep(NOT_FOUND, 404)], ['list', '999', '--json']);
    assert.equal(missing.code, EXIT_CODES.not_found);
    assert.equal(missing.stdout, '');
    assert.match(
      missing.stderr,
      /bs: GET .*999\/quizzes\/: HTTP 404 Not Found: The requested org unit/,
    );

    const denied = await quizzes(
      root,
      [{ status: 403, body: 'Not authorized' }],
      ['list', '1092755', '--json'],
    );
    assert.equal(denied.code, EXIT_CODES.permission_denied);
    assert.equal(denied.stdout, '');
    assert.match(denied.stderr, /denied this route/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('quizzes list with no session: exit 4, login hint, no data request', async () => {
  const { root } = tempRoot('bs-quizzes-');
  try {
    const r = await quizzes(root, [jsonStep(FULL)], ['list', String(OU), '--json']);
    assert.equal(r.code, EXIT_CODES.auth_required);
    assert.equal(r.stdout, '');
    assert.ok(r.stderr.includes(HINT_LOGIN), r.stderr);
    assert.equal(r.calls.length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('quizzes list whose first page answers 401 re-mints once and resumes from page one', async () => {
  const { root } = seeded();
  try {
    const [p1, p2] = twoPages();
    const r = await quizzes(
      root,
      [bogusBearerStep, mintOkStep(NEW_JWT), jsonStep(p1), jsonStep(p2)],
      ['list', String(OU), '--json'],
    );
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(
      r.calls.map((c) => c.method),
      ['GET', 'POST', 'GET', 'GET'],
    );
    assert.equal(r.calls[2]?.url, LIST_URL);
    assert.equal(r.calls[2]?.headers.authorization, `Bearer ${NEW_JWT}`);
    assert.equal(r.calls[3]?.headers.authorization, `Bearer ${NEW_JWT}`);
    assert.equal(parseJson<ListOut<Quiz>>(r.stdout).count, 3);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------------------------
// get
// ---------------------------------------------------------------------------------------------

test('quizzes get --json emits the QuizDetail from quizzes/{quizId}', async () => {
  const { root } = seeded();
  try {
    const r = await quizzes(root, [jsonStep(DETAIL)], ['get', String(OU), '790340', '--json']);
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(
      r.calls.map((c) => c.url),
      [`${BASE}/d2l/api/le/1.96/${OU}/quizzes/790340`],
    );
    const out = parseJson<QuizDetail>(r.stdout);
    assert.deepEqual(out, {
      id: 790340,
      courseId: OU,
      kind: 'quiz',
      title: 'Welcome Quiz',
      dueDate: '2026-09-15T23:59:00Z',
      startDate: '2026-08-24T04:00:00Z',
      endDate: '2026-12-20T04:59:00Z',
      url: QUIZ_URL(790340),
      gradeItemId: 55123,
      isActive: true,
      attemptsAllowed: 3,
      unlimitedAttempts: false,
      timeLimit: 30,
      timeLimitEnforced: true,
      description: 'A short warm-up.',
      descriptionHtml: '<p>A short warm-up.</p>',
      instructions: 'Answer every question. You have 30 minutes.',
      lateSubmissionOption: 1,
      lateLimitMinutes: 15,
      activityId: DETAIL.ActivityId as string,
    });
    assert.equal(r.stderr, '');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('quizzes get 404 → exit 5 with a list hint; 403 → exit 6 with the neutral denied hint', async () => {
  const { root } = seeded();
  try {
    const missing = await quizzes(
      root,
      [jsonStep({ title: 'Not Found', status: 404, detail: 'No such quiz' }, 404)],
      ['get', String(OU), '999', '--json'],
    );
    assert.equal(missing.code, EXIT_CODES.not_found);
    assert.equal(missing.stdout, '');
    assert.match(missing.stderr, /bs: .*quizzes\/999.*404/);
    assert.match(missing.stderr, new RegExp(`bs quizzes list ${OU}`));

    const denied = await quizzes(
      root,
      [{ status: 403, body: 'Not authorized' }],
      ['get', '1092755', '5'],
    );
    assert.equal(denied.code, EXIT_CODES.permission_denied);
    assert.equal(denied.stdout, '');
    assert.match(denied.stderr, /denied this route/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('quizzes get rejects a bare array on the single-quiz route', async () => {
  const { root } = seeded();
  try {
    const r = await quizzes(root, [jsonStep(BARE)], ['get', String(OU), '619243', '--json']);
    assert.equal(r.code, EXIT_CODES.error);
    assert.equal(r.stdout, '');
    assert.match(r.stderr, /unexpected response shape/);
    assert.match(r.stderr, /--raw/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('quizzes get --wrap-untrusted wraps title, description and instructions; never id, url or dates', async () => {
  const { root } = seeded();
  try {
    const r = await quizzes(
      root,
      [jsonStep(DETAIL)],
      ['get', String(OU), '790340', '--json', '--wrap-untrusted'],
    );
    assert.equal(r.code, 0, r.stderr);
    const out = parseJson<Record<string, unknown>>(r.stdout);
    const marker = new RegExp(
      `^${MARKER_START} id="([0-9a-f]{16})">>>\\nSource: brightspace\\n---\\n[\\s\\S]*\\n${MARKER_END} id="\\1">>>$`,
    );
    for (const key of ['title', 'description', 'descriptionHtml', 'instructions']) {
      assert.match(String(out[key]), marker, key);
    }
    assert.ok(String(out.instructions).includes('Answer every question.'));
    assert.equal(out.id, 790340);
    assert.equal(out.url, QUIZ_URL(790340));
    assert.equal(out.dueDate, '2026-09-15T23:59:00Z');
    assert.equal(out.activityId, DETAIL.ActivityId);
    assert.equal(out.timeLimit, 30);
    assert.deepEqual(out.externalContent, {
      untrusted: true,
      source: 'brightspace',
      wrapped: true,
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('quizzes get --plain, human and --raw modes', async () => {
  const { root } = seeded();
  try {
    const plain = await quizzes(root, [jsonStep(DETAIL)], ['get', String(OU), '790340', '--plain']);
    assert.equal(plain.code, 0, plain.stderr);
    const lines = plain.stdout.trimEnd().split('\n');
    assert.equal(lines[0], 'key\tvalue');
    const map = new Map(lines.slice(1).map((l) => l.split('\t') as [string, string]));
    assert.equal(map.get('id'), '790340');
    assert.equal(map.get('attemptsAllowed'), '3');
    assert.equal(map.get('instructions'), 'Answer every question. You have 30 minutes.');

    const human = await quizzes(root, [jsonStep(DETAIL)], ['get', String(OU), '790340']);
    assert.equal(human.code, 0, human.stderr);
    assert.ok(human.stdout.includes('Welcome Quiz'));
    assert.ok(human.stdout.includes(QUIZ_URL(790340)));

    const raw = await quizzes(
      root,
      [jsonStep(DETAIL)],
      ['get', String(OU), '790340', '--json', '--raw'],
    );
    assert.equal(raw.code, 0, raw.stderr);
    assert.deepEqual(parseJson(raw.stdout), DETAIL);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------------------------
// attempts
// ---------------------------------------------------------------------------------------------

test('quizzes attempts resolves the user via whoami, then lists attempts/?userId=<me>', async () => {
  const { root } = seeded();
  try {
    const r = await quizzes(
      root,
      [jsonStep(WHOAMI), jsonStep(ATTEMPTS)],
      ['attempts', String(OU), '790340', '--json'],
    );
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(
      r.calls.map((c) => [c.method, c.url]),
      [
        ['GET', `${BASE}/d2l/api/lp/1.62/users/whoami`],
        ['GET', `${BASE}/d2l/api/le/1.96/${OU}/quizzes/790340/attempts/?userId=123456`],
      ],
    );
    const out = parseJson<ListOut<Attempt>>(r.stdout);
    assert.equal(out.count, 2);
    assert.deepEqual(out.items[0], {
      id: 3105001,
      quizId: 790340,
      courseId: OU,
      userId: 123456,
      attemptNumber: 1,
      score: 7.5,
      started: '2026-08-25T14:02:11Z',
      completed: '2026-08-25T14:21:40Z',
      dueDate: '2026-09-15T23:59:00Z',
      isPublished: true,
      feedback: 'Nice work.',
      url: QUIZ_URL(790340),
    });
    assert.equal(out.items[1]?.completed, null);
    assert.equal(r.stderr, '');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('quizzes attempts: empty list is exit 0; --fail-empty → exit 3; --plain columns; --raw', async () => {
  const { root } = seeded();
  try {
    const ok = await quizzes(
      root,
      [jsonStep(WHOAMI), jsonStep(EMPTY)],
      ['attempts', String(OU), '790340', '--json'],
    );
    assert.equal(ok.code, 0, ok.stderr);
    assert.deepEqual(parseJson<ListOut<Attempt>>(ok.stdout).items, []);

    const empty = await quizzes(
      root,
      [jsonStep(WHOAMI), jsonStep(EMPTY)],
      ['attempts', String(OU), '790340', '--json', '--fail-empty'],
    );
    assert.equal(empty.code, EXIT_CODES.empty_results);
    assert.equal(parseJson<ListOut<Attempt>>(empty.stdout).count, 0);
    assert.equal(empty.stderr, '');

    const plain = await quizzes(
      root,
      [jsonStep(WHOAMI), jsonStep(ATTEMPTS)],
      ['attempts', String(OU), '790340', '--plain'],
    );
    assert.equal(plain.code, 0, plain.stderr);
    const lines = plain.stdout.trimEnd().split('\n');
    assert.equal(
      lines[0],
      'id\tquizId\tcourseId\tuserId\tattemptNumber\tscore\tstarted\tcompleted\tdueDate\tisPublished\tfeedback\turl',
    );
    assert.equal(lines.length, 3);
    assert.equal(
      lines[2],
      `3105002\t790340\t${OU}\t123456\t2\t\t2026-08-26T09:00:00Z\t\t\tfalse\t\t${QUIZ_URL(790340)}`,
    );

    const human = await quizzes(
      root,
      [jsonStep(WHOAMI), jsonStep(ATTEMPTS)],
      ['attempts', String(OU), '790340'],
    );
    assert.equal(human.code, 0, human.stderr);
    assert.match(human.stdout.split('\n')[0] ?? '', /^ID\s+ATTEMPT\s+SCORE/);

    const raw = await quizzes(
      root,
      [jsonStep(WHOAMI), jsonStep(ATTEMPTS)],
      ['attempts', String(OU), '790340', '--json', '--raw'],
    );
    assert.equal(raw.code, 0, raw.stderr);
    assert.deepEqual(parseJson<{ items: unknown[] }>(raw.stdout).items, ATTEMPTS.Objects);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('quizzes attempts --limit stops paging; --wrap-untrusted wraps feedback only', async () => {
  const { root } = seeded();
  try {
    const p1: Page = {
      Objects: ATTEMPTS.Objects.slice(0, 1),
      Next: `${LIST_URL}790340/attempts/?userId=123456&bookmark=1`,
    };
    const p2: Page = { Objects: ATTEMPTS.Objects.slice(1), Next: null };
    const limited = await quizzes(
      root,
      [jsonStep(WHOAMI), jsonStep(p1), jsonStep(p2)],
      ['attempts', String(OU), '790340', '--json', '--limit', '1'],
    );
    assert.equal(limited.code, 0, limited.stderr);
    assert.equal(parseJson<ListOut<Attempt>>(limited.stdout).count, 1);
    assert.equal(limited.calls.length, 2, 'whoami + page one only');

    const paged = await quizzes(
      root,
      [jsonStep(WHOAMI), jsonStep(p1), jsonStep(p2)],
      ['attempts', String(OU), '790340', '--json', '--wrap-untrusted'],
    );
    assert.equal(paged.code, 0, paged.stderr);
    assert.equal(paged.calls.length, 3);
    assert.equal(paged.calls[2]?.url, p1.Next);
    const out = parseJson<ListOut<Record<string, unknown>>>(paged.stdout);
    assert.equal(out.count, 2);
    assert.ok(String(out.items[0]?.feedback).startsWith(MARKER_START));
    assert.equal(out.items[0]?.score, 7.5);
    assert.equal(out.items[0]?.started, '2026-08-25T14:02:11Z');
    assert.equal(out.items[0]?.userId, 123456);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('quizzes attempts 403 → exit 6 with a clear learner-access message and the quiz url', async () => {
  const { root } = seeded();
  try {
    const r = await quizzes(
      root,
      [jsonStep(WHOAMI), { status: 403, body: 'Not authorized' }],
      ['attempts', String(OU), '790340', '--json'],
    );
    assert.equal(r.code, EXIT_CODES.permission_denied);
    assert.equal(r.stdout, '');
    assert.match(r.stderr, /bs: GET .*attempts\/\?userId=123456: HTTP 403/);
    assert.match(r.stderr, /learner/i);
    assert.ok(r.stderr.includes(QUIZ_URL(790340)), r.stderr);
    assert.equal(r.calls.length, 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('quizzes attempts: whoami without an id is an error before the attempts request; 404 → exit 5', async () => {
  const { root } = seeded();
  try {
    const noId = await quizzes(
      root,
      [jsonStep({ FirstName: 'Ada' }), jsonStep(ATTEMPTS)],
      ['attempts', String(OU), '790340', '--json'],
    );
    assert.equal(noId.code, EXIT_CODES.error);
    assert.equal(noId.stdout, '');
    assert.equal(noId.calls.length, 1);
    assert.match(noId.stderr, /whoami/);

    const missing = await quizzes(
      root,
      [jsonStep(WHOAMI), jsonStep({ title: 'Not Found', status: 404 }, 404)],
      ['attempts', String(OU), '999', '--json'],
    );
    assert.equal(missing.code, EXIT_CODES.not_found);
    assert.equal(missing.stdout, '');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('quizzes attempts whose whoami answers 401 re-mints once and re-runs both calls', async () => {
  const { root } = seeded();
  try {
    const r = await quizzes(
      root,
      [bogusBearerStep, mintOkStep(NEW_JWT), jsonStep(WHOAMI), jsonStep(ATTEMPTS)],
      ['attempts', String(OU), '790340', '--json'],
    );
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(
      r.calls.map((c) => c.method),
      ['GET', 'POST', 'GET', 'GET'],
    );
    assert.equal(r.calls[3]?.headers.authorization, `Bearer ${NEW_JWT}`);
    assert.equal(parseJson<ListOut<Attempt>>(r.stdout).count, 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------------------------
// argument validation, help
// ---------------------------------------------------------------------------------------------

test('quizzes get/attempts/list reject bad ids before any request', async () => {
  const { root } = seeded();
  try {
    for (const bad of ['abc', '0', '-3', '1.5']) {
      const list = await quizzes(root, [jsonStep(FULL)], ['list', bad, '--json']);
      assert.equal(list.code, EXIT_CODES.usage, `list ${bad}`);
      assert.equal(list.calls.length, 0);
      const get = await quizzes(root, [jsonStep(DETAIL)], ['get', String(OU), bad, '--json']);
      assert.equal(get.code, EXIT_CODES.usage, `get ${bad}`);
      assert.equal(get.calls.length, 0);
      const attempts = await quizzes(root, [jsonStep(WHOAMI)], ['attempts', bad, '1', '--json']);
      assert.equal(attempts.code, EXIT_CODES.usage, `attempts ${bad}`);
      assert.equal(attempts.calls.length, 0);
    }
    for (const argv of [['list'], ['get', String(OU)], ['attempts', String(OU)]]) {
      const r = await quizzes(root, [jsonStep(FULL)], [...argv, '--json']);
      assert.equal(r.code, EXIT_CODES.usage, argv.join(' '));
      assert.equal(r.calls.length, 0);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('quizzes --help and schema create no state directory', async () => {
  const { root } = tempRoot('bs-quizzes-');
  const state = `${root}/state`;
  try {
    for (const argv of [
      ['quizzes', '--help'],
      ['quizzes', 'attempts', '--help'],
      ['schema', 'quizzes', 'get'],
    ]) {
      const r = await runCli(['--root', state, ...argv]);
      assert.equal(r.code, 0, argv.join(' '));
      assert.throws(() => readFileSync(state), argv.join(' '));
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
