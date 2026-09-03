import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { HINT_LOGIN } from '../../src/auth/ladder.js';
import { writeSession } from '../../src/auth/session.js';
import { EXIT_CODES } from '../../src/core/errors.js';
import type { TransportRequest } from '../../src/core/http/index.js';
import { MARKER_END, MARKER_START } from '../../src/core/output.js';
import { bogusBearerStep, fakeJwt, fakeSession, mintOkStep, tempRoot } from '../helpers/auth.js';
import { parseJson, runCli } from '../helpers/cli.js';
import { fakeTransport, jsonStep, type Step } from '../helpers/http.js';

interface Item {
  id: number;
  courseId: number;
  kind: string;
  title: string;
  dueDate: string | null;
  startDate: string | null;
  endDate: string | null;
  url: string;
  gradeItemId: number | null;
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
const REAL: Record<string, unknown>[] = fixture('dropbox-folders-440703.json');
const DUE: Record<string, unknown>[] = fixture('dropbox-folders-with-due-date.json');
const FOLDER: Record<string, unknown> = fixture('dropbox-folder-doc-shaped.json');
const MINE: Record<string, unknown>[] = fixture('dropbox-mysubmissions-doc-shaped.json');
const NOT_FOUND_BODY = {
  title: 'Not Found',
  status: 404,
  detail: 'Org unit does not exist or you lack access',
};

const BASE = 'https://purdue.brightspace.com';
const API = `${BASE}/d2l/api/le/1.96/440703/dropbox/folders/`;
const DEEP = (folderId: number, ou = 440703) =>
  `${BASE}/d2l/lms/dropbox/user/folder_submit_files.d2l?db=${folderId}&grpid=0&ou=${ou}`;
const ISO_S = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

const FAR_FUTURE = '2999-01-01T00:00:00Z';
const FRESH_JWT = fakeJwt({ exp: Date.parse(FAR_FUTURE) / 1000, sub: 'first' });
const NEW_JWT = fakeJwt({ exp: Date.parse(FAR_FUTURE) / 1000, sub: 'second' });

function seeded() {
  const t = tempRoot('bs-assignments-');
  writeSession(t.paths, fakeSession({ jwt: FRESH_JWT, jwtExpiresAt: FAR_FUTURE }));
  return t;
}

async function assignments(root: string, steps: Step[], args: string[], cwd = root) {
  const ft = fakeTransport(steps);
  const r = await runCli(['--root', root, 'assignments', ...args], {
    transport: ft.transport,
    cwd,
  });
  return { ...r, calls: ft.calls };
}

/** Bytes that are not valid UTF-8, so a text round-trip would corrupt them. */
const BINARY = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x00, 0xff, 0xfe, 0x80, 0x0a, 0x0d, 0x1a]);

function fileStep(
  bytes: Buffer,
  headers: Record<string, string> = {
    'content-disposition': 'attachment; filename="hw3-problems.pdf"',
    'content-type': 'application/pdf',
  },
): Step {
  return async () => ({
    status: 200,
    headers,
    body: new ReadableStream<Uint8Array>({
      start(controller) {
        // Two chunks so the writer has to handle more than one read.
        controller.enqueue(new Uint8Array(bytes.subarray(0, 4)));
        controller.enqueue(new Uint8Array(bytes.subarray(4)));
        controller.close();
      },
    }),
  });
}

function marker(): RegExp {
  return new RegExp(
    `^${MARKER_START} id="([0-9a-f]{16})">>>\\nSource: brightspace\\n---\\n[\\s\\S]*\\n${MARKER_END} id="\\1">>>$`,
  );
}

// ---------------------------------------------------------------------------------------------
// list
// ---------------------------------------------------------------------------------------------

