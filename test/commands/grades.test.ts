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

interface MyValue {
  displayed: string | null;
  numerator: number | null;
  denominator: number | null;
  weightedNumerator: number | null;
  weightedDenominator: number | null;
  lastModified: string | null;
  released: boolean;
  releasedDate: string | null;
  comments: string | null;
}
interface Grade {
  id: number;
  name: string;
  shortName: string | null;
  type: string | null;
  maxPoints: number | null;
  weight: number | null;
  isBonus: boolean;
  associatedTool: { toolId: number | null; toolItemId: number | null } | null;
  myValue: MyValue | null;
  url: string;
}
interface FinalGrade {
  courseId: number;
  released: boolean;
  id: number | null;
  name: string | null;
  type: string | null;
  displayed: string | null;
  numerator: number | null;
  denominator: number | null;
  weightedNumerator: number | null;
  weightedDenominator: number | null;
  lastModified: string | null;
  releasedDate: string | null;
  comments: string | null;
  url: string;
}
interface ListOut {
  items: Grade[];
  count: number;
  fetchedAt: string;
}

const FIXTURES = new URL('../fixtures/', import.meta.url);
const OBJECTS: Record<string, unknown>[] = JSON.parse(
  readFileSync(new URL('grade-objects-doc-shaped.json', FIXTURES), 'utf8'),
);
const VALUES: Record<string, unknown>[] = JSON.parse(
  readFileSync(new URL('my-grade-values-doc-shaped.json', FIXTURES), 'utf8'),
);
const FINAL: Record<string, unknown> = JSON.parse(
  readFileSync(new URL('final-grade-value-doc-shaped.json', FIXTURES), 'utf8'),
);
const BASE = 'https://purdue.brightspace.com';
const OU = 1498777;
const OBJECTS_PATH = `/d2l/api/le/1.96/${OU}/grades/`;
const VALUES_PATH = `/d2l/api/le/1.96/${OU}/grades/values/myGradeValues/`;
const FINAL_PATH = `/d2l/api/le/1.96/${OU}/grades/final/values/myGradeValue`;
const MINT_PATH = '/d2l/lp/auth/oauth2/token';
const GRADEBOOK = `${BASE}/d2l/lms/grades/my_grades/main.d2l?ou=${OU}`;
const ISO_S = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
const NOT_FOUND = jsonStep({ title: 'Not Found', status: 404, detail: 'Not Found' }, 404);
const FORBIDDEN: Step = { status: 403, body: 'Not authorized' };

const FAR_FUTURE = '2999-01-01T00:00:00Z';
const FRESH_JWT = fakeJwt({ exp: Date.parse(FAR_FUTURE) / 1000, sub: 'first' });
const NEW_JWT = fakeJwt({ exp: Date.parse(FAR_FUTURE) / 1000, sub: 'second' });

function seeded() {
  const t = tempRoot('bs-grades-');
  writeSession(t.paths, fakeSession({ jwt: FRESH_JWT, jwtExpiresAt: FAR_FUTURE }));
  return t;
}

/**
 * The two list routes are fetched concurrently, so the script is keyed by path rather than
 * by order: each path replays its own steps (the last one repeats). Unknown paths answer 404.
 */
function byPath(routes: Record<string, Step[]>): Step {
  const seen = new Map<string, number>();
  return async (req, signal) => {
    const path = new URL(req.url).pathname;
    const steps = routes[path] ?? [NOT_FOUND];
    const i = seen.get(path) ?? 0;
    seen.set(path, i + 1);
    const step = steps[Math.min(i, steps.length - 1)] as Step;
    if (step instanceof Error) throw step;
    if (typeof step === 'function') return step(req, signal);
    return { status: 200, headers: {}, body: '', ...step };
  };
}

async function grades(root: string, routes: Record<string, Step[]>, args: string[]) {
  const ft = fakeTransport([byPath(routes)]);
  const r = await runCli(['--root', root, 'grades', ...args], { transport: ft.transport });
  return { ...r, calls: ft.calls, paths: ft.calls.map((c) => new URL(c.url).pathname) };
}

