import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { HINT_LOGIN } from '../../src/auth/ladder.js';
import { writeSession } from '../../src/auth/session.js';
import { EXIT_CODES } from '../../src/core/errors.js';
import { MARKER_END, MARKER_START } from '../../src/core/output.js';
import { bogusBearerStep, fakeJwt, fakeSession, mintOkStep, tempRoot } from '../helpers/auth.js';
import { parseJson, runCli } from '../helpers/cli.js';
import { fakeTransport, jsonStep, type Step, streamOf } from '../helpers/http.js';

interface RawItem {
  Id: number;
  Title: string;
  IsPublished: boolean;
  Body: { Text: string; Html: string | null };
  Attachments: { FileId: number; FileName: string; Size: number }[];
}
interface Attachment {
  fileId: number;
  fileName: string;
  size: number | null;
}
interface Announcement {
  id: number;
  courseId: number;
  title: string;
  bodyText: string | null;
  bodyHtml: string | null;
  date: string | null;
  pinned: boolean;
  attachments: Attachment[];
  url: string;
}
interface ListOut<T = Announcement> {
  items: T[];
  count: number;
  fetchedAt: string;
}
interface DownloadRow {
  fileId: number;
  fileName: string;
  path: string;
  bytes: number;
}

const FIXTURES = new URL('../fixtures/', import.meta.url);
function fixture(name: string): RawItem[] {
  return JSON.parse(readFileSync(new URL(name, FIXTURES), 'utf8'));
}
const CIVICS = fixture('news-412690.json');
const HONORS = fixture('news-440703.json');
const MIXED = fixture('news-with-mixed-dates.json');
const NOT_FOUND_BODY = { title: 'Not Found', status: 404, detail: 'Org unit does not exist' };

const BASE = 'https://purdue.brightspace.com';
const NEWS_PATH = (ou: number) => `/d2l/api/le/1.96/${ou}/news/`;
const ISO_MS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const ISO_S = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
const PINNED = CIVICS.find((i) => i.Id === 1386315) as RawItem;

const FAR_FUTURE = '2999-01-01T00:00:00Z';
const FRESH_JWT = fakeJwt({ exp: Date.parse(FAR_FUTURE) / 1000, sub: 'first' });
const NEW_JWT = fakeJwt({ exp: Date.parse(FAR_FUTURE) / 1000, sub: 'second' });

function seeded() {
  const t = tempRoot('bs-news-');
  writeSession(t.paths, fakeSession({ jwt: FRESH_JWT, jwtExpiresAt: FAR_FUTURE }));
  return t;
}

async function news(root: string, steps: Step[], args: string[]) {
  const ft = fakeTransport(steps);
  const r = await runCli(['--root', root, 'announcements', ...args], { transport: ft.transport });
  return { ...r, calls: ft.calls };
}

function queryOf(url: string | undefined): URLSearchParams {
  return new URL(url ?? 'http://invalid').searchParams;
}

/** A fresh binary-looking body per request so a step can be replayed after a re-mint. */
function fileStep(text: string, extra: Record<string, string> = {}): Step {
  return async () => ({
    status: 200,
    headers: { 'content-type': 'application/pdf', ...extra },
    body: streamOf(text),
  });
}

function outDir(): string {
  return mkdtempSync(path.join(os.tmpdir(), 'bs-news-out-'));
}

// ---------------------------------------------------------------------------------------------
// list
// ---------------------------------------------------------------------------------------------