test('assignments list --json: one GET on the bare-array route, Item rows, bearer attached', async () => {
  const { root } = seeded();
  try {
    const r = await assignments(root, [jsonStep(REAL)], ['list', '440703', '--json']);
    assert.equal(r.code, 0, r.stderr);
    const out = parseJson<ListOut<Item>>(r.stdout);
    assert.equal(out.count, 3);
    assert.match(out.fetchedAt, ISO_S);
    assert.deepEqual(out.items[0], {
      id: 445296,
      courseId: 440703,
      kind: 'assignment',
      title: 'Upload your CITI Certificate to Complete Module 2',
      dueDate: null,
      startDate: null,
      endDate: null,
      url: DEEP(445296),
      gradeItemId: null,
    });
    assert.deepEqual(
      out.items.map((i) => i.id),
      [445296, 445297, 529524],
    );
    assert.equal(r.calls.length, 1);
    const call = r.calls[0] as TransportRequest;
    assert.equal(call.method, 'GET');
    assert.equal(call.url, API);
    assert.equal(call.headers.authorization, `Bearer ${FRESH_JWT}`);
    assert.equal(r.stderr, '');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('assignments list: due dates normalise; --plain has the Item columns; human mode is a table', async () => {
  const { root } = seeded();
  try {
    const plain = await assignments(root, [jsonStep(DUE)], ['list', '1498777', '--plain']);
    assert.equal(plain.code, 0, plain.stderr);
    // Not trimEnd(): the last row ends in an empty cell, i.e. a trailing tab.
    const lines = plain.stdout.replace(/\n$/, '').split('\n');
    assert.equal(
      lines[0],
      'id\tcourseId\tkind\ttitle\tdueDate\tstartDate\tendDate\turl\tgradeItemId',
    );
    assert.equal(lines.length, 4);
    assert.equal(
      lines[1],
      `700001\t1498777\tassignment\tHomework 3\t2026-03-01T04:59:00Z\t\t\t${DEEP(700001, 1498777)}\t8801`,
    );
    assert.equal(
      lines[3],
      `700003\t1498777\tassignment\tAssignment With A Broken Date\t\t\t\t${DEEP(700003, 1498777)}\t`,
    );

    const human = await assignments(root, [jsonStep(DUE)], ['list', '1498777']);
    assert.equal(human.code, 0, human.stderr);
    const rows = human.stdout.trimEnd().split('\n');
    assert.equal(rows.length, 4);
    assert.match(rows[0] ?? '', /^ID\s+TITLE\s+DUE/);
    assert.ok(rows[2]?.includes('Group Project Milestone'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('assignments list --select / --results-only come from the output seam; --raw is lossless', async () => {
  const { root } = seeded();
  try {
    const r = await assignments(
      root,
      [jsonStep(REAL)],
      ['list', '440703', '--json', '--results-only', '--select', 'id,title'],
    );
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(parseJson(r.stdout), [
      { id: 445296, title: 'Upload your CITI Certificate to Complete Module 2' },
      { id: 445297, title: 'Report on your PURC Experience.' },
      { id: 529524, title: 'Getting Started on Scholarly Project Ideation' },
    ]);

    const raw = await assignments(
      root,
      [jsonStep(REAL)],
      ['list', '440703', '--json', '--raw', '--select', 'id'],
    );
    assert.equal(raw.code, 0, raw.stderr);
    const out = parseJson<ListOut<unknown>>(raw.stdout);
    assert.equal(out.count, 3);
    assert.deepEqual(out.items, REAL);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('assignments list with no folders: exit 0 and an empty envelope; --fail-empty → exit 3 silently', async () => {
  const { root } = seeded();
  try {
    const ok = await assignments(root, [jsonStep([])], ['list', '412690', '--json']);
    assert.equal(ok.code, 0, ok.stderr);
    assert.deepEqual(parseJson<ListOut<Item>>(ok.stdout), {
      ...parseJson<ListOut<Item>>(ok.stdout),
      items: [],
      count: 0,
    });

    const empty = await assignments(
      root,
      [jsonStep([])],
      ['list', '412690', '--json', '--fail-empty'],
    );
    assert.equal(empty.code, EXIT_CODES.empty_results);
    assert.equal(parseJson<ListOut<Item>>(empty.stdout).count, 0, 'output still written');
    assert.equal(empty.stderr, '');

    const plain = await assignments(
      root,
      [jsonStep([])],
      ['list', '412690', '--plain', '--fail-empty'],
    );
    assert.equal(plain.code, EXIT_CODES.empty_results);
    assert.equal(plain.stdout.trimEnd().split('\n').length, 1, 'header row only');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('assignments list: a non-array 200 body is a shape error (exit 1); 404 → 5; 403 → 6 permission denied', async () => {
  const { root } = seeded();
  try {
    const shape = await assignments(root, [jsonStep(NOT_FOUND_BODY)], ['list', '440703', '--json']);
    assert.equal(shape.code, EXIT_CODES.error);
    assert.equal(shape.stdout, '');
    assert.match(shape.stderr, /JSON array/);

    const missing = await assignments(
      root,
      [jsonStep(NOT_FOUND_BODY, 404)],
      ['list', '999', '--json'],
    );
    assert.equal(missing.code, EXIT_CODES.not_found);
    assert.equal(missing.stdout, '');
    assert.match(missing.stderr, /bs: .*404/);

    const denied = await assignments(
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

test('assignments list skips an undecodable folder with a warning; nothing decodable is an error', async () => {
  const { root } = seeded();
  try {
    const mixed = [REAL[0], { Name: 'mid-deletion' }];
    const r = await assignments(root, [jsonStep(mixed)], ['list', '440703', '--json']);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(parseJson<ListOut<Item>>(r.stdout).count, 1);
    assert.match(r.stderr, /warning: .*1 .*undecodable/);

    const none = await assignments(root, [jsonStep([{ Id: 'x' }])], ['list', '440703', '--json']);
    assert.equal(none.code, EXIT_CODES.error);
    assert.equal(none.stdout, '');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('assignments list with no session: exit 4, login hint, no request', async () => {
  const { root } = tempRoot('bs-assignments-');
  try {
    const r = await assignments(root, [jsonStep(REAL)], ['list', '440703', '--json']);
    assert.equal(r.code, EXIT_CODES.auth_required);
    assert.equal(r.stdout, '');
    assert.ok(r.stderr.includes(HINT_LOGIN), r.stderr);
    assert.equal(r.calls.length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('assignments list whose first call answers 401 re-mints once and retries with the new token', async () => {
  const { root } = seeded();
  try {
    const r = await assignments(
      root,
      [bogusBearerStep, mintOkStep(NEW_JWT), jsonStep(REAL)],
      ['list', '440703', '--json'],
    );
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(
      r.calls.map((c) => c.method),
      ['GET', 'POST', 'GET'],
    );
    assert.equal(r.calls[0]?.headers.authorization, `Bearer ${FRESH_JWT}`);
    assert.equal(r.calls[2]?.headers.authorization, `Bearer ${NEW_JWT}`);
    assert.equal(parseJson<ListOut<Item>>(r.stdout).count, 3);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------------------------
// get
// ---------------------------------------------------------------------------------------------

test('assignments get --json: the single-folder route, Item + instructions/attachments/availability', async () => {
  const { root } = seeded();
  try {
    const r = await assignments(root, [jsonStep(FOLDER)], ['get', '1498777', '700001', '--json']);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.calls[0]?.url, `${BASE}/d2l/api/le/1.96/1498777/dropbox/folders/700001`);
    const out = parseJson<Record<string, unknown>>(r.stdout);
    assert.equal(out.id, 700001);
    assert.equal(out.courseId, 1498777);
    assert.equal(out.title, 'Homework 3');
    assert.equal(out.dueDate, '2026-03-01T04:59:00Z');
    assert.equal(out.url, DEEP(700001, 1498777));
    assert.deepEqual(out.instructions, {
      text: 'Submit a PDF of your solutions. Show your work.',
      html: '<p>Submit a <strong>PDF</strong> of your solutions. Show your work.</p>',
    });
    assert.deepEqual(out.attachments, [
      { fileId: 90001, fileName: 'hw3-problems.pdf', size: 184320 },
      { fileId: 90002, fileName: 'starter code.zip', size: 40960 },
    ]);
    assert.deepEqual(out.availability, {
      startDate: '2026-02-15T05:00:00Z',
      endDate: '2026-03-08T04:59:00Z',
      startType: 'accessRestricted',
      endType: 'submissionRestricted',
    });
    assert.equal(out.submissionType, 'file');
    assert.equal(out.scoreDenominator, 100);

    const plain = await assignments(
      root,
      [jsonStep(FOLDER)],
      ['get', '1498777', '700001', '--plain'],
    );
    assert.equal(plain.code, 0, plain.stderr);
    const lines = plain.stdout.trimEnd().split('\n');
    assert.equal(lines[0], 'key\tvalue');
    const map = new Map(lines.slice(1).map((l) => l.split('\t') as [string, string]));
    assert.equal(map.get('id'), '700001');
    assert.equal(map.get('gradeItemId'), '8801');

    const human = await assignments(root, [jsonStep(FOLDER)], ['get', '1498777', '700001']);
    assert.equal(human.code, 0, human.stderr);
    assert.ok(human.stdout.includes('Homework 3'));
    assert.ok(human.stdout.includes('hw3-problems.pdf'));

    const raw = await assignments(
      root,
      [jsonStep(FOLDER)],
      ['get', '1498777', '700001', '--json', '--raw'],
    );
    assert.equal(raw.code, 0, raw.stderr);
    assert.deepEqual(parseJson(raw.stdout), FOLDER);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('assignments get 404 → exit 5 with a list hint; 403 → exit 6 with the neutral denied hint', async () => {
  const { root } = seeded();
  try {
    const missing = await assignments(
      root,
      [jsonStep({ title: 'Not Found', status: 404, detail: 'No folder' }, 404)],
      ['get', '440703', '999', '--json'],
    );
    assert.equal(missing.code, EXIT_CODES.not_found);
    assert.equal(missing.stdout, '');
    assert.match(missing.stderr, /bs: .*999.*404/);
    assert.match(missing.stderr, /assignments list 440703/);

    const denied = await assignments(
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

test('assignments get --wrap-untrusted wraps title and instructions, never ids, urls, dates or file names', async () => {
  const { root } = seeded();
  try {
    const r = await assignments(
      root,
      [jsonStep(FOLDER)],
      ['get', '1498777', '700001', '--json', '--wrap-untrusted'],
    );
    assert.equal(r.code, 0, r.stderr);
    const out = parseJson<Record<string, unknown>>(r.stdout);
    const instructions = out.instructions as Record<string, string>;
    assert.match(String(out.title), marker());
    assert.match(instructions.text ?? '', marker());
    assert.match(instructions.html ?? '', marker());
    assert.ok(instructions.text?.includes('Submit a PDF'));
    const links = out.linkAttachments as Record<string, string>[];
    assert.match(links[0]?.name ?? '', marker());
    assert.equal(links[0]?.href, 'https://example.invalid/style-guide');
    assert.equal(out.id, 700001);
    assert.equal(out.url, DEEP(700001, 1498777));
    assert.equal(out.dueDate, '2026-03-01T04:59:00Z');
    const attachments = out.attachments as Record<string, unknown>[];
    assert.equal(attachments[0]?.fileName, 'hw3-problems.pdf');
    assert.deepEqual(out.externalContent, {
      untrusted: true,
      source: 'brightspace',
      wrapped: true,
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------------------------
// submissions
// ---------------------------------------------------------------------------------------------

test('assignments submissions --json: the mysubmissions route, curated Submission rows', async () => {
  const { root } = seeded();
  try {
    const r = await assignments(
      root,
      [jsonStep(MINE)],
      ['submissions', '440703', '445296', '--json'],
    );
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.calls[0]?.url, `${API}445296/submissions/mysubmissions/`);
    const out = parseJson<ListOut<Record<string, unknown>>>(r.stdout);
    assert.equal(out.count, 1);
    const s = out.items[0] as Record<string, unknown>;
    assert.equal(s.entityId, 2094411);
    assert.equal(s.status, 'submitted');
    assert.equal(s.completionDate, '2026-02-28T22:14:05Z');
    assert.deepEqual(s.feedback, {
      score: 92.5,
      isGraded: true,
      text: 'Nice work; cite the second source next time.',
      html: '<p>Nice work; cite the <em>second</em> source next time.</p>',
      files: [{ fileId: 55001, fileName: 'hw3-annotated.pdf', size: 10240 }],
    });
    const subs = s.submissions as Record<string, unknown>[];
    assert.equal(subs.length, 2);
    const newest = subs[0] as Record<string, unknown>;
    assert.equal(newest.id, 31001);
    assert.deepEqual((newest.files as unknown[])[0], {
      fileId: 41001,
      fileName: 'hw3.pdf',
      size: 204800,
      isRead: true,
      isFlagged: false,
    });
    assert.equal(s.url, DEEP(445296));

    const plain = await assignments(
      root,
      [jsonStep(MINE)],
      ['submissions', '440703', '445296', '--plain'],
    );
    assert.equal(plain.code, 0, plain.stderr);
    const lines = plain.stdout.trimEnd().split('\n');
    assert.equal(
      lines[0],
      'entityId\tentityType\tname\tstatus\tcompletionDate\tscore\tisGraded\tsubmissionCount\tfileCount\tlastSubmittedAt\turl',
    );
    assert.equal(
      lines[1],
      `2094411\tUser\tAda Lovelace\tsubmitted\t2026-02-28T22:14:05Z\t92.5\ttrue\t2\t3\t2026-02-28T22:14:05Z\t${DEEP(445296)}`,
    );

    const human = await assignments(root, [jsonStep(MINE)], ['submissions', '440703', '445296']);
    assert.equal(human.code, 0, human.stderr);
    assert.ok(human.stdout.includes('submitted'));
    assert.ok(human.stdout.includes('hw3.pdf'));
    assert.ok(human.stdout.includes('41001'));

    const wrapped = await assignments(
      root,
      [jsonStep(MINE)],
      ['submissions', '440703', '445296', '--json', '--wrap-untrusted'],
    );
    assert.equal(wrapped.code, 0, wrapped.stderr);
    const w = parseJson<ListOut<Record<string, unknown>>>(wrapped.stdout).items[0] as Record<
      string,
      unknown
    >;
    assert.match(String((w.feedback as Record<string, unknown>).text), marker());
    assert.match(String((w.feedback as Record<string, unknown>).html), marker());
    const first = (w.submissions as Record<string, unknown>[])[0] as Record<string, unknown>;
    assert.match(String((first.comment as Record<string, unknown>).text), marker());
    assert.equal(w.status, 'submitted');
    assert.equal(w.completionDate, '2026-02-28T22:14:05Z');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('assignments submissions: nothing submitted yet is an empty list; --fail-empty → 3; --raw lossless', async () => {
  const { root } = seeded();
  try {
    const ok = await assignments(
      root,
      [jsonStep([])],
      ['submissions', '440703', '445296', '--json'],
    );
    assert.equal(ok.code, 0, ok.stderr);
    assert.equal(parseJson<ListOut<unknown>>(ok.stdout).count, 0);

    const empty = await assignments(
      root,
      [jsonStep([])],
      ['submissions', '440703', '445296', '--json', '--fail-empty'],
    );
    assert.equal(empty.code, EXIT_CODES.empty_results);
    assert.equal(parseJson<ListOut<unknown>>(empty.stdout).count, 0);

    const raw = await assignments(
      root,
      [jsonStep(MINE)],
      ['submissions', '440703', '445296', '--json', '--raw'],
    );
    assert.equal(raw.code, 0, raw.stderr);
    assert.deepEqual(parseJson<ListOut<unknown>>(raw.stdout).items, MINE);

    const denied = await assignments(
      root,
      [{ status: 403, body: 'Not authorized' }],
      ['submissions', '1092755', '5', '--json'],
    );
    assert.equal(denied.code, EXIT_CODES.permission_denied);
    const missing = await assignments(
      root,
      [jsonStep(NOT_FOUND_BODY, 404)],
      ['submissions', '440703', '999', '--json'],
    );
    assert.equal(missing.code, EXIT_CODES.not_found);
    assert.match(missing.stderr, /assignments list 440703/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------------------------
// download
// ---------------------------------------------------------------------------------------------

test('assignments download streams an instructor attachment into --out <dir> byte for byte', async () => {
  const { root } = seeded();
  const out = path.join(root, 'downloads');
  mkdirSync(out);
  try {
    const r = await assignments(
      root,
      [fileStep(BINARY)],
      ['download', '1498777', '700001', '90001', '--out', out, '--json'],
    );
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.calls.length, 1);
    assert.equal(
      r.calls[0]?.url,
      `${BASE}/d2l/api/le/1.96/1498777/dropbox/folders/700001/attachments/90001`,
    );
    assert.equal(r.calls[0]?.headers.authorization, `Bearer ${FRESH_JWT}`);
    const target = path.join(out, 'hw3-problems.pdf');
    assert.deepEqual(readFileSync(target), BINARY);
    assert.deepEqual(parseJson(r.stdout), {
      fileId: 90001,
      submissionId: null,
      fileName: 'hw3-problems.pdf',
      path: target,
      bytes: BINARY.length,
      contentType: 'application/pdf',
    });
    assert.equal(r.stderr, '');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('assignments download: --out <file> names the file; omitted --out writes into cwd; human/plain output', async () => {
  const { root } = seeded();
  const cwd = path.join(root, 'cwd');
  mkdirSync(cwd);
  try {
    const named = path.join(root, 'nested', 'dir', 'problems.pdf');
    const r = await assignments(
      root,
      [fileStep(BINARY)],
      ['download', '1498777', '700001', '90001', '--out', named],
      cwd,
    );
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(readFileSync(named), BINARY);
    assert.equal(r.stdout, `wrote ${BINARY.length} bytes to ${named}\n`);

    const relative = await assignments(
      root,
      [fileStep(BINARY)],
      ['download', '1498777', '700001', '90001', '--plain'],
      cwd,
    );
    assert.equal(relative.code, 0, relative.stderr);
    const inCwd = path.join(cwd, 'hw3-problems.pdf');
    assert.deepEqual(readFileSync(inCwd), BINARY);
    const lines = relative.stdout.trimEnd().split('\n');
    assert.equal(lines[0], 'fileId\tsubmissionId\tfileName\tpath\tbytes\tcontentType');
    assert.equal(
      lines[1],
      `90001\t\thw3-problems.pdf\t${inCwd}\t${BINARY.length}\tapplication/pdf`,
    );

    const rel = await assignments(
      root,
      [fileStep(BINARY)],
      ['download', '1498777', '700001', '90001', '--out', 'sub/', '--json'],
      cwd,
    );
    assert.equal(rel.code, 0, rel.stderr);
    assert.equal(
      parseJson<{ path: string }>(rel.stdout).path,
      path.join(cwd, 'sub', 'hw3-problems.pdf'),
      'a trailing slash means "a directory", created on demand, relative to cwd',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('assignments download never overwrites without --force; --force replaces the file', async () => {
  const { root } = seeded();
  const out = path.join(root, 'downloads');
  mkdirSync(out);
  const target = path.join(out, 'hw3-problems.pdf');
  writeFileSync(target, 'old contents');
  try {
    const refused = await assignments(
      root,
      [fileStep(BINARY)],
      ['download', '1498777', '700001', '90001', '--out', out, '--json'],
    );
    assert.equal(refused.code, EXIT_CODES.usage);
    assert.equal(refused.stdout, '');
    assert.match(refused.stderr, /--force/);
    assert.equal(readFileSync(target, 'utf8'), 'old contents');

    const forced = await assignments(
      root,
      [fileStep(BINARY)],
      ['download', '1498777', '700001', '90001', '--out', out, '--json', '--force'],
    );
    assert.equal(forced.code, 0, forced.stderr);
    assert.deepEqual(readFileSync(target), BINARY);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('assignments download --submission <sid> uses the submission-file route', async () => {
  const { root } = seeded();
  try {
    const r = await assignments(
      root,
      [
        fileStep(BINARY, {
          'content-disposition': "attachment; filename*=UTF-8''r%C3%A9sum%C3%A9%20v2.pdf",
        }),
      ],
      ['download', '440703', '445296', '41001', '--submission', '31001', '--out', root, '--json'],
    );
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.calls[0]?.url, `${API}445296/submissions/31001/files/41001`);
    const out = parseJson<{
      path: string;
      fileName: string;
      submissionId: number;
      contentType: null;
    }>(r.stdout);
    assert.equal(out.fileName, 'résumé v2.pdf');
    assert.equal(out.submissionId, 31001);
    assert.equal(out.contentType, null);
    assert.deepEqual(readFileSync(path.join(root, 'résumé v2.pdf')), BINARY);
    assert.equal(out.path, path.join(root, 'résumé v2.pdf'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('assignments download --out - streams the bytes to stdout; refused under --json/--plain', async () => {
  const { root } = seeded();
  try {
    const ft = fakeTransport([fileStep(BINARY)]);
    const chunks: Buffer[] = [];
    const stdout = {
      write(chunk: string | Uint8Array) {
        chunks.push(typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : Buffer.from(chunk));
        return true;
      },
    };
    const stderr = {
      text: '',
      write(chunk: string) {
        stderr.text += chunk;
        return true;
      },
    };
    const code = await runCli(
      ['--root', root, 'assignments', 'download', '1498777', '700001', '90001', '--out', '-'],
      { transport: ft.transport, stdout, stderr, cwd: root },
    );
    assert.equal(code.code, 0, stderr.text);
    assert.deepEqual(Buffer.concat(chunks), BINARY);
    assert.equal(existsSync(path.join(root, 'hw3-problems.pdf')), false);

    for (const mode of ['--json', '--plain']) {
      const r = await assignments(
        root,
        [fileStep(BINARY)],
        ['download', '1498777', '700001', '90001', '--out', '-', mode],
      );
      assert.equal(r.code, EXIT_CODES.usage, mode);
      assert.equal(r.calls.length, 0, 'refused before any request');
      assert.equal(r.stdout, '');
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('assignments download: an unnamed stream falls back to file-<id>; unsafe names are sanitised', async () => {
  const { root } = seeded();
  try {
    const anon = await assignments(
      root,
      [fileStep(BINARY, {})],
      ['download', '1498777', '700001', '90001', '--out', root, '--json'],
    );
    assert.equal(anon.code, 0, anon.stderr);
    assert.equal(parseJson<{ fileName: string }>(anon.stdout).fileName, 'file-90001');
    assert.deepEqual(readFileSync(path.join(root, 'file-90001')), BINARY);

    const evil = await assignments(
      root,
      [fileStep(BINARY, { 'content-disposition': 'attachment; filename="../../escape.pdf"' })],
      ['download', '1498777', '700001', '90002', '--out', root, '--json'],
    );
    assert.equal(evil.code, 0, evil.stderr);
    assert.equal(parseJson<{ path: string }>(evil.stdout).path, path.join(root, 'escape.pdf'));
    assert.equal(existsSync(path.join(root, '..', 'escape.pdf')), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('assignments download 404 → exit 5 with a hint naming get/submissions; 403 → 6; nothing written', async () => {
  const { root } = seeded();
  const out = path.join(root, 'downloads');
  mkdirSync(out);
  try {
    const missing = await assignments(
      root,
      [jsonStep({ title: 'Not Found', status: 404, detail: 'No such file' }, 404)],
      ['download', '1498777', '700001', '1', '--out', out, '--json'],
    );
    assert.equal(missing.code, EXIT_CODES.not_found);
    assert.equal(missing.stdout, '');
    assert.match(missing.stderr, /assignments get 1498777 700001/);
    assert.match(missing.stderr, /assignments submissions 1498777 700001/);

    const denied = await assignments(
      root,
      [{ status: 403, body: 'Not authorized' }],
      ['download', '1092755', '5', '6', '--out', out, '--json'],
    );
    assert.equal(denied.code, EXIT_CODES.permission_denied);
    assert.match(denied.stderr, /denied this route/);
    assert.deepEqual(readdirSync(out), [], 'directory left empty');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('assignments download whose first call answers 401 re-mints once and streams on the retry', async () => {
  const { root } = seeded();
  try {
    const r = await assignments(
      root,
      [bogusBearerStep, mintOkStep(NEW_JWT), fileStep(BINARY)],
      ['download', '1498777', '700001', '90001', '--out', root, '--json'],
    );
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(
      r.calls.map((c) => c.method),
      ['GET', 'POST', 'GET'],
    );
    assert.equal(r.calls[2]?.headers.authorization, `Bearer ${NEW_JWT}`);
    assert.deepEqual(readFileSync(path.join(root, 'hw3-problems.pdf')), BINARY);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------------------------
// argument validation and side effects
// ---------------------------------------------------------------------------------------------

test('assignments rejects non-numeric ids before any request (ou, folderId, fileId, --submission)', async () => {
  const { root } = seeded();
  try {
    const cases: string[][] = [
      ['list', 'abc'],
      ['list', '0'],
      ['list'],
      ['get', '440703', '-1'],
      ['get', '440703', '1.5'],
      ['get', '440703'],
      ['submissions', 'x', '1'],
      ['download', '440703', '1', 'file'],
      ['download', '440703', '1'],
      ['download', '440703', '1', '2', '--submission', '0'],
      ['download', '440703', '1', '2', '--submission', 'abc'],
    ];
    for (const argv of cases) {
      const r = await assignments(root, [jsonStep(REAL)], [...argv, '--json']);
      assert.equal(r.code, EXIT_CODES.usage, argv.join(' '));
      assert.equal(r.calls.length, 0, argv.join(' '));
      assert.equal(r.stdout, '');
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('assignments --help and schema create no state directory', async () => {
  const { root } = tempRoot('bs-assignments-');
  const state = `${root}/state`;
  try {
    for (const argv of [
      ['assignments', '--help'],
      ['assignments', 'download', '--help'],
      ['schema', 'assignments', 'list'],
    ]) {
      const r = await runCli(['--root', state, ...argv]);
      assert.equal(r.code, 0, argv.join(' '));
      assert.throws(() => readFileSync(state), argv.join(' '));
    }
    const schema = await runCli(['--root', state, 'schema', 'assignments', '--json']);
    assert.equal(schema.code, 0);
    const names = (
      parseJson<{ command: { subcommands: { name: string }[] } }>(schema.stdout).command
        .subcommands ?? []
    ).map((c) => c.name);
    assert.deepEqual(names, ['download', 'get', 'list', 'submissions']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