const BOTH = { [OBJECTS_PATH]: [jsonStep(OBJECTS)], [VALUES_PATH]: [jsonStep(VALUES)] };

test('grades list --json joins the objects with my values on the grade object id', async () => {
  const { root } = seeded();
  try {
    const r = await grades(root, BOTH, ['list', String(OU), '--json']);
    assert.equal(r.code, 0, r.stderr);
    const out = parseJson<ListOut>(r.stdout);
    assert.equal(out.count, 8);
    assert.match(out.fetchedAt, ISO_S);
    assert.deepEqual(out.items[0], {
      id: 1001,
      name: 'Homework 1',
      shortName: 'HW1',
      type: 'numeric',
      maxPoints: 10,
      weight: 5,
      isBonus: false,
      associatedTool: { toolId: 6, toolItemId: 440703 },
      myValue: {
        displayed: '9 / 10',
        numerator: 9,
        denominator: 10,
        weightedNumerator: 4.5,
        weightedDenominator: 5,
        lastModified: '2026-02-10T15:04:05Z',
        released: true,
        releasedDate: '2026-02-11T00:00:00Z',
        comments: 'Nice work; see the rubric for the missing point.',
      },
      url: GRADEBOOK,
    });
    const midterm = out.items.find((g) => g.id === 1002);
    assert.equal(midterm?.myValue, null, 'no value yet for this object');
    assert.equal(out.items.find((g) => g.id === 1003)?.myValue?.released, false);
    assert.equal(out.items.find((g) => g.id === 1010)?.type, 'category');
    assert.equal(out.items[7]?.id, 9999, 'a value without an object still shows');

    assert.equal(r.calls.length, 2);
    assert.deepEqual(new Set(r.paths), new Set([OBJECTS_PATH, VALUES_PATH]));
    for (const call of r.calls) {
      assert.equal(call.method, 'GET');
      assert.equal(call.headers.authorization, `Bearer ${FRESH_JWT}`);
    }
    assert.equal(r.stderr, '');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('grades list: values 404 means "no grades yet": every item has myValue null, exit 0', async () => {
  const { root } = seeded();
  try {
    const r = await grades(
      root,
      { [OBJECTS_PATH]: [jsonStep(OBJECTS)], [VALUES_PATH]: [NOT_FOUND] },
      ['list', String(OU), '--json'],
    );
    assert.equal(r.code, 0, r.stderr);
    const out = parseJson<ListOut>(r.stdout);
    assert.equal(out.count, OBJECTS.length);
    assert.ok(out.items.every((g) => g.myValue === null));
    assert.equal(r.stderr, '');

    const failEmpty = await grades(
      root,
      { [OBJECTS_PATH]: [jsonStep([])], [VALUES_PATH]: [NOT_FOUND] },
      ['list', String(OU), '--json', '--fail-empty'],
    );
    assert.equal(failEmpty.code, EXIT_CODES.empty_results);
    assert.equal(parseJson<ListOut>(failEmpty.stdout).count, 0, 'output still written');
    assert.equal(failEmpty.stderr, '');

    const noFlag = await grades(
      root,
      { [OBJECTS_PATH]: [jsonStep([])], [VALUES_PATH]: [NOT_FOUND] },
      ['list', String(OU), '--json'],
    );
    assert.equal(noFlag.code, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('grades list: objects 403 → exit 6 with the neutral denied hint; objects 404 → exit 5; no stdout', async () => {
  const { root } = seeded();
  try {
    const denied = await grades(root, { [OBJECTS_PATH]: [FORBIDDEN], [VALUES_PATH]: [FORBIDDEN] }, [
      'list',
      String(OU),
      '--json',
    ]);
    assert.equal(denied.code, EXIT_CODES.permission_denied);
    assert.equal(denied.stdout, '');
    assert.match(denied.stderr, /bs: GET .*grades\/: HTTP 403/);
    assert.match(denied.stderr, /denied this route/);

    const missing = await grades(
      root,
      { [OBJECTS_PATH]: [NOT_FOUND], [VALUES_PATH]: [NOT_FOUND] },
      ['list', String(OU), '--json'],
    );
    assert.equal(missing.code, EXIT_CODES.not_found);
    assert.equal(missing.stdout, '');
    assert.match(missing.stderr, /bs: GET .*grades\/: HTTP 404/);

    const valuesDenied = await grades(
      root,
      { [OBJECTS_PATH]: [jsonStep(OBJECTS)], [VALUES_PATH]: [FORBIDDEN] },
      ['list', String(OU), '--json'],
    );
    assert.equal(valuesDenied.code, EXIT_CODES.permission_denied, 'a 403 on values is real');
    assert.equal(valuesDenied.stdout, '');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('grades list: objects failing while values answer costs only the object fields (warning)', async () => {
  const { root } = seeded();
  try {
    const r = await grades(
      root,
      { [OBJECTS_PATH]: [FORBIDDEN], [VALUES_PATH]: [jsonStep(VALUES)] },
      ['list', String(OU), '--json'],
    );
    assert.equal(r.code, 0, r.stderr);
    const out = parseJson<ListOut>(r.stdout);
    assert.deepEqual(
      out.items.map((g) => g.id),
      [1001, 1003, 1006, 9999],
    );
    assert.equal(out.items[0]?.name, 'Homework 1');
    assert.equal(out.items[0]?.maxPoints, null);
    assert.equal(out.items[0]?.myValue?.displayed, '9 / 10');
    assert.match(r.stderr, /warning: .*grades\/.*403.*maxPoints/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('grades list --plain: flat columns, one line per grade item, empty cells for null', async () => {
  const { root } = seeded();
  try {
    const r = await grades(root, BOTH, ['list', String(OU), '--plain']);
    assert.equal(r.code, 0, r.stderr);
    const lines = r.stdout.trimEnd().split('\n');
    assert.equal(
      lines[0],
      'id\tname\tshortName\ttype\tmaxPoints\tweight\tisBonus\ttoolId\ttoolItemId\tdisplayed\tnumerator\tdenominator\tweightedNumerator\tweightedDenominator\tlastModified\treleased\treleasedDate\tcomments\turl',
    );
    assert.equal(lines.length, 9);
    assert.equal(
      lines[1],
      `1001\tHomework 1\tHW1\tnumeric\t10\t5\tfalse\t6\t440703\t9 / 10\t9\t10\t4.5\t5\t2026-02-10T15:04:05Z\ttrue\t2026-02-11T00:00:00Z\tNice work; see the rubric for the missing point.\t${GRADEBOOK}`,
    );
    assert.equal(
      lines[2],
      `1002\tMidterm Exam\tMT\tnumeric\t100\t30\tfalse\t19\t55501\t\t\t\t\t\t\t\t\t\t${GRADEBOOK}`,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('grades list --select and --results-only project per item; human mode renders a table', async () => {
  const { root } = seeded();
  try {
    const r = await grades(root, BOTH, [
      'list',
      String(OU),
      '--json',
      '--results-only',
      '--select',
      'id,myValue.displayed',
    ]);
    assert.equal(r.code, 0, r.stderr);
    const rows = parseJson<Record<string, unknown>[]>(r.stdout);
    assert.deepEqual(rows[0], { id: 1001, 'myValue.displayed': '9 / 10' });
    assert.deepEqual(rows[1], { id: 1002 }, 'null value: nested path omitted');

    const human = await grades(root, BOTH, ['list', String(OU)]);
    assert.equal(human.code, 0, human.stderr);
    const lines = human.stdout.trimEnd().split('\n');
    assert.match(lines[0] ?? '', /^ID\s+NAME\s+TYPE\s+GRADE/);
    assert.equal(lines.length, 9);
    assert.ok(lines[1]?.includes('Homework 1'));
    assert.ok(lines[1]?.includes('9 / 10'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('grades list --wrap-untrusted wraps names and comments (sanitized), never ids, numbers, dates or url', async () => {
  const { root } = seeded();
  try {
    const r = await grades(root, BOTH, ['list', String(OU), '--json', '--wrap-untrusted']);
    assert.equal(r.code, 0, r.stderr);
    const out = parseJson<{ items: Record<string, unknown>[]; externalContent: unknown }>(r.stdout);
    const marker = new RegExp(
      `^${MARKER_START} id="([0-9a-f]{16})">>>\\nSource: brightspace\\n---\\n[\\s\\S]*\\n${MARKER_END} id="\\1">>>$`,
    );
    const first = out.items[0] as Record<string, unknown>;
    const firstValue = first.myValue as Record<string, unknown>;
    assert.match(String(first.name), marker);
    assert.match(String(first.shortName), marker);
    assert.match(String(firstValue.comments), marker);
    assert.equal(first.id, 1001);
    assert.equal(first.type, 'numeric');
    assert.equal(first.maxPoints, 10);
    assert.equal(first.url, GRADEBOOK);
    assert.equal(firstValue.numerator, 9);
    assert.equal(firstValue.lastModified, '2026-02-10T15:04:05Z');
    assert.equal(firstValue.releasedDate, '2026-02-11T00:00:00Z');
    assert.equal(firstValue.released, true);

    const text = out.items.find((g) => g.id === 1006) as Record<string, unknown>;
    const feedback = String((text.myValue as Record<string, unknown>).comments);
    assert.match(feedback, marker);
    assert.ok(feedback.includes('[[END_MARKER_SANITIZED]]'), 'look-alike marker rewritten');
    assert.equal(feedback.split(MARKER_END).length, 2, 'exactly one closing marker');
    assert.deepEqual(out.externalContent, {
      untrusted: true,
      source: 'brightspace',
      wrapped: true,
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('grades list --raw returns both payloads as sent; --select ignored; --wrap-untrusted applied', async () => {
  const { root } = seeded();
  try {
    const r = await grades(root, BOTH, ['list', String(OU), '--json', '--raw', '--select', 'id']);
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(parseJson(r.stdout), { objects: OBJECTS, values: VALUES });

    const wrapped = await grades(root, BOTH, [
      'list',
      String(OU),
      '--json',
      '--raw',
      '--wrap-untrusted',
    ]);
    assert.equal(wrapped.code, 0, wrapped.stderr);
    const out = parseJson<{ objects: Record<string, unknown>[] }>(wrapped.stdout);
    assert.ok(String(out.objects[0]?.Name).startsWith(MARKER_START));

    const empty = await grades(
      root,
      { [OBJECTS_PATH]: [jsonStep([])], [VALUES_PATH]: [NOT_FOUND] },
      ['list', String(OU), '--json', '--raw', '--fail-empty'],
    );
    assert.equal(empty.code, EXIT_CODES.empty_results);
    assert.deepEqual(parseJson(empty.stdout), { objects: [], values: [] });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('grades list: an undecodable grade object is skipped with a warning; a non-array body is an error', async () => {
  const { root } = seeded();
  try {
    const r = await grades(
      root,
      {
        [OBJECTS_PATH]: [jsonStep([OBJECTS[0], { Name: 'mid-deletion' }])],
        [VALUES_PATH]: [NOT_FOUND],
      },
      ['list', String(OU), '--json'],
    );
    assert.equal(r.code, 0, r.stderr);
    assert.equal(parseJson<ListOut>(r.stdout).count, 1);
    assert.match(r.stderr, /warning: .*1 .*undecodable/);

    const bad = await grades(
      root,
      { [OBJECTS_PATH]: [jsonStep({ Objects: [] })], [VALUES_PATH]: [NOT_FOUND] },
      ['list', String(OU), '--json'],
    );
    assert.equal(bad.code, EXIT_CODES.error);
    assert.equal(bad.stdout, '');
    assert.match(bad.stderr, /grades\/.*array/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('grades list rejects a bad org unit id before any request; no session → exit 4, no request', async () => {
  const { root } = seeded();
  try {
    for (const bad of ['abc', '0', '-3', '1.5']) {
      const r = await grades(root, BOTH, ['list', bad, '--json']);
      assert.equal(r.code, EXIT_CODES.usage, bad);
      assert.equal(r.calls.length, 0);
    }
    const none = await grades(root, BOTH, ['list', '--json']);
    assert.equal(none.code, EXIT_CODES.usage);
    assert.equal(none.calls.length, 0);
    const finalBad = await grades(root, BOTH, ['final', 'x', '--json']);
    assert.equal(finalBad.code, EXIT_CODES.usage);
    assert.equal(finalBad.calls.length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
  const { root: empty } = tempRoot('bs-grades-');
  try {
    const r = await grades(empty, BOTH, ['list', String(OU), '--json']);
    assert.equal(r.code, EXIT_CODES.auth_required);
    assert.equal(r.stdout, '');
    assert.ok(r.stderr.includes(HINT_LOGIN), r.stderr);
    assert.equal(r.calls.length, 0);
  } finally {
    rmSync(empty, { recursive: true, force: true });
  }
});

test('grades list whose first answer is 401 re-mints once and re-fetches both routes', async () => {
  const { root } = seeded();
  try {
    const r = await grades(
      root,
      {
        [OBJECTS_PATH]: [bogusBearerStep, jsonStep(OBJECTS)],
        [VALUES_PATH]: [bogusBearerStep, jsonStep(VALUES)],
        [MINT_PATH]: [mintOkStep(NEW_JWT)],
      },
      ['list', String(OU), '--json'],
    );
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.paths.filter((p) => p === MINT_PATH).length, 1, 'exactly one re-mint');
    assert.equal(r.paths.filter((p) => p === OBJECTS_PATH).length, 2);
    assert.equal(r.paths.filter((p) => p === VALUES_PATH).length, 2);
    const after = r.calls.slice(r.paths.indexOf(MINT_PATH) + 1);
    for (const call of after) assert.equal(call.headers.authorization, `Bearer ${NEW_JWT}`);
    assert.equal(parseJson<ListOut>(r.stdout).count, 8);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('grades final --json emits the released final grade; --plain one row; human one line', async () => {
  const { root } = seeded();
  try {
    const r = await grades(root, { [FINAL_PATH]: [jsonStep(FINAL)] }, [
      'final',
      String(OU),
      '--json',
    ]);
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(r.paths, [FINAL_PATH]);
    assert.deepEqual(parseJson<FinalGrade>(r.stdout), {
      courseId: OU,
      released: true,
      id: 1005,
      name: 'Final Calculated Grade',
      type: 'finalCalculated',
      displayed: '87.5 %',
      numerator: 87.5,
      denominator: 100,
      weightedNumerator: 87.5,
      weightedDenominator: 100,
      lastModified: '2026-05-20T18:30:00Z',
      releasedDate: '2026-05-20T18:30:00Z',
      comments: 'Strong finish.',
      url: GRADEBOOK,
    });

    const plain = await grades(root, { [FINAL_PATH]: [jsonStep(FINAL)] }, [
      'final',
      String(OU),
      '--plain',
    ]);
    assert.equal(plain.code, 0, plain.stderr);
    const lines = plain.stdout.trimEnd().split('\n');
    assert.equal(lines.length, 2);
    assert.equal(
      lines[0],
      'courseId\treleased\tid\tname\ttype\tdisplayed\tnumerator\tdenominator\tweightedNumerator\tweightedDenominator\tlastModified\treleasedDate\tcomments\turl',
    );
    assert.equal(
      lines[1],
      `${OU}\ttrue\t1005\tFinal Calculated Grade\tfinalCalculated\t87.5 %\t87.5\t100\t87.5\t100\t2026-05-20T18:30:00Z\t2026-05-20T18:30:00Z\tStrong finish.\t${GRADEBOOK}`,
    );

    const human = await grades(root, { [FINAL_PATH]: [jsonStep(FINAL)] }, ['final', String(OU)]);
    assert.equal(human.code, 0, human.stderr);
    assert.ok(human.stdout.includes('87.5 %'), human.stdout);
    assert.ok(human.stdout.includes(GRADEBOOK));

    const select = await grades(root, { [FINAL_PATH]: [jsonStep(FINAL)] }, [
      'final',
      String(OU),
      '--json',
      '--select',
      'displayed,released',
    ]);
    assert.deepEqual(parseJson(select.stdout), { displayed: '87.5 %', released: true });

    const raw = await grades(root, { [FINAL_PATH]: [jsonStep(FINAL)] }, [
      'final',
      String(OU),
      '--json',
      '--raw',
    ]);
    assert.deepEqual(parseJson(raw.stdout), FINAL);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('grades final 404: released:false shape, exit 0; exit 3 only under --fail-empty (output still written)', async () => {
  const { root } = seeded();
  try {
    const r = await grades(root, { [FINAL_PATH]: [NOT_FOUND] }, ['final', String(OU), '--json']);
    assert.equal(r.code, 0, r.stderr);
    const out = parseJson<FinalGrade>(r.stdout);
    assert.equal(out.released, false);
    assert.equal(out.courseId, OU);
    assert.equal(out.displayed, null);
    assert.equal(out.numerator, null);
    assert.equal(out.url, GRADEBOOK);
    assert.equal(r.stderr, '');

    const failEmpty = await grades(root, { [FINAL_PATH]: [NOT_FOUND] }, [
      'final',
      String(OU),
      '--json',
      '--fail-empty',
    ]);
    assert.equal(failEmpty.code, EXIT_CODES.empty_results);
    assert.equal(parseJson<FinalGrade>(failEmpty.stdout).released, false);
    assert.equal(failEmpty.stderr, '');

    const human = await grades(root, { [FINAL_PATH]: [NOT_FOUND] }, ['final', String(OU)]);
    assert.equal(human.code, 0);
    assert.match(human.stdout, /no final grade/i);

    const raw = await grades(root, { [FINAL_PATH]: [NOT_FOUND] }, [
      'final',
      String(OU),
      '--json',
      '--raw',
    ]);
    assert.equal(raw.code, 0);
    assert.equal(raw.stdout, 'null\n');

    const denied = await grades(root, { [FINAL_PATH]: [FORBIDDEN] }, [
      'final',
      String(OU),
      '--json',
    ]);
    assert.equal(denied.code, EXIT_CODES.permission_denied);
    assert.equal(denied.stdout, '');
    assert.match(denied.stderr, /denied this route/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('grades final --wrap-untrusted wraps name and comments only', async () => {
  const { root } = seeded();
  try {
    const r = await grades(root, { [FINAL_PATH]: [jsonStep(FINAL)] }, [
      'final',
      String(OU),
      '--json',
      '--wrap-untrusted',
    ]);
    assert.equal(r.code, 0, r.stderr);
    const out = parseJson<Record<string, unknown>>(r.stdout);
    assert.ok(String(out.name).startsWith(MARKER_START));
    assert.ok(String(out.comments).startsWith(MARKER_START));
    assert.equal(out.displayed, '87.5 %');
    assert.equal(out.type, 'finalCalculated');
    assert.equal(out.url, GRADEBOOK);
    assert.equal(out.releasedDate, '2026-05-20T18:30:00Z');
    assert.deepEqual(out.externalContent, {
      untrusted: true,
      source: 'brightspace',
      wrapped: true,
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('grades --help and schema create no state directory', async () => {
  const { root } = tempRoot('bs-grades-');
  const state = `${root}/state`;
  try {
    for (const argv of [
      ['grades', '--help'],
      ['grades', 'list', '--help'],
      ['grades', 'final', '--help'],
      ['schema', 'grades', 'list'],
    ]) {
      const r = await runCli(['--root', state, ...argv]);
      assert.equal(r.code, 0, argv.join(' '));
      assert.throws(() => readFileSync(state), argv.join(' '));
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