test('announcements list --json: one GET on the news collection, curated rows newest-first', async () => {
  const { root } = seeded();
  try {
    const r = await news(root, [jsonStep(CIVICS)], ['list', '412690', '--json']);
    assert.equal(r.code, 0, r.stderr);
    const out = parseJson<ListOut>(r.stdout);
    assert.equal(out.count, 4);
    assert.match(out.fetchedAt, ISO_S);
    assert.deepEqual(
      out.items.map((a) => a.id),
      [1654367, 1654190, 1386315, 504396],
    );
    assert.deepEqual(out.items[2], {
      id: 1386315,
      courseId: 412690,
      title: 'Brightspace Notifications',
      bodyText: PINNED.Body.Text,
      bodyHtml: PINNED.Body.Html,
      date: '2024-07-29T21:00:00Z',
      pinned: true,
      attachments: [
        {
          fileId: 39381028,
          fileName: 'How to Modify Brightspace Course Notifications.pdf',
          size: 229139,
        },
      ],
      url: `${BASE}/d2l/lms/news/main.d2l?ou=412690`,
    });
    assert.ok(out.items[2]?.bodyText?.startsWith('To modify any Brightspace'));
    assert.equal(out.items[3]?.date, '2020-09-09T17:48:00Z');
    assert.equal(out.items[3]?.pinned, false);

    assert.equal(r.calls.length, 1);
    assert.equal(r.calls[0]?.method, 'GET');
    assert.equal(r.calls[0]?.url, `${BASE}${NEWS_PATH(412690)}`, 'no since by default');
    assert.equal(r.calls[0]?.headers.authorization, `Bearer ${FRESH_JWT}`);
    assert.equal(r.stderr, '');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('announcements list honours BS_LE_VERSION', async () => {
  const { root } = seeded();
  try {
    const ft = fakeTransport([jsonStep(CIVICS)]);
    const r = await runCli(['--root', root, 'announcements', 'list', '412690', '--json'], {
      transport: ft.transport,
      env: { BS_LE_VERSION: '1.80' },
    });
    assert.equal(r.code, 0, r.stderr);
    assert.equal(ft.calls[0]?.url, `${BASE}/d2l/api/le/1.80/412690/news/`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('announcements list: default limit 20, --limit caps after sorting, bad limits are usage errors', async () => {
  const { root } = seeded();
  try {
    const many = Array.from({ length: 25 }, (_, i) => ({
      ...PINNED,
      Id: 1000 + i,
      StartDate: `2026-01-${String(i + 1).padStart(2, '0')}T00:00:00Z`,
    }));
    const dflt = await news(root, [jsonStep(many)], ['list', '412690', '--json']);
    assert.equal(dflt.code, 0, dflt.stderr);
    const out = parseJson<ListOut>(dflt.stdout);
    assert.equal(out.count, 20);
    assert.equal(out.items[0]?.id, 1024, 'newest kept');
    assert.equal(out.items[19]?.id, 1005);

    const three = await news(
      root,
      [jsonStep(HONORS)],
      ['list', '440703', '--json', '--limit', '3'],
    );
    assert.equal(three.code, 0, three.stderr);
    assert.deepEqual(
      parseJson<ListOut>(three.stdout).items.map((a) => a.id),
      [1975874, 1967175, 1919993],
    );

    for (const bad of ['0', '-1', 'ten']) {
      const b = await news(root, [jsonStep(HONORS)], ['list', '440703', '--json', '--limit', bad]);
      assert.equal(b.code, EXIT_CODES.usage, bad);
      assert.equal(b.calls.length, 0);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('announcements list --since shapes the query: timestamp, date, relative duration; junk is usage', async () => {
  const { root } = seeded();
  try {
    const ts = await news(
      root,
      [jsonStep(HONORS)],
      ['list', '440703', '--json', '--since', '2026-03-11T14:22:31Z'],
    );
    assert.equal(ts.code, 0, ts.stderr);
    assert.equal(new URL(ts.calls[0]?.url ?? '').pathname, NEWS_PATH(440703));
    assert.equal(queryOf(ts.calls[0]?.url).get('since'), '2026-03-11T14:22:31.000Z');

    const day = await news(
      root,
      [jsonStep(HONORS)],
      ['list', '440703', '--json', '--since', '2026-04-01'],
    );
    assert.equal(day.code, 0, day.stderr);
    assert.equal(queryOf(day.calls[0]?.url).get('since'), '2026-04-01T00:00:00.000Z');

    const rel = await news(root, [jsonStep(HONORS)], ['list', '440703', '--json', '--since', '7d']);
    assert.equal(rel.code, 0, rel.stderr);
    const since = queryOf(rel.calls[0]?.url).get('since') ?? '';
    assert.match(since, ISO_MS);
    const expected = Date.now() - 7 * 24 * 3600 * 1000;
    assert.ok(Math.abs(Date.parse(since) - expected) < 60_000, since);

    const junk = await news(
      root,
      [jsonStep(HONORS)],
      ['list', '440703', '--json', '--since', 'last week'],
    );
    assert.equal(junk.code, EXIT_CODES.usage);
    assert.equal(junk.calls.length, 0);
    assert.match(junk.stderr, /--since/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('announcements list: unpublished drafts excluded, StartDate ?? CreatedDate, undated last', async () => {
  const { root } = seeded();
  try {
    const r = await news(root, [jsonStep(MIXED)], ['list', '77', '--json']);
    assert.equal(r.code, 0, r.stderr);
    const out = parseJson<ListOut>(r.stdout);
    assert.deepEqual(
      out.items.map((a) => [a.id, a.date]),
      [
        [800003, '2026-06-30T23:59:00Z'],
        [800006, '2026-05-01T10:00:00Z'],
        [800002, '2026-03-11T14:22:31Z'],
        [800001, '2026-01-04T08:00:00Z'],
        [800004, null],
      ],
    );
    assert.ok(out.items.every((a) => a.courseId === 77));
    assert.equal(r.stderr, '', 'a draft is not an undecodable item');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('announcements list --plain: fixed columns, one line per item, body escaped onto one line', async () => {
  const { root } = seeded();
  try {
    const r = await news(root, [jsonStep(CIVICS)], ['list', '412690', '--plain', '--limit', '3']);
    assert.equal(r.code, 0, r.stderr);
    const lines = r.stdout.trimEnd().split('\n');
    assert.equal(lines[0], 'id\tcourseId\ttitle\tdate\tpinned\tattachments\tbodyText\turl');
    assert.equal(lines.length, 4);
    const pinned = lines[3]?.split('\t') ?? [];
    assert.equal(pinned[0], '1386315');
    assert.equal(pinned[1], '412690');
    assert.equal(pinned[2], 'Brightspace Notifications');
    assert.equal(pinned[3], '2024-07-29T21:00:00Z');
    assert.equal(pinned[4], 'true');
    assert.equal(
      pinned[5],
      '[{"fileId":39381028,"fileName":"How to Modify Brightspace Course Notifications.pdf","size":229139}]',
    );
    assert.ok(pinned[6]?.startsWith('To modify any Brightspace'));
    assert.equal(pinned[7], `${BASE}/d2l/lms/news/main.d2l?ou=412690`);

    const multiline = [{ ...PINNED, Body: { Text: 'line one\nline two\ttabbed', Html: null } }];
    const esc = await news(root, [jsonStep(multiline)], ['list', '412690', '--plain']);
    assert.equal(esc.code, 0, esc.stderr);
    assert.equal(esc.stdout.trimEnd().split('\n').length, 2);
    assert.ok(esc.stdout.includes('line one\\nline two\\ttabbed'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('announcements list human mode renders a table with a header', async () => {
  const { root } = seeded();
  try {
    const r = await news(root, [jsonStep(CIVICS)], ['list', '412690']);
    assert.equal(r.code, 0, r.stderr);
    const lines = r.stdout.trimEnd().split('\n');
    assert.equal(lines.length, 5);
    assert.match(lines[0] ?? '', /^ID\s+DATE\s+PINNED\s+FILES\s+TITLE/);
    assert.ok(lines[3]?.includes('Brightspace Notifications'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('announcements list --select and --results-only come from the output seam', async () => {
  const { root } = seeded();
  try {
    const r = await news(
      root,
      [jsonStep(CIVICS)],
      [
        'list',
        '412690',
        '--json',
        '--results-only',
        '--select',
        'id,attachments.0.fileId',
        '--limit',
        '3',
      ],
    );
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(parseJson(r.stdout), [
      { id: 1654367 },
      { id: 1654190 },
      { id: 1386315, 'attachments.0.fileId': 39381028 },
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('announcements list with nothing posted: exit 0, empty envelope; --fail-empty → exit 3 silently', async () => {
  const { root } = seeded();
  try {
    const ok = await news(root, [jsonStep([])], ['list', '412690', '--json']);
    assert.equal(ok.code, 0, ok.stderr);
    assert.deepEqual(parseJson<ListOut>(ok.stdout).items, []);

    const empty = await news(root, [jsonStep([])], ['list', '412690', '--json', '--fail-empty']);
    assert.equal(empty.code, EXIT_CODES.empty_results);
    assert.equal(parseJson<ListOut>(empty.stdout).count, 0, 'output still written');
    assert.equal(empty.stderr, '');

    const drafts = MIXED.filter((i) => i.IsPublished === false);
    const onlyDrafts = await news(
      root,
      [jsonStep(drafts)],
      ['list', '77', '--plain', '--fail-empty'],
    );
    assert.equal(onlyDrafts.code, EXIT_CODES.empty_results);
    assert.equal(onlyDrafts.stdout.trimEnd().split('\n').length, 1, 'header row only');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('announcements list --raw emits the NewsItems as sent (drafts included), --select ignored', async () => {
  const { root } = seeded();
  try {
    const r = await news(
      root,
      [jsonStep(MIXED)],
      ['list', '77', '--json', '--raw', '--select', 'id'],
    );
    assert.equal(r.code, 0, r.stderr);
    const out = parseJson<ListOut<RawItem>>(r.stdout);
    assert.equal(out.count, 6);
    assert.deepEqual(out.items, MIXED);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('announcements list skips an undecodable item with a warning; a non-array payload is an error', async () => {
  const { root } = seeded();
  try {
    const r = await news(
      root,
      [jsonStep([...CIVICS, { Title: 'mid-deletion' }])],
      ['list', '412690', '--json'],
    );
    assert.equal(r.code, 0, r.stderr);
    assert.equal(parseJson<ListOut>(r.stdout).count, 4);
    assert.match(r.stderr, /warning: .*1 .*undecodable/);

    const shape = await news(root, [jsonStep({ Objects: [] })], ['list', '412690', '--json']);
    assert.equal(shape.code, EXIT_CODES.error);
    assert.equal(shape.stdout, '');
    assert.match(shape.stderr, /news\/.*array/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('announcements list: 404 → exit 5; 403 → exit 6 with the neutral denied hint', async () => {
  const { root } = seeded();
  try {
    const missing = await news(root, [jsonStep(NOT_FOUND_BODY, 404)], ['list', '999', '--json']);
    assert.equal(missing.code, EXIT_CODES.not_found);
    assert.equal(missing.stdout, '');
    assert.match(missing.stderr, /bs: .*999\/news\/.*404/);

    const denied = await news(root, [{ status: 403, body: 'Not authorized' }], ['list', '1092755']);
    assert.equal(denied.code, EXIT_CODES.permission_denied);
    assert.equal(denied.stdout, '');
    assert.match(denied.stderr, /denied this route/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('announcements list with no session: exit 4, login hint, no data request', async () => {
  const { root } = tempRoot('bs-news-');
  try {
    const r = await news(root, [jsonStep(CIVICS)], ['list', '412690', '--json']);
    assert.equal(r.code, EXIT_CODES.auth_required);
    assert.equal(r.stdout, '');
    assert.ok(r.stderr.includes(HINT_LOGIN), r.stderr);
    assert.equal(r.calls.length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('announcements list answering 401 re-mints once and retries with the new token', async () => {
  const { root } = seeded();
  try {
    const r = await news(
      root,
      [bogusBearerStep, mintOkStep(NEW_JWT), jsonStep(CIVICS)],
      ['list', '412690', '--json'],
    );
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(
      r.calls.map((c) => c.method),
      ['GET', 'POST', 'GET'],
    );
    assert.equal(r.calls[2]?.headers.authorization, `Bearer ${NEW_JWT}`);
    assert.equal(parseJson<ListOut>(r.stdout).count, 4);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('announcements list rejects a bad org unit id before any request', async () => {
  const { root } = seeded();
  try {
    for (const bad of ['abc', '0', '-3', '1.5']) {
      const r = await news(root, [jsonStep(CIVICS)], ['list', bad, '--json']);
      assert.equal(r.code, EXIT_CODES.usage, bad);
      assert.equal(r.calls.length, 0);
    }
    const none = await news(root, [jsonStep(CIVICS)], ['list', '--json']);
    assert.equal(none.code, EXIT_CODES.usage);
    assert.equal(none.calls.length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------------------------
// get
// ---------------------------------------------------------------------------------------------

test('announcements get: the list filtered to one id, emitted bare; the list is fetched without since', async () => {
  const { root } = seeded();
  try {
    const r = await news(root, [jsonStep(CIVICS)], ['get', '412690', '1386315', '--json']);
    assert.equal(r.code, 0, r.stderr);
    const out = parseJson<Announcement>(r.stdout);
    assert.equal(out.id, 1386315);
    assert.equal(out.courseId, 412690);
    assert.equal(out.title, 'Brightspace Notifications');
    assert.equal(out.pinned, true);
    assert.equal(out.date, '2024-07-29T21:00:00Z');
    assert.equal(out.attachments[0]?.fileId, 39381028);
    assert.equal(out.url, `${BASE}/d2l/lms/news/main.d2l?ou=412690`);
    assert.ok(out.bodyHtml?.includes('&#160;'), 'bodyHtml kept verbatim');
    assert.equal(r.calls.length, 1);
    assert.equal(r.calls[0]?.url, `${BASE}${NEWS_PATH(412690)}`);
    assert.equal(r.stderr, '');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('announcements get: unknown id → exit 5 with a hint; draft ids are not announcements', async () => {
  const { root } = seeded();
  try {
    const missing = await news(root, [jsonStep(CIVICS)], ['get', '412690', '999', '--json']);
    assert.equal(missing.code, EXIT_CODES.not_found);
    assert.equal(missing.stdout, '');
    assert.match(missing.stderr, /bs: .*999/);
    assert.match(missing.stderr, /announcements list 412690/);

    const draft = await news(root, [jsonStep(MIXED)], ['get', '77', '800005', '--json']);
    assert.equal(draft.code, EXIT_CODES.not_found);

    const ou404 = await news(root, [jsonStep(NOT_FOUND_BODY, 404)], ['get', '999', '1', '--json']);
    assert.equal(ou404.code, EXIT_CODES.not_found);
    assert.match(ou404.stderr, /404/);

    const denied = await news(
      root,
      [{ status: 403, body: 'Not authorized' }],
      ['get', '1092755', '1'],
    );
    assert.equal(denied.code, EXIT_CODES.permission_denied);
    assert.match(denied.stderr, /denied this route/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('announcements get --wrap-untrusted wraps title, bodyText, bodyHtml; never id, date, url, fileName', async () => {
  const { root } = seeded();
  try {
    const r = await news(
      root,
      [jsonStep(CIVICS)],
      ['get', '412690', '1386315', '--json', '--wrap-untrusted'],
    );
    assert.equal(r.code, 0, r.stderr);
    const out = parseJson<Record<string, unknown>>(r.stdout);
    const marker = new RegExp(
      `^${MARKER_START} id="([0-9a-f]{16})">>>\\nSource: brightspace\\n---\\n[\\s\\S]*\\n${MARKER_END} id="\\1">>>$`,
    );
    assert.match(String(out.title), marker);
    assert.match(String(out.bodyText), marker);
    assert.match(String(out.bodyHtml), marker);
    assert.ok(String(out.bodyText).includes('please follow the attached instructions'));
    assert.equal(out.id, 1386315);
    assert.equal(out.date, '2024-07-29T21:00:00Z');
    assert.equal(out.url, `${BASE}/d2l/lms/news/main.d2l?ou=412690`);
    const [file] = out.attachments as Attachment[];
    assert.equal(file?.fileName, 'How to Modify Brightspace Course Notifications.pdf');
    assert.equal(file?.fileId, 39381028);
    assert.deepEqual(out.externalContent, {
      untrusted: true,
      source: 'brightspace',
      wrapped: true,
    });

    const list = await news(
      root,
      [jsonStep(CIVICS)],
      ['list', '412690', '--json', '--wrap-untrusted'],
    );
    assert.equal(list.code, 0, list.stderr);
    const first = parseJson<ListOut<Record<string, unknown>>>(list.stdout).items[0];
    assert.match(String(first?.title), marker);
    assert.equal(first?.id, 1654367);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('announcements get --plain and human modes; --raw returns the NewsItem as sent', async () => {
  const { root } = seeded();
  try {
    const plain = await news(root, [jsonStep(CIVICS)], ['get', '412690', '1386315', '--plain']);
    assert.equal(plain.code, 0, plain.stderr);
    const lines = plain.stdout.trimEnd().split('\n');
    assert.equal(lines[0], 'key\tvalue');
    const map = new Map(lines.slice(1).map((l) => l.split('\t') as [string, string]));
    assert.equal(map.get('id'), '1386315');
    assert.equal(map.get('pinned'), 'true');
    assert.equal(
      map.get('attachments'),
      '[{"fileId":39381028,"fileName":"How to Modify Brightspace Course Notifications.pdf","size":229139}]',
    );

    const human = await news(root, [jsonStep(CIVICS)], ['get', '412690', '1386315']);
    assert.equal(human.code, 0, human.stderr);
    assert.ok(human.stdout.includes('Brightspace Notifications'));
    assert.ok(human.stdout.includes('39381028'));
    assert.ok(human.stdout.includes('please follow the attached instructions'));

    const raw = await news(
      root,
      [jsonStep(CIVICS)],
      ['get', '412690', '1386315', '--json', '--raw'],
    );
    assert.equal(raw.code, 0, raw.stderr);
    assert.deepEqual(parseJson(raw.stdout), PINNED);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('announcements get rejects bad ids before any request', async () => {
  const { root } = seeded();
  try {
    for (const args of [
      ['get', 'abc', '1'],
      ['get', '412690', '0'],
      ['get', '412690', 'x'],
      ['get', '412690'],
    ]) {
      const r = await news(root, [jsonStep(CIVICS)], [...args, '--json']);
      assert.equal(r.code, EXIT_CODES.usage, args.join(' '));
      assert.equal(r.calls.length, 0);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------------------------
// download
// ---------------------------------------------------------------------------------------------

test('announcements download: streams every attachment into --out with its D2L file name', async () => {
  const { root } = seeded();
  const out = outDir();
  try {
    const r = await news(
      root,
      [jsonStep(CIVICS), fileStep('%PDF-1.7 fake bytes')],
      ['download', '412690', '1386315', '--out', out, '--json'],
    );
    assert.equal(r.code, 0, r.stderr);
    const env = parseJson<ListOut<DownloadRow>>(r.stdout);
    assert.equal(env.count, 1);
    const expectedPath = path.join(out, 'How to Modify Brightspace Course Notifications.pdf');
    assert.deepEqual(env.items[0], {
      fileId: 39381028,
      fileName: 'How to Modify Brightspace Course Notifications.pdf',
      path: expectedPath,
      bytes: 19,
    });
    assert.equal(readFileSync(expectedPath, 'utf8'), '%PDF-1.7 fake bytes');
    assert.deepEqual(readdirSync(out), ['How to Modify Brightspace Course Notifications.pdf']);

    assert.deepEqual(
      r.calls.map((c) => c.url),
      [
        `${BASE}${NEWS_PATH(412690)}`,
        `${BASE}/d2l/api/le/1.96/412690/news/1386315/attachments/39381028`,
      ],
    );
    assert.equal(r.calls[1]?.method, 'GET');
    assert.equal(r.calls[1]?.headers.authorization, `Bearer ${FRESH_JWT}`);
    assert.equal(r.stderr, '');
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(out, { recursive: true, force: true });
  }
});

test('announcements download: two attachments, both fetched in order; --plain and human renderings', async () => {
  const { root } = seeded();
  const out = outDir();
  try {
    const r = await news(
      root,
      [jsonStep(HONORS), fileStep('first'), fileStep('second!')],
      ['download', '440703', '1907220', '--out', out, '--plain'],
    );
    assert.equal(r.code, 0, r.stderr);
    const lines = r.stdout.trimEnd().split('\n');
    assert.equal(lines[0], 'fileId\tfileName\tpath\tbytes');
    assert.equal(lines.length, 3);
    assert.equal(
      lines[1],
      `57595852\tPURC26Key by Division - JMHC.pdf\t${path.join(out, 'PURC26Key by Division - JMHC.pdf')}\t5`,
    );
    assert.equal(
      lines[2],
      `57595853\tSpring_26AbstractBook.pdf\t${path.join(out, 'Spring_26AbstractBook.pdf')}\t7`,
    );
    assert.equal(readFileSync(path.join(out, 'Spring_26AbstractBook.pdf'), 'utf8'), 'second!');
    assert.equal(r.calls.length, 3);
    assert.ok(r.calls[1]?.url.endsWith('/news/1907220/attachments/57595852'));
    assert.ok(r.calls[2]?.url.endsWith('/news/1907220/attachments/57595853'));

    const human = await news(
      root,
      [jsonStep(HONORS), fileStep('first'), fileStep('second!')],
      ['download', '440703', '1907220', '--out', out, '--force'],
    );
    assert.equal(human.code, 0, human.stderr, 'the same names again: --force replaces them');
    assert.ok(human.stdout.includes('Spring_26AbstractBook.pdf'));
    assert.ok(human.stdout.includes('7 bytes'), human.stdout);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(out, { recursive: true, force: true });
  }
});

test('announcements download <fileId>: only that attachment; an unknown fileId is exit 5 with no stream request', async () => {
  const { root } = seeded();
  const out = outDir();
  try {
    const one = await news(
      root,
      [jsonStep(HONORS), fileStep('only this one')],
      ['download', '440703', '1907220', '57595853', '--out', out, '--json'],
    );
    assert.equal(one.code, 0, one.stderr);
    const env = parseJson<ListOut<DownloadRow>>(one.stdout);
    assert.equal(env.count, 1);
    assert.equal(env.items[0]?.fileId, 57595853);
    assert.deepEqual(readdirSync(out), ['Spring_26AbstractBook.pdf']);
    assert.equal(one.calls.length, 2);

    const wrong = await news(
      root,
      [jsonStep(HONORS), fileStep('never')],
      ['download', '440703', '1907220', '424242', '--out', out, '--json'],
    );
    assert.equal(wrong.code, EXIT_CODES.not_found);
    assert.equal(wrong.stdout, '');
    assert.match(wrong.stderr, /424242/);
    assert.match(wrong.stderr, /announcements get 440703 1907220/);
    assert.equal(wrong.calls.length, 1, 'no attachment request for an id the item does not carry');
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(out, { recursive: true, force: true });
  }
});

test('announcements download: unknown newsId → exit 5; no attachments → empty envelope + warning, exit 3 under --fail-empty', async () => {
  const { root } = seeded();
  const out = outDir();
  try {
    const missing = await news(
      root,
      [jsonStep(CIVICS), fileStep('never')],
      ['download', '412690', '999', '--out', out, '--json'],
    );
    assert.equal(missing.code, EXIT_CODES.not_found);
    assert.equal(missing.calls.length, 1);
    assert.deepEqual(readdirSync(out), []);

    const none = await news(
      root,
      [jsonStep(CIVICS), fileStep('never')],
      ['download', '412690', '1654367', '--out', out, '--json'],
    );
    assert.equal(none.code, 0, none.stderr);
    assert.equal(parseJson<ListOut>(none.stdout).count, 0);
    assert.match(none.stderr, /warning: .*1654367.*no attachments/);
    assert.equal(none.calls.length, 1);

    const failEmpty = await news(
      root,
      [jsonStep(CIVICS), fileStep('never')],
      ['download', '412690', '1654367', '--out', out, '--json', '--fail-empty'],
    );
    assert.equal(failEmpty.code, EXIT_CODES.empty_results);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(out, { recursive: true, force: true });
  }
});

test('announcements download never overwrites without --force (exit 2); --force replaces the file', async () => {
  const { root } = seeded();
  const out = outDir();
  const target = path.join(out, 'How to Modify Brightspace Course Notifications.pdf');
  try {
    const first = await news(
      root,
      [jsonStep(CIVICS), fileStep('first bytes')],
      ['download', '412690', '1386315', '--out', out, '--json'],
    );
    assert.equal(first.code, 0, first.stderr);
    assert.equal(readFileSync(target, 'utf8'), 'first bytes');

    const refused = await news(
      root,
      [jsonStep(CIVICS), fileStep('second bytes')],
      ['download', '412690', '1386315', '--out', out, '--json'],
    );
    assert.equal(refused.code, EXIT_CODES.usage);
    assert.equal(refused.stdout, '');
    assert.match(refused.stderr, /refusing to overwrite/);
    assert.match(refused.stderr, /--force/);
    assert.equal(readFileSync(target, 'utf8'), 'first bytes', 'the existing file is untouched');
    assert.deepEqual(readdirSync(out), [path.basename(target)], 'no .part left behind');

    const forced = await news(
      root,
      [jsonStep(CIVICS), fileStep('second bytes')],
      ['download', '412690', '1386315', '--out', out, '--json', '--force'],
    );
    assert.equal(forced.code, 0, forced.stderr);
    assert.equal(readFileSync(target, 'utf8'), 'second bytes');
    assert.equal(parseJson<ListOut<DownloadRow>>(forced.stdout).items[0]?.bytes, 12);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(out, { recursive: true, force: true });
  }
});

test('announcements download: a failing stream maps like any route (404 → 5, 403 → 6) and leaves no partial file', async () => {
  const { root } = seeded();
  const out = outDir();
  try {
    const gone = await news(
      root,
      [jsonStep(CIVICS), jsonStep(NOT_FOUND_BODY, 404)],
      ['download', '412690', '1386315', '--out', out, '--json'],
    );
    assert.equal(gone.code, EXIT_CODES.not_found);
    assert.equal(gone.stdout, '');
    assert.match(gone.stderr, /attachments\/39381028.*404/);
    assert.deepEqual(readdirSync(out), []);

    const denied = await news(
      root,
      [jsonStep(CIVICS), { status: 403, body: 'Not authorized' }],
      ['download', '412690', '1386315', '--out', out, '--json'],
    );
    assert.equal(denied.code, EXIT_CODES.permission_denied);
    assert.match(denied.stderr, /denied this route/);

    const broken: Step = async () => ({
      status: 200,
      headers: { 'content-type': 'application/pdf' },
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('partial'));
          controller.error(new Error('socket hang up'));
        },
      }),
    });
    const cut = await news(
      root,
      [jsonStep(CIVICS), broken],
      ['download', '412690', '1386315', '--out', out, '--json'],
    );
    assert.equal(cut.code, EXIT_CODES.retryable);
    assert.match(cut.stderr, /socket hang up/);
    assert.deepEqual(readdirSync(out), [], 'no .part left behind');
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(out, { recursive: true, force: true });
  }
});

test('announcements download: file names are made safe, deduplicated, and --out is created', async () => {
  const { root } = seeded();
  const out = outDir();
  const nested = path.join(out, 'deep', 'er');
  try {
    const item = {
      ...PINNED,
      Attachments: [
        { FileId: 1, FileName: '../../escape.txt', Size: 1 },
        { FileId: 2, FileName: 'twin.txt', Size: 1 },
        { FileId: 3, FileName: 'twin.txt', Size: 1 },
        { FileId: 4, FileName: '', Size: 1 },
      ],
    };
    const r = await news(
      root,
      [jsonStep([item]), fileStep('a'), fileStep('bb'), fileStep('ccc'), fileStep('dddd')],
      ['download', '412690', '1386315', '--out', nested, '--json'],
    );
    assert.equal(r.code, 0, r.stderr);
    const env = parseJson<ListOut<DownloadRow>>(r.stdout);
    assert.deepEqual(
      env.items.map((row) => [row.fileId, path.basename(row.path), row.bytes]),
      [
        [1, 'escape.txt', 1],
        [2, 'twin.txt', 2],
        [3, 'twin-3.txt', 3],
        [4, 'attachment-4', 4],
      ],
    );
    assert.ok(env.items.every((row) => path.dirname(row.path) === nested));
    assert.equal(
      env.items[0]?.fileName,
      '../../escape.txt',
      'the D2L name is data, the path is ours',
    );
    assert.deepEqual(readdirSync(nested).sort(), [
      'attachment-4',
      'escape.txt',
      'twin-3.txt',
      'twin.txt',
    ]);
    assert.equal(existsSync(path.join(out, 'escape.txt')), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(out, { recursive: true, force: true });
  }
});

test('announcements download whose list answers 401 re-mints once and streams with the new token', async () => {
  const { root } = seeded();
  const out = outDir();
  try {
    const r = await news(
      root,
      [bogusBearerStep, mintOkStep(NEW_JWT), jsonStep(CIVICS), fileStep('bytes')],
      ['download', '412690', '1386315', '--out', out, '--json'],
    );
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(
      r.calls.map((c) => c.method),
      ['GET', 'POST', 'GET', 'GET'],
    );
    assert.equal(r.calls[3]?.headers.authorization, `Bearer ${NEW_JWT}`);
    assert.equal(parseJson<ListOut<DownloadRow>>(r.stdout).items[0]?.bytes, 5);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(out, { recursive: true, force: true });
  }
});

test('announcements download rejects bad ids before any request', async () => {
  const { root } = seeded();
  try {
    for (const args of [
      ['download', 'abc', '1'],
      ['download', '412690', '0'],
      ['download', '412690', '1386315', 'x'],
      ['download', '412690'],
    ]) {
      const r = await news(root, [jsonStep(CIVICS)], [...args, '--json']);
      assert.equal(r.code, EXIT_CODES.usage, args.join(' '));
      assert.equal(r.calls.length, 0);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('announcements --help and schema create no state directory', async () => {
  const { root } = tempRoot('bs-news-');
  const state = `${root}/state`;
  try {
    for (const argv of [
      ['announcements', '--help'],
      ['announcements', 'list', '--help'],
      ['announcements', 'download', '--help'],
      ['schema', 'announcements', 'get'],
    ]) {
      const r = await runCli(['--root', state, ...argv]);
      assert.equal(r.code, 0, argv.join(' '));
      assert.throws(() => readFileSync(state), argv.join(' '));
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
