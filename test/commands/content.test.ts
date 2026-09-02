import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { writeSession } from '../../src/auth/session.js';
import { EXIT_CODES } from '../../src/core/errors.js';
import { MARKER_START } from '../../src/core/output.js';
import { bogusBearerStep, fakeJwt, fakeSession, mintOkStep, tempRoot } from '../helpers/auth.js';
import { parseJson, runCli } from '../helpers/cli.js';
import { fakeTransport, jsonStep, type Step, streamOf } from '../helpers/http.js';

interface Topic {
  id: number;
  courseId: number;
  kind: 'content';
  moduleId: number | null;
  depth: number;
  path: string;
  title: string;
  activityType: string;
  activityTypeId: number | null;
  toolId: number | null;
  toolItemId: number | null;
  url: string | null;
  dueDate: string | null;
  startDate: string | null;
  endDate: string | null;
  isHidden: boolean;
  isLocked: boolean;
  isExempt: boolean;
  isBroken: boolean;
  gradeItemId: number | null;
}
interface TocModule {
  id: number;
  kind: 'module';
  parentId: number | null;
  depth: number;
  title: string;
  topics: Topic[];
  modules: TocModule[];
}
interface ListOut<T> {
  items: T[];
  count: number;
  fetchedAt: string;
}
interface DownloadOut {
  topicId: number;
  courseId: number;
  fileName: string;
  path: string;
  bytes: number;
  contentType: string | null;
}

const FIXTURES = new URL('../fixtures/', import.meta.url);
function fixture<T = unknown>(name: string): T {
  return JSON.parse(readFileSync(new URL(name, FIXTURES), 'utf8')) as T;
}
const TOC = fixture<{ Modules: unknown[] }>('content-toc-doc-shaped.json');
const EMPTY = fixture<{ Modules: unknown[] }>('content-toc-empty.json');
const TOPIC = fixture<Record<string, unknown>>('content-topic-4000001-doc-shaped.json');
const LINK = fixture<Record<string, unknown>>('content-topic-4000002-link-doc-shaped.json');
const STRUCTURE = fixture<unknown[]>('content-module-3000001-structure-doc-shaped.json');
const NOT_A_FILE = fixture<Record<string, unknown>>('content-topic-not-a-file-400.json');

const BASE = 'https://purdue.brightspace.com';
const OU = 412690;
const LE = `${BASE}/d2l/api/le/1.96/${OU}/content`;
const ISO_S = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
const PDF_BYTES = '%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\n%%EOF\n';

const FAR_FUTURE = '2999-01-01T00:00:00Z';
const FRESH_JWT = fakeJwt({ exp: Date.parse(FAR_FUTURE) / 1000, sub: 'first' });
const NEW_JWT = fakeJwt({ exp: Date.parse(FAR_FUTURE) / 1000, sub: 'second' });

function seeded() {
  const t = tempRoot('bs-content-');
  writeSession(t.paths, fakeSession({ jwt: FRESH_JWT, jwtExpiresAt: FAR_FUTURE }));
  return t;
}

async function content(root: string, steps: Step[], args: string[], cwd?: string) {
  const ft = fakeTransport(steps);
  const r = await runCli(['--root', root, 'content', ...args], {
    transport: ft.transport,
    ...(cwd === undefined ? {} : { cwd }),
  });
  return { ...r, calls: ft.calls };
}

/** A 200 file stream the way the fetch transport hands it over. */
function fileStep(headers: Record<string, string> = {}): Step {
  return {
    status: 200,
    headers: { 'content-type': 'application/pdf', ...headers },
    body: streamOf(PDF_BYTES),
  };
}

const SLIDES: Topic = {
  id: 4000001,
  courseId: OU,
  kind: 'content',
  moduleId: 3000002,
  depth: 2,
  path: 'Week 1: Foundations / Lectures',
  title: 'Lecture 1 slides',
  activityType: 'File',
  activityTypeId: 1,
  toolId: null,
  toolItemId: null,
  url: `${BASE}/content/enforced/412690-CS180/lecture01.pdf`,
  dueDate: null,
  startDate: null,
  endDate: null,
  isHidden: false,
  isLocked: false,
  isExempt: false,
  isBroken: false,
  gradeItemId: null,
};

// ---------------------------------------------------------------------------------------------
// toc
// ---------------------------------------------------------------------------------------------

test('content toc --json emits the module tree; --flat one topic row per line', async () => {
  const { root } = seeded();
  try {
    const tree = await content(root, [jsonStep(TOC)], ['toc', String(OU), '--json']);
    assert.equal(tree.code, 0, tree.stderr);
    assert.equal(tree.calls.length, 1);
    assert.equal(tree.calls[0]?.url, `${LE}/toc?ignoreDateRestrictions=true`);
    assert.equal(tree.calls[0]?.headers.authorization, `Bearer ${FRESH_JWT}`);
    const out = parseJson<ListOut<TocModule>>(tree.stdout);
    assert.equal(out.count, 2);
    assert.match(out.fetchedAt, ISO_S);
    assert.equal(out.items[0]?.kind, 'module');
    assert.equal(out.items[0]?.title, 'Week 1: Foundations');
    assert.equal(out.items[0]?.parentId, null);
    assert.deepEqual(out.items[0]?.modules[0]?.topics[0], SLIDES);
    assert.equal(out.items[0]?.topics[0]?.id, 4000003);

    const flat = await content(root, [jsonStep(TOC)], ['toc', String(OU), '--flat', '--json']);
    assert.equal(flat.code, 0, flat.stderr);
    const rows = parseJson<ListOut<Topic>>(flat.stdout);
    assert.equal(rows.count, 4);
    assert.deepEqual(
      rows.items.map((r) => r.id),
      [4000003, 4000001, 4000002, 4000004],
    );
    assert.deepEqual(rows.items[1], SLIDES);
    assert.equal(rows.items[3]?.path, 'Gradescope');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('content toc --plain is always the flat topic rows; --select projects per row', async () => {
  const { root } = seeded();
  try {
    const plain = await content(root, [jsonStep(TOC)], ['toc', String(OU), '--plain']);
    assert.equal(plain.code, 0, plain.stderr);
    const lines = plain.stdout.trimEnd().split('\n');
    assert.equal(lines.length, 5, plain.stdout);
    const header = lines[0]?.split('\t') ?? [];
    assert.deepEqual(header.slice(0, 6), ['id', 'courseId', 'kind', 'moduleId', 'depth', 'path']);
    const slides = lines[2]?.split('\t') ?? [];
    assert.equal(slides[0], '4000001');
    assert.equal(slides[5], 'Week 1: Foundations / Lectures');
    assert.equal(slides[header.indexOf('activityType')], 'File');
    assert.equal(slides[header.indexOf('url')], SLIDES.url);

    const flatPlain = await content(
      root,
      [jsonStep(TOC)],
      ['toc', String(OU), '--flat', '--plain'],
    );
    assert.equal(flatPlain.stdout, plain.stdout);

    const selected = await content(
      root,
      [jsonStep(TOC)],
      ['toc', String(OU), '--flat', '--json', '--select', 'id,path,activityType'],
    );
    assert.equal(selected.code, 0, selected.stderr);
    const out = parseJson<ListOut<Record<string, unknown>>>(selected.stdout);
    assert.deepEqual(out.items[0], {
      id: 4000003,
      path: 'Week 1: Foundations',
      activityType: 'Quiz',
    });
    assert.equal(out.count, 4);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('content toc: empty TOC is exit 0, exit 3 under --fail-empty with the output still written', async () => {
  const { root } = seeded();
  try {
    const ok = await content(root, [jsonStep(EMPTY)], ['toc', String(OU), '--json']);
    assert.equal(ok.code, 0, ok.stderr);
    assert.equal(parseJson<ListOut<unknown>>(ok.stdout).count, 0);

    for (const extra of [[], ['--flat']]) {
      const r = await content(
        root,
        [jsonStep(EMPTY)],
        ['toc', String(OU), '--json', '--fail-empty', ...extra],
      );
      assert.equal(r.code, EXIT_CODES.empty_results, extra.join(' '));
      assert.deepEqual(parseJson<ListOut<unknown>>(r.stdout).items, []);
      assert.equal(r.stderr, '');
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('content toc --limit caps topic rows (--flat) or top-level modules (tree)', async () => {
  const { root } = seeded();
  try {
    const flat = await content(
      root,
      [jsonStep(TOC)],
      ['toc', String(OU), '--flat', '--json', '--limit', '2'],
    );
    assert.equal(flat.code, 0, flat.stderr);
    assert.deepEqual(
      parseJson<ListOut<Topic>>(flat.stdout).items.map((r) => r.id),
      [4000003, 4000001],
    );
    const tree = await content(
      root,
      [jsonStep(TOC)],
      ['toc', String(OU), '--json', '--limit', '1'],
    );
    assert.equal(tree.code, 0, tree.stderr);
    const out = parseJson<ListOut<TocModule>>(tree.stdout);
    assert.equal(out.count, 1);
    assert.equal(out.items[0]?.id, 3000001);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('content toc --wrap-untrusted wraps titles (and sanitises look-alikes) but never path, url, type', async () => {
  const { root } = seeded();
  try {
    const flat = await content(
      root,
      [jsonStep(TOC)],
      ['toc', String(OU), '--flat', '--json', '--wrap-untrusted'],
    );
    assert.equal(flat.code, 0, flat.stderr);
    const out = parseJson<ListOut<Topic> & { externalContent: unknown }>(flat.stdout);
    const recording = out.items[2];
    assert.ok(recording?.title.startsWith(MARKER_START), recording?.title);
    assert.ok(recording?.title.includes('[[MARKER_SANITIZED]]'), recording?.title);
    assert.equal(recording?.url, 'https://mediaspace.example.edu/media/lecture01');
    assert.equal(recording?.activityType, 'Link');
    assert.equal(recording?.path, 'Week 1: Foundations / Lectures');
    assert.deepEqual(out.externalContent, {
      untrusted: true,
      source: 'brightspace',
      wrapped: true,
    });

    const tree = await content(
      root,
      [jsonStep(TOC)],
      ['toc', String(OU), '--json', '--wrap-untrusted'],
    );
    const modules = parseJson<ListOut<TocModule>>(tree.stdout);
    assert.ok(modules.items[0]?.title.startsWith(MARKER_START));
    assert.ok(modules.items[0]?.modules[0]?.topics[0]?.title.startsWith(MARKER_START));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('content toc --raw emits the {Modules} payload; human mode renders an indented tree', async () => {
  const { root } = seeded();
  try {
    const raw = await content(root, [jsonStep(TOC)], ['toc', String(OU), '--raw']);
    assert.equal(raw.code, 0, raw.stderr);
    assert.deepEqual(parseJson(raw.stdout), TOC);

    const human = await content(root, [jsonStep(TOC)], ['toc', String(OU)]);
    assert.equal(human.code, 0, human.stderr);
    assert.match(human.stdout, /Week 1: Foundations/);
    assert.match(human.stdout, /Lecture 1 slides/);
    assert.match(human.stdout, /4000001/);
    const week = human.stdout.indexOf('Week 1: Foundations');
    const lectures = human.stdout.indexOf('Lectures');
    const slides = human.stdout.indexOf('Lecture 1 slides');
    assert.ok(week < lectures && lectures < slides, human.stdout);

    const table = await content(root, [jsonStep(TOC)], ['toc', String(OU), '--flat']);
    assert.equal(table.code, 0, table.stderr);
    assert.match(table.stdout, /^ID\s+TYPE\s+TITLE\s+PATH/, table.stdout);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('content toc maps 403 to exit 6 with the past-term hint and 404 to exit 5', async () => {
  const { root } = seeded();
  try {
    const forbidden = await content(
      root,
      [{ status: 403, body: 'Not authorized' }],
      ['toc', String(OU), '--json'],
    );
    assert.equal(forbidden.code, EXIT_CODES.permission_denied);
    assert.equal(forbidden.stdout, '');
    assert.match(
      forbidden.stderr,
      /bs: GET .*\/content\/toc\?ignoreDateRestrictions=true: HTTP 403/,
    );
    assert.match(forbidden.stderr, /past-term/);

    const missing = await content(
      root,
      [jsonStep({ title: 'Not Found', status: 404, detail: 'org unit not found' }, 404)],
      ['toc', '999', '--json'],
    );
    assert.equal(missing.code, EXIT_CODES.not_found);
    assert.equal(missing.stdout, '');
    assert.match(missing.stderr, /HTTP 404/);
    assert.match(missing.stderr, /bs courses list/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('content toc whose first call answers 401 re-mints once and re-runs the request', async () => {
  const { root } = seeded();
  try {
    const r = await content(
      root,
      [bogusBearerStep, mintOkStep(NEW_JWT), jsonStep(TOC)],
      ['toc', String(OU), '--flat', '--json'],
    );
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(
      r.calls.map((c) => c.method),
      ['GET', 'POST', 'GET'],
    );
    assert.equal(r.calls[2]?.headers.authorization, `Bearer ${NEW_JWT}`);
    assert.equal(parseJson<ListOut<Topic>>(r.stdout).count, 4);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------------------------
// get
// ---------------------------------------------------------------------------------------------

test('content get --json emits the topic detail with dueDate and description; wrap markers apply', async () => {
  const { root } = seeded();
  try {
    const r = await content(root, [jsonStep(TOPIC)], ['get', String(OU), '4000001', '--json']);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.calls.length, 1);
    assert.equal(r.calls[0]?.url, `${LE}/topics/4000001`);
    const out = parseJson<Record<string, unknown>>(r.stdout);
    assert.equal(out.id, 4000001);
    assert.equal(out.kind, 'content');
    assert.equal(out.moduleId, 3000002);
    assert.equal(out.dueDate, '2026-09-15T23:59:00Z');
    assert.equal(out.startDate, '2026-08-24T04:00:00Z');
    assert.equal(out.topicType, 'File');
    assert.equal(out.description, 'Slides for lecture 1. Read before Friday.');
    assert.equal(out.url, SLIDES.url);
    assert.equal(out.path, null);

    const wrapped = await content(
      root,
      [jsonStep(TOPIC)],
      ['get', String(OU), '4000001', '--json', '--wrap-untrusted'],
    );
    const w = parseJson<Record<string, string>>(wrapped.stdout);
    assert.ok(w.title?.startsWith(MARKER_START));
    assert.ok(w.description?.startsWith(MARKER_START));
    assert.ok(w.descriptionHtml?.startsWith(MARKER_START));
    assert.equal(w.url, SLIDES.url);
    assert.equal(w.dueDate, '2026-09-15T23:59:00Z');

    const plain = await content(root, [jsonStep(TOPIC)], ['get', String(OU), '4000001', '--plain']);
    assert.equal(plain.code, 0, plain.stderr);
    const lines = plain.stdout.trimEnd().split('\n');
    assert.equal(lines[0], 'key\tvalue');
    assert.ok(lines.includes('dueDate\t2026-09-15T23:59:00Z'), plain.stdout);
    assert.ok(lines.includes('title\tLecture 1 slides'), plain.stdout);

    const human = await content(root, [jsonStep(TOPIC)], ['get', String(OU), '4000001']);
    assert.equal(human.code, 0, human.stderr);
    assert.match(human.stdout, /Lecture 1 slides/);
    assert.match(human.stdout, /due: 2026-09-15T23:59:00Z/);
    assert.match(human.stdout, /Read before Friday/);

    const raw = await content(root, [jsonStep(TOPIC)], ['get', String(OU), '4000001', '--raw']);
    assert.deepEqual(parseJson(raw.stdout), TOPIC);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('content get: 404 → exit 5 with a toc hint, 403 → exit 6, 400 (a module id) → exit 2', async () => {
  const { root } = seeded();
  try {
    const missing = await content(
      root,
      [jsonStep({ title: 'Not Found', status: 404 }, 404)],
      ['get', String(OU), '999', '--json'],
    );
    assert.equal(missing.code, EXIT_CODES.not_found);
    assert.equal(missing.stdout, '');
    assert.match(missing.stderr, /bs content toc 412690/);

    const forbidden = await content(
      root,
      [{ status: 403, body: 'Not authorized' }],
      ['get', String(OU), '4000001', '--json'],
    );
    assert.equal(forbidden.code, EXIT_CODES.permission_denied);
    assert.match(forbidden.stderr, /HTTP 403/);

    const module = await content(
      root,
      [jsonStep({ title: 'Bad Request', status: 400, detail: 'Invalid topic' }, 400)],
      ['get', String(OU), '3000001', '--json'],
    );
    assert.equal(module.code, EXIT_CODES.usage);
    assert.equal(module.stdout, '');
    assert.match(module.stderr, /HTTP 400/);
    assert.match(module.stderr, /bs content module 412690 3000001/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------------------------
// module
// ---------------------------------------------------------------------------------------------

test('content module --json lists the children (modules and topics) of one module', async () => {
  const { root } = seeded();
  try {
    const r = await content(
      root,
      [jsonStep(STRUCTURE)],
      ['module', String(OU), '3000001', '--json'],
    );
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.calls[0]?.url, `${LE}/modules/3000001/structure/`);
    const out = parseJson<ListOut<Record<string, unknown>>>(r.stdout);
    assert.equal(out.count, 2);
    assert.equal(out.items[0]?.kind, 'module');
    assert.equal(out.items[0]?.id, 3000002);
    assert.equal(out.items[0]?.parentId, 3000001);
    assert.equal(out.items[0]?.dueDate, '2026-09-05T03:59:00Z');
    assert.equal(out.items[1]?.kind, 'content');
    assert.equal(out.items[1]?.id, 4000003);
    assert.equal(out.items[1]?.moduleId, 3000001);
    assert.equal(out.items[1]?.activityType, 'Quiz');

    const plain = await content(
      root,
      [jsonStep(STRUCTURE)],
      ['module', String(OU), '3000001', '--plain'],
    );
    assert.equal(plain.code, 0, plain.stderr);
    const lines = plain.stdout.trimEnd().split('\n');
    assert.equal(lines.length, 3);
    assert.match(lines[0] ?? '', /^id\tcourseId\tkind\ttitle/);
    assert.match(lines[1] ?? '', /^3000002\t412690\tmodule\tLectures/);

    const wrapped = await content(
      root,
      [jsonStep(STRUCTURE)],
      ['module', String(OU), '3000001', '--json', '--wrap-untrusted'],
    );
    const w = parseJson<ListOut<Record<string, string>>>(wrapped.stdout);
    assert.ok(w.items[0]?.description?.startsWith(MARKER_START));
    assert.ok(w.items[1]?.title?.startsWith(MARKER_START));

    const human = await content(root, [jsonStep(STRUCTURE)], ['module', String(OU), '3000001']);
    assert.match(human.stdout, /^ID\s+KIND\s+TYPE\s+TITLE/, human.stdout);
    assert.match(human.stdout, /Welcome Quiz/);

    const empty = await content(
      root,
      [jsonStep([])],
      ['module', String(OU), '3000001', '--json', '--fail-empty'],
    );
    assert.equal(empty.code, EXIT_CODES.empty_results);
    assert.equal(parseJson<ListOut<unknown>>(empty.stdout).count, 0);

    const raw = await content(
      root,
      [jsonStep(STRUCTURE)],
      ['module', String(OU), '3000001', '--raw'],
    );
    assert.deepEqual(parseJson<ListOut<unknown>>(raw.stdout).items, STRUCTURE);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('content module: a non-array payload is an error with a --raw hint; 404 → exit 5; 403 → exit 6', async () => {
  const { root } = seeded();
  try {
    const shape = await content(
      root,
      [jsonStep({ Modules: [] })],
      ['module', String(OU), '3000001', '--json'],
    );
    assert.equal(shape.code, EXIT_CODES.error);
    assert.equal(shape.stdout, '');
    assert.match(shape.stderr, /--raw/);

    const missing = await content(
      root,
      [jsonStep({ title: 'Not Found', status: 404 }, 404)],
      ['module', String(OU), '999', '--json'],
    );
    assert.equal(missing.code, EXIT_CODES.not_found);
    assert.match(missing.stderr, /bs content toc 412690/);

    const forbidden = await content(
      root,
      [{ status: 403, body: 'Not authorized' }],
      ['module', String(OU), '3000001', '--json'],
    );
    assert.equal(forbidden.code, EXIT_CODES.permission_denied);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------------------------
// download
// ---------------------------------------------------------------------------------------------

test('content download streams the file into --out <dir> named from Content-Disposition', async () => {
  const { root } = seeded();
  const dir = mkdtempSync(path.join(os.tmpdir(), 'bs-content-dl-'));
  try {
    const r = await content(
      root,
      [fileStep({ 'content-disposition': 'attachment; filename="lecture01.pdf"' })],
      ['download', String(OU), '4000001', '--out', dir, '--json'],
    );
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.calls.length, 1, 'no topic lookup when the header names the file');
    assert.equal(r.calls[0]?.url, `${LE}/topics/4000001/file`);
    assert.equal(r.calls[0]?.headers.authorization, `Bearer ${FRESH_JWT}`);
    const target = path.join(dir, 'lecture01.pdf');
    assert.equal(readFileSync(target, 'utf8'), PDF_BYTES);
    assert.deepEqual(readdirSync(dir), ['lecture01.pdf'], 'no partial file left behind');
    const out = parseJson<DownloadOut>(r.stdout);
    assert.deepEqual(out, {
      topicId: 4000001,
      courseId: OU,
      fileName: 'lecture01.pdf',
      path: target,
      bytes: Buffer.byteLength(PDF_BYTES),
      contentType: 'application/pdf',
    });

    const human = await content(
      root,
      [fileStep({ 'content-disposition': "attachment; filename*=UTF-8''r%C3%A9sum%C3%A9.pdf" })],
      ['download', String(OU), '4000001', '--out', dir],
    );
    assert.equal(human.code, 0, human.stderr);
    assert.match(human.stdout, /résumé\.pdf/);
    assert.ok(existsSync(path.join(dir, 'résumé.pdf')));
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  }
});

test('content download without Content-Disposition looks the topic up for a name; --out <file> is exact', async () => {
  const { root } = seeded();
  const dir = mkdtempSync(path.join(os.tmpdir(), 'bs-content-dl-'));
  try {
    const r = await content(
      root,
      [fileStep(), jsonStep(TOPIC)],
      ['download', String(OU), '4000001', '--json'],
      dir,
    );
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(
      r.calls.map((c) => c.url),
      [`${LE}/topics/4000001/file`, `${LE}/topics/4000001`],
    );
    const out = parseJson<DownloadOut>(r.stdout);
    assert.equal(out.fileName, 'lecture01.pdf', 'basename of the file topic Url');
    assert.equal(out.path, path.join(dir, 'lecture01.pdf'));
    assert.equal(readFileSync(out.path, 'utf8'), PDF_BYTES);

    const titled = await content(
      root,
      [fileStep(), jsonStep({ ...TOPIC, Url: null, Title: 'Lecture 1: slides / notes' })],
      ['download', String(OU), '4000001', '--json'],
      dir,
    );
    assert.equal(titled.code, 0, titled.stderr);
    assert.equal(parseJson<DownloadOut>(titled.stdout).fileName, 'Lecture 1 slides  notes');

    const nameless = await content(
      root,
      [fileStep(), { status: 500, body: 'boom' }, { status: 500, body: 'boom' }],
      ['download', String(OU), '4000001', '--json'],
      dir,
    );
    assert.equal(nameless.code, 0, nameless.stderr);
    assert.equal(parseJson<DownloadOut>(nameless.stdout).fileName, 'topic-4000001');
    assert.match(nameless.stderr, /warning:/);

    const exact = path.join(dir, 'renamed.pdf');
    const file = await content(
      root,
      [fileStep({ 'content-disposition': 'attachment; filename="ignored.pdf"' })],
      ['download', String(OU), '4000001', '--out', exact, '--json'],
    );
    assert.equal(file.code, 0, file.stderr);
    assert.equal(parseJson<DownloadOut>(file.stdout).path, exact);
    assert.equal(readFileSync(exact, 'utf8'), PDF_BYTES);
    assert.ok(!existsSync(path.join(dir, 'ignored.pdf')));
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  }
});

test('content download --out - / --stdout writes the bytes to stdout and nothing else', async () => {
  const { root } = seeded();
  try {
    for (const flags of [['--out', '-'], ['--stdout'], ['--stdout', '--json']]) {
      const r = await content(
        root,
        [fileStep({ 'content-disposition': 'attachment; filename="lecture01.pdf"' })],
        ['download', String(OU), '4000001', ...flags],
      );
      assert.equal(r.code, 0, r.stderr);
      assert.equal(r.stdout, PDF_BYTES, flags.join(' '));
      assert.equal(r.calls.length, 1);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('content download of a non-file topic is exit 2 naming the topic type and url', async () => {
  const { root } = seeded();
  const dir = mkdtempSync(path.join(os.tmpdir(), 'bs-content-dl-'));
  try {
    const r = await content(
      root,
      [jsonStep(NOT_A_FILE, 400), jsonStep(LINK)],
      ['download', String(OU), '4000002', '--out', dir, '--json'],
    );
    assert.equal(r.code, EXIT_CODES.usage);
    assert.equal(r.stdout, '');
    assert.deepEqual(readdirSync(dir), []);
    assert.equal(r.calls.length, 2);
    assert.match(r.stderr, /not a file/i);
    assert.match(r.stderr, /Link/);
    assert.ok(r.stderr.includes('https://mediaspace.example.edu/media/lecture01'), r.stderr);

    const noLookup = await content(
      root,
      [jsonStep(NOT_A_FILE, 400), { status: 500, body: 'boom' }, { status: 500, body: 'boom' }],
      ['download', String(OU), '4000002', '--out', dir, '--json'],
    );
    assert.equal(noLookup.code, EXIT_CODES.usage);
    assert.match(noLookup.stderr, /not a file/i);
    assert.match(noLookup.stderr, /bs content get 412690 4000002/);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  }
});

test('content download: 404 → exit 5, 403 → exit 6, a missing --out parent is an error, no partial files', async () => {
  const { root } = seeded();
  const dir = mkdtempSync(path.join(os.tmpdir(), 'bs-content-dl-'));
  try {
    const missing = await content(
      root,
      [jsonStep({ title: 'Not Found', status: 404 }, 404)],
      ['download', String(OU), '999', '--out', dir, '--json'],
    );
    assert.equal(missing.code, EXIT_CODES.not_found);
    assert.match(missing.stderr, /bs content toc 412690/);

    const forbidden = await content(
      root,
      [{ status: 403, body: 'Not authorized' }],
      ['download', String(OU), '4000001', '--out', dir, '--json'],
    );
    assert.equal(forbidden.code, EXIT_CODES.permission_denied);
    assert.match(forbidden.stderr, /past-term/);

    const nowhere = await content(
      root,
      [fileStep({ 'content-disposition': 'attachment; filename="lecture01.pdf"' })],
      ['download', String(OU), '4000001', '--out', path.join(dir, 'missing', 'x.pdf'), '--json'],
    );
    assert.equal(nowhere.code, EXIT_CODES.error);
    assert.equal(nowhere.stdout, '');
    assert.match(nowhere.stderr, /missing/);
    assert.deepEqual(readdirSync(dir), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  }
});

test('content download whose first call answers 401 re-mints once and streams on the retry', async () => {
  const { root } = seeded();
  const dir = mkdtempSync(path.join(os.tmpdir(), 'bs-content-dl-'));
  try {
    const r = await content(
      root,
      [
        bogusBearerStep,
        mintOkStep(NEW_JWT),
        fileStep({ 'content-disposition': 'attachment; filename="lecture01.pdf"' }),
      ],
      ['download', String(OU), '4000001', '--out', dir, '--json'],
    );
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(
      r.calls.map((c) => c.method),
      ['GET', 'POST', 'GET'],
    );
    assert.equal(r.calls[2]?.headers.authorization, `Bearer ${NEW_JWT}`);
    assert.equal(readFileSync(path.join(dir, 'lecture01.pdf'), 'utf8'), PDF_BYTES);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------------------------
// argument validation, help
// ---------------------------------------------------------------------------------------------

test('content toc/get/module/download reject bad ids before any request', async () => {
  const { root } = seeded();
  try {
    for (const bad of ['abc', '0', '-3', '1.5']) {
      const toc = await content(root, [jsonStep(TOC)], ['toc', bad, '--json']);
      assert.equal(toc.code, EXIT_CODES.usage, `toc ${bad}`);
      assert.equal(toc.calls.length, 0);
      const get = await content(root, [jsonStep(TOPIC)], ['get', String(OU), bad, '--json']);
      assert.equal(get.code, EXIT_CODES.usage, `get ${bad}`);
      assert.equal(get.calls.length, 0);
      const mod = await content(root, [jsonStep(STRUCTURE)], ['module', bad, '1', '--json']);
      assert.equal(mod.code, EXIT_CODES.usage, `module ${bad}`);
      assert.equal(mod.calls.length, 0);
      const dl = await content(root, [fileStep()], ['download', String(OU), bad, '--json']);
      assert.equal(dl.code, EXIT_CODES.usage, `download ${bad}`);
      assert.equal(dl.calls.length, 0);
    }
    for (const argv of [['toc'], ['get', String(OU)], ['module', String(OU)], ['download']]) {
      const r = await content(root, [jsonStep(TOC)], [...argv, '--json']);
      assert.equal(r.code, EXIT_CODES.usage, argv.join(' '));
      assert.equal(r.calls.length, 0);
    }
    const both = await content(
      root,
      [fileStep()],
      ['download', String(OU), '4000001', '--out', 'x.pdf', '--stdout'],
    );
    assert.equal(both.code, EXIT_CODES.usage);
    assert.equal(both.calls.length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('content --help and schema create no state directory', async () => {
  const { root } = tempRoot('bs-content-');
  const state = `${root}/state`;
  try {
    for (const argv of [
      ['content', '--help'],
      ['content', 'download', '--help'],
      ['schema', 'content', 'toc'],
    ]) {
      const r = await runCli(['--root', state, ...argv]);
      assert.equal(r.code, 0, argv.join(' '));
      assert.throws(() => readFileSync(state), argv.join(' '));
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
