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
interface ListOut<T> {
  items: T[];
  count: number;
  fetchedAt: string;
}
interface Forum {
  id: number;
  courseId: number;
  name: string;
  url: string;
  [key: string]: unknown;
}
interface Topic {
  id: number;
  forumId: number | null;
  courseId: number;
  name: string;
  dueDate: string | null;
  scoreOutOf: number | null;
  scoringType: string | null;
  url: string;
  [key: string]: unknown;
}
interface Post {
  id: number;
  topicId: number | null;
  threadId: number | null;
  parentId: number | null;
  subject: string;
  bodyText: string;
  bodyHtml: string | null;
  author: string | null;
  authorId: number | string | null;
  date: string | null;
  replies: number[];
  isRead: boolean;
  url: string;
  [key: string]: unknown;
}

const FIXTURES = new URL('../fixtures/', import.meta.url);
function fixture<T = unknown>(name: string): T {
  return JSON.parse(readFileSync(new URL(name, FIXTURES), 'utf8')) as T;
}
const FORUMS = fixture<Raw[]>('discussion-forums-doc-shaped.json');
const TOPICS_1 = fixture<Raw[]>('discussion-topics-12001-doc-shaped.json');
const TOPICS_2 = fixture<Raw[]>('discussion-topics-12002-doc-shaped.json');
const POSTS = fixture<Raw[]>('discussion-posts-doc-shaped.json');
const NOT_FOUND = fixture<Raw>('quizzes-malformed.json');

const BASE = 'https://purdue.brightspace.com';
const OU = 412690;
const API = `${BASE}/d2l/api/le/1.96/${OU}/discussions`;
const FORUMS_URL = `${API}/forums/`;
const TOPICS_URL = (f: number) => `${API}/forums/${f}/topics/`;
const POSTS_URL = (f: number, t: number) => `${API}/forums/${f}/topics/${t}/posts/`;
const ISO_S = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
const TOPIC_URL = (id: number) => `${BASE}/d2l/le/${OU}/discussions/topics/${id}/View`;
const THREAD_URL = (id: number) => `${BASE}/d2l/le/${OU}/discussions/threads/${id}/View`;

const FAR_FUTURE = '2999-01-01T00:00:00Z';
const FRESH_JWT = fakeJwt({ exp: Date.parse(FAR_FUTURE) / 1000, sub: 'first' });
const NEW_JWT = fakeJwt({ exp: Date.parse(FAR_FUTURE) / 1000, sub: 'second' });

function seeded() {
  const t = tempRoot('bs-discussions-');
  writeSession(t.paths, fakeSession({ jwt: FRESH_JWT, jwtExpiresAt: FAR_FUTURE }));
  return t;
}

async function discussions(root: string, steps: Step[], args: string[]) {
  const ft = fakeTransport(steps);
  const r = await runCli(['--root', root, 'discussions', ...args], { transport: ft.transport });
  return { ...r, calls: ft.calls };
}

function split(url: string): { path: string; query: URLSearchParams } {
  const u = new URL(url);
  return { path: `${u.origin}${u.pathname}`, query: u.searchParams };
}

// ---------------------------------------------------------------------------------------------
// forums
// ---------------------------------------------------------------------------------------------

test('discussions forums --json emits curated forum rows from discussions/forums/', async () => {
  const { root } = seeded();
  try {
    const r = await discussions(root, [jsonStep(FORUMS)], ['forums', String(OU), '--json']);
    assert.equal(r.code, 0, r.stderr);
    const out = parseJson<ListOut<Forum>>(r.stdout);
    assert.equal(out.count, 2);
    assert.match(out.fetchedAt, ISO_S);
    assert.deepEqual(out.items[0], {
      id: 12001,
      courseId: OU,
      name: 'Weekly Discussions',
      description: 'One thread per week. Reply to two classmates.',
      descriptionHtml: '<p>One thread per week. Reply to two classmates.</p>',
      startDate: '2026-08-24T04:00:00Z',
      endDate: null,
      postStartDate: null,
      postEndDate: null,
      isLocked: false,
      isHidden: false,
      requiresApproval: false,
      allowAnonymous: false,
      url: `${BASE}/d2l/le/${OU}/discussions/List`,
    });
    assert.equal(out.items[1]?.endDate, '2026-12-20T04:59:00Z');
    assert.deepEqual(
      r.calls.map((c) => [c.method, c.url]),
      [['GET', FORUMS_URL]],
    );
    assert.equal(r.calls[0]?.headers.authorization, `Bearer ${FRESH_JWT}`);
    assert.equal(r.stderr, '');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('discussions forums: --plain columns, human table, --select, --raw', async () => {
  const { root } = seeded();
  try {
    const plain = await discussions(root, [jsonStep(FORUMS)], ['forums', String(OU), '--plain']);
    assert.equal(plain.code, 0, plain.stderr);
    const lines = plain.stdout.trimEnd().split('\n');
    assert.equal(
      lines[0],
      'id\tcourseId\tname\tdescription\tdescriptionHtml\tstartDate\tendDate\tpostStartDate\tpostEndDate\tisLocked\tisHidden\trequiresApproval\tallowAnonymous\turl',
    );
    assert.equal(lines.length, 3);
    assert.equal(
      lines[2],
      `12002\t${OU}\tQ&A\t\t\t\t2026-12-20T04:59:00Z\t2026-08-24T04:00:00Z\t2026-12-20T04:59:00Z\tfalse\tfalse\ttrue\ttrue\t${BASE}/d2l/le/${OU}/discussions/List`,
    );

    const human = await discussions(root, [jsonStep(FORUMS)], ['forums', String(OU)]);
    assert.equal(human.code, 0, human.stderr);
    const hl = human.stdout.trimEnd().split('\n');
    assert.equal(hl.length, 3);
    assert.match(hl[0] ?? '', /^ID\s+NAME\s+/);
    assert.ok(hl[1]?.includes('Weekly Discussions'));

    const sel = await discussions(
      root,
      [jsonStep(FORUMS)],
      ['forums', String(OU), '--json', '--results-only', '--select', 'id,name'],
    );
    assert.equal(sel.code, 0, sel.stderr);
    assert.deepEqual(parseJson(sel.stdout), [
      { id: 12001, name: 'Weekly Discussions' },
      { id: 12002, name: 'Q&A' },
    ]);

    const raw = await discussions(
      root,
      [jsonStep(FORUMS)],
      ['forums', String(OU), '--json', '--raw', '--select', 'id'],
    );
    assert.equal(raw.code, 0, raw.stderr);
    assert.deepEqual(parseJson<ListOut<Raw>>(raw.stdout).items, FORUMS);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('discussions forums empty: exit 0; --fail-empty → exit 3 with the output still written', async () => {
  const { root } = seeded();
  try {
    const ok = await discussions(root, [jsonStep([])], ['forums', String(OU), '--json']);
    assert.equal(ok.code, 0, ok.stderr);
    assert.deepEqual(parseJson<ListOut<Forum>>(ok.stdout).items, []);

    const empty = await discussions(
      root,
      [jsonStep([])],
      ['forums', String(OU), '--json', '--fail-empty'],
    );
    assert.equal(empty.code, EXIT_CODES.empty_results);
    assert.equal(parseJson<ListOut<Forum>>(empty.stdout).count, 0);
    assert.equal(empty.stderr, '');

    const plain = await discussions(
      root,
      [jsonStep([])],
      ['forums', String(OU), '--plain', '--fail-empty'],
    );
    assert.equal(plain.code, EXIT_CODES.empty_results);
    assert.equal(plain.stdout.trimEnd().split('\n').length, 1, 'header row only');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('discussions forums: an object instead of the bare array is an unexpected shape; undecodable items warn', async () => {
  const { root } = seeded();
  try {
    const shape = await discussions(
      root,
      [jsonStep({ Objects: FORUMS, Next: null })],
      ['forums', String(OU), '--json'],
    );
    assert.equal(shape.code, EXIT_CODES.error);
    assert.equal(shape.stdout, '');
    assert.match(shape.stderr, /bs: GET .*discussions\/forums\/: expected a bare array/);
    assert.match(shape.stderr, /--raw/);

    const mixed = await discussions(
      root,
      [jsonStep([FORUMS[0], { Name: 'mid-deletion' }])],
      ['forums', String(OU), '--json'],
    );
    assert.equal(mixed.code, 0, mixed.stderr);
    assert.equal(parseJson<ListOut<Forum>>(mixed.stdout).count, 1);
    assert.match(mixed.stderr, /warning: .*1 .*undecodable/);

    const none = await discussions(
      root,
      [jsonStep([{ Name: 'x' }])],
      ['forums', String(OU), '--json'],
    );
    assert.equal(none.code, EXIT_CODES.error);
    assert.equal(none.stdout, '');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('discussions forums: 404 → exit 5; 403 → exit 6 with the past-term hint', async () => {
  const { root } = seeded();
  try {
    const missing = await discussions(
      root,
      [jsonStep(NOT_FOUND, 404)],
      ['forums', '999', '--json'],
    );
    assert.equal(missing.code, EXIT_CODES.not_found);
    assert.equal(missing.stdout, '');
    assert.match(missing.stderr, /bs: GET .*999\/discussions\/forums\/: HTTP 404/);

    const denied = await discussions(
      root,
      [{ status: 403, body: 'Not authorized' }],
      ['forums', '1092755', '--json'],
    );
    assert.equal(denied.code, EXIT_CODES.permission_denied);
    assert.equal(denied.stdout, '');
    assert.match(denied.stderr, /past-term/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('discussions forums with no session: exit 4, login hint, no data request', async () => {
  const { root } = tempRoot('bs-discussions-');
  try {
    const r = await discussions(root, [jsonStep(FORUMS)], ['forums', String(OU), '--json']);
    assert.equal(r.code, EXIT_CODES.auth_required);
    assert.equal(r.stdout, '');
    assert.ok(r.stderr.includes(HINT_LOGIN), r.stderr);
    assert.equal(r.calls.length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------------------------
// topics
// ---------------------------------------------------------------------------------------------

test('discussions topics <ou> <forumId> lists one forum: PRD 6.3 topic rows with dueDate/scoreOutOf', async () => {
  const { root } = seeded();
  try {
    const r = await discussions(
      root,
      [jsonStep(TOPICS_1)],
      ['topics', String(OU), '12001', '--json'],
    );
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(
      r.calls.map((c) => [c.method, c.url]),
      [['GET', TOPICS_URL(12001)]],
    );
    const out = parseJson<ListOut<Topic>>(r.stdout);
    assert.equal(out.count, 3);
    assert.deepEqual(out.items[0], {
      id: 31001,
      forumId: 12001,
      courseId: OU,
      name: 'Week 1: Introductions',
      description: 'Tell us who you are.',
      descriptionHtml: '<p>Tell us who you are.</p>',
      dueDate: '2026-09-01T03:59:00Z',
      startDate: '2026-08-24T04:00:00Z',
      endDate: null,
      scoreOutOf: 10,
      scoringType: 'Average',
      requiresApproval: false,
      isLocked: false,
      isHidden: false,
      url: TOPIC_URL(31001),
    });
    assert.deepEqual(
      out.items.map((t) => t.dueDate),
      ['2026-09-01T03:59:00Z', '2026-09-08T03:59:00Z', null],
    );
    assert.equal(r.stderr, '');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('discussions topics <ou> without a forum walks forums/ then every forum, in forum order', async () => {
  const { root } = seeded();
  try {
    const steps: Step[] = [
      jsonStep(FORUMS),
      (req) => {
        const body = req.url === TOPICS_URL(12001) ? TOPICS_1 : TOPICS_2;
        return Promise.resolve({
          status: 200,
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        });
      },
    ];
    const r = await discussions(root, steps, ['topics', String(OU), '--json']);
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(
      r.calls.map((c) => c.url).sort(),
      [FORUMS_URL, TOPICS_URL(12001), TOPICS_URL(12002)].sort(),
    );
    assert.equal(r.calls[0]?.url, FORUMS_URL, 'forums first');
    const out = parseJson<ListOut<Topic>>(r.stdout);
    assert.deepEqual(
      out.items.map((t) => [t.forumId, t.id]),
      [
        [12001, 31001],
        [12001, 31002],
        [12001, 31003],
        [12002, 31004],
      ],
    );
    assert.equal(r.stderr, '');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('discussions topics (all forums): one forum failing costs only its topics with a warning; all failing is the error', async () => {
  const { root } = seeded();
  try {
    const partial: Step[] = [
      jsonStep(FORUMS),
      (req): Promise<TransportResponse> =>
        Promise.resolve<TransportResponse>(
          req.url === TOPICS_URL(12001)
            ? {
                status: 200,
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify(TOPICS_1),
              }
            : { status: 403, headers: {}, body: 'Not authorized' },
        ),
    ];
    const r = await discussions(root, partial, ['topics', String(OU), '--json']);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(parseJson<ListOut<Topic>>(r.stdout).count, 3);
    assert.match(r.stderr, /warning: .*forum 12002.*403/);

    const all = await discussions(
      root,
      [jsonStep(FORUMS), { status: 403, body: 'Not authorized' }],
      ['topics', String(OU), '--json'],
    );
    assert.equal(all.code, EXIT_CODES.permission_denied);
    assert.equal(all.stdout, '');
    assert.match(all.stderr, /past-term/);

    const noForums = await discussions(root, [jsonStep([])], ['topics', String(OU), '--json']);
    assert.equal(noForums.code, 0, noForums.stderr);
    assert.equal(parseJson<ListOut<Topic>>(noForums.stdout).count, 0);
    assert.equal(noForums.calls.length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('discussions topics: --plain, --select, --fail-empty, --raw and --wrap-untrusted', async () => {
  const { root } = seeded();
  try {
    const plain = await discussions(
      root,
      [jsonStep(TOPICS_1)],
      ['topics', String(OU), '12001', '--plain'],
    );
    assert.equal(plain.code, 0, plain.stderr);
    const lines = plain.stdout.trimEnd().split('\n');
    assert.equal(
      lines[0],
      'id\tforumId\tcourseId\tname\tdescription\tdescriptionHtml\tdueDate\tstartDate\tendDate\tscoreOutOf\tscoringType\trequiresApproval\tisLocked\tisHidden\turl',
    );
    assert.equal(lines.length, 4);
    assert.equal(
      lines[3],
      `31003\t12001\t${OU}\tWeek 3: Open thread\t\t\t\t\t\t\tUnscored\tfalse\ttrue\ttrue\t${TOPIC_URL(31003)}`,
    );

    const sel = await discussions(
      root,
      [jsonStep(TOPICS_1)],
      ['topics', String(OU), '12001', '--json', '--results-only', '--select', 'id,dueDate'],
    );
    assert.deepEqual(parseJson(sel.stdout), [
      { id: 31001, dueDate: '2026-09-01T03:59:00Z' },
      { id: 31002, dueDate: '2026-09-08T03:59:00Z' },
      { id: 31003, dueDate: null },
    ]);

    const empty = await discussions(
      root,
      [jsonStep([])],
      ['topics', String(OU), '12001', '--json', '--fail-empty'],
    );
    assert.equal(empty.code, EXIT_CODES.empty_results);
    assert.equal(parseJson<ListOut<Topic>>(empty.stdout).count, 0);

    const raw = await discussions(
      root,
      [jsonStep(TOPICS_1)],
      ['topics', String(OU), '12001', '--json', '--raw'],
    );
    assert.deepEqual(parseJson<ListOut<Raw>>(raw.stdout).items, TOPICS_1);

    const wrapped = await discussions(
      root,
      [jsonStep(TOPICS_1)],
      ['topics', String(OU), '12001', '--json', '--wrap-untrusted', '--limit', '1'],
    );
    assert.equal(wrapped.code, 0, wrapped.stderr);
    const out = parseJson<ListOut<Raw> & { externalContent: unknown }>(wrapped.stdout);
    const marker = new RegExp(
      `^${MARKER_START} id="([0-9a-f]{16})">>>\\nSource: brightspace\\n---\\n[\\s\\S]*\\n${MARKER_END} id="\\1">>>$`,
    );
    for (const key of ['name', 'description', 'descriptionHtml']) {
      assert.match(String(out.items[0]?.[key]), marker, key);
    }
    assert.equal(out.items[0]?.id, 31001);
    assert.equal(out.items[0]?.forumId, 12001);
    assert.equal(out.items[0]?.scoringType, 'Average', 'enum-like strings are never wrapped');
    assert.equal(out.items[0]?.dueDate, '2026-09-01T03:59:00Z');
    assert.equal(out.items[0]?.url, TOPIC_URL(31001));
    assert.deepEqual(out.externalContent, {
      untrusted: true,
      source: 'brightspace',
      wrapped: true,
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('discussions topics: 404 on an unknown forum → exit 5 with a forums hint; 403 → exit 6', async () => {
  const { root } = seeded();
  try {
    const missing = await discussions(
      root,
      [jsonStep({ title: 'Not Found', status: 404 }, 404)],
      ['topics', String(OU), '999', '--json'],
    );
    assert.equal(missing.code, EXIT_CODES.not_found);
    assert.equal(missing.stdout, '');
    assert.match(missing.stderr, new RegExp(`bs discussions forums ${OU}`));

    const denied = await discussions(
      root,
      [{ status: 403, body: 'Not authorized' }],
      ['topics', '1092755', '12001', '--json'],
    );
    assert.equal(denied.code, EXIT_CODES.permission_denied);
    assert.match(denied.stderr, /past-term/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------------------------
// posts
// ---------------------------------------------------------------------------------------------

test('discussions posts pages with pageSize/pageNumber and sort=-creationdate, stopping on a short page', async () => {
  const { root } = seeded();
  try {
    const r = await discussions(
      root,
      [jsonStep(POSTS.slice(0, 2)), jsonStep(POSTS.slice(2))],
      ['posts', String(OU), '12001', '31001', '--json', '--page-size', '2'],
    );
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.calls.length, 2);
    const pages = r.calls.map((c) => split(c.url));
    for (const p of pages) {
      assert.equal(p.path, POSTS_URL(12001, 31001));
      assert.equal(p.query.get('sort'), '-creationdate');
      assert.equal(p.query.get('pageSize'), '2');
      assert.equal(p.query.has('threadsOnly'), false);
    }
    assert.deepEqual(
      pages.map((p) => p.query.get('pageNumber')),
      ['1', '2'],
    );
    const out = parseJson<ListOut<Post>>(r.stdout);
    assert.equal(out.count, 3);
    assert.deepEqual(
      out.items.map((p) => p.id),
      [51003, 51002, 51001],
    );
    assert.deepEqual(out.items[2], {
      id: 51001,
      topicId: 31001,
      forumId: 12001,
      courseId: OU,
      threadId: 51001,
      parentId: null,
      subject: 'Hello from Grace',
      bodyText: "Hello everyone, I'm Grace.\nSee my photo attached.",
      bodyHtml: "<p>Hello everyone, I'm Grace.</p><p>See my photo attached.</p>",
      author: 'Grace Hopper',
      authorId: 654321,
      date: '2026-08-25T14:02:11Z',
      replies: [51003],
      isRead: true,
      isAnonymous: false,
      isDeleted: false,
      attachments: [{ fileId: 77001, fileName: 'grace.jpg', size: 20480 }],
      url: THREAD_URL(51001),
    });
    assert.equal(out.items[0]?.parentId, 51001);
    assert.equal(out.items[1]?.authorId, null);
    assert.equal(r.stderr, '');

    // A full last page costs one more (empty) request, which is the short page.
    const exact = await discussions(
      root,
      [jsonStep(POSTS), jsonStep([])],
      ['posts', String(OU), '12001', '31001', '--json', '--page-size', '3'],
    );
    assert.equal(exact.code, 0, exact.stderr);
    assert.equal(exact.calls.length, 2);
    assert.equal(parseJson<ListOut<Post>>(exact.stdout).count, 3);

    // Default page size is 100.
    const dflt = await discussions(
      root,
      [jsonStep(POSTS)],
      ['posts', String(OU), '12001', '31001', '--json'],
    );
    assert.equal(dflt.calls.length, 1);
    assert.equal(split(dflt.calls[0]?.url ?? '').query.get('pageSize'), '100');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('discussions posts --limit stops early (no second page); --threads-only shapes the query', async () => {
  const { root } = seeded();
  try {
    const limited = await discussions(
      root,
      [jsonStep(POSTS.slice(0, 2)), jsonStep(POSTS.slice(2))],
      ['posts', String(OU), '12001', '31001', '--json', '--page-size', '2', '--limit', '2'],
    );
    assert.equal(limited.code, 0, limited.stderr);
    assert.equal(parseJson<ListOut<Post>>(limited.stdout).count, 2);
    assert.equal(limited.calls.length, 1, 'page two never fetched');

    const one = await discussions(
      root,
      [jsonStep(POSTS.slice(0, 2)), jsonStep(POSTS.slice(2))],
      ['posts', String(OU), '12001', '31001', '--json', '--page-size', '2', '--limit', '1'],
    );
    assert.equal(parseJson<ListOut<Post>>(one.stdout).count, 1);
    assert.equal(one.calls.length, 1);

    const threads = await discussions(
      root,
      [jsonStep([POSTS[1], POSTS[2]])],
      ['posts', String(OU), '12001', '31001', '--json', '--threads-only'],
    );
    assert.equal(threads.code, 0, threads.stderr);
    assert.equal(split(threads.calls[0]?.url ?? '').query.get('threadsOnly'), 'true');
    assert.equal(parseJson<ListOut<Post>>(threads.stdout).count, 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('discussions posts --wrap-untrusted wraps subject, body and author; sanitises marker look-alikes', async () => {
  const { root } = seeded();
  try {
    const r = await discussions(
      root,
      [jsonStep(POSTS)],
      ['posts', String(OU), '12001', '31001', '--json', '--wrap-untrusted'],
    );
    assert.equal(r.code, 0, r.stderr);
    const out = parseJson<ListOut<Raw> & { externalContent: unknown }>(r.stdout);
    const marker = new RegExp(
      `^${MARKER_START} id="([0-9a-f]{16})">>>\\nSource: brightspace\\n---\\n[\\s\\S]*\\n${MARKER_END} id="\\1">>>$`,
    );
    const reply = out.items[0] as Raw;
    for (const key of ['subject', 'bodyText', 'bodyHtml', 'author']) {
      assert.match(String(reply[key]), marker, key);
    }
    assert.ok(String(reply.bodyText).includes('[[MARKER_SANITIZED]]'), 'look-alike rewritten');
    assert.equal(
      String(reply.bodyText).indexOf(MARKER_START),
      0,
      'the only real marker is the wrapper',
    );
    assert.equal(reply.id, 51003);
    assert.equal(reply.authorId, 123456);
    assert.equal(reply.threadId, 51001);
    assert.equal(reply.date, '2026-08-26T15:30:12Z');
    assert.equal(reply.url, THREAD_URL(51001));
    assert.deepEqual((out.items[2] as Raw).replies, [51003]);
    assert.deepEqual((out.items[2] as Raw).attachments, [
      { fileId: 77001, fileName: 'grace.jpg', size: 20480 },
    ]);
    assert.deepEqual(out.externalContent, {
      untrusted: true,
      source: 'brightspace',
      wrapped: true,
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('discussions posts: --plain, human, --select, --raw, empty/--fail-empty', async () => {
  const { root } = seeded();
  try {
    const plain = await discussions(
      root,
      [jsonStep(POSTS)],
      ['posts', String(OU), '12001', '31001', '--plain'],
    );
    assert.equal(plain.code, 0, plain.stderr);
    const lines = plain.stdout.trimEnd().split('\n');
    assert.equal(
      lines[0],
      'id\ttopicId\tforumId\tcourseId\tthreadId\tparentId\tsubject\tbodyText\tbodyHtml\tauthor\tauthorId\tdate\treplies\tisRead\tisAnonymous\tisDeleted\tattachments\turl',
    );
    assert.equal(lines.length, 4);
    assert.ok(lines[3]?.startsWith(`51001\t31001\t12001\t${OU}\t51001\t\tHello from Grace\t`));
    assert.ok(
      lines[3]?.includes('\\n'),
      'newlines in the body are escaped so one post is one line',
    );
    assert.ok(lines[3]?.includes('\t[51003]\t'), 'arrays are JSON in a cell');

    const human = await discussions(
      root,
      [jsonStep(POSTS)],
      ['posts', String(OU), '12001', '31001'],
    );
    assert.equal(human.code, 0, human.stderr);
    assert.match(human.stdout.split('\n')[0] ?? '', /^ID\s+/);
    assert.ok(human.stdout.includes('Grace Hopper'));

    const sel = await discussions(
      root,
      [jsonStep(POSTS)],
      ['posts', String(OU), '12001', '31001', '--json', '--results-only', '--select', 'id,author'],
    );
    assert.deepEqual(parseJson(sel.stdout), [
      { id: 51003, author: 'Ada Lovelace' },
      { id: 51002, author: 'Anonymous' },
      { id: 51001, author: 'Grace Hopper' },
    ]);

    const raw = await discussions(
      root,
      [jsonStep(POSTS)],
      ['posts', String(OU), '12001', '31001', '--json', '--raw'],
    );
    assert.deepEqual(parseJson<ListOut<Raw>>(raw.stdout).items, POSTS);

    const ok = await discussions(
      root,
      [jsonStep([])],
      ['posts', String(OU), '12001', '31001', '--json'],
    );
    assert.equal(ok.code, 0, ok.stderr);
    assert.equal(parseJson<ListOut<Post>>(ok.stdout).count, 0);
    const empty = await discussions(
      root,
      [jsonStep([])],
      ['posts', String(OU), '12001', '31001', '--json', '--fail-empty'],
    );
    assert.equal(empty.code, EXIT_CODES.empty_results);
    assert.equal(empty.stderr, '');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('discussions posts: 404 → exit 5 with a topics hint; 403 → exit 6; non-array → error', async () => {
  const { root } = seeded();
  try {
    const missing = await discussions(
      root,
      [jsonStep({ title: 'Not Found', status: 404 }, 404)],
      ['posts', String(OU), '12001', '999', '--json'],
    );
    assert.equal(missing.code, EXIT_CODES.not_found);
    assert.equal(missing.stdout, '');
    assert.match(missing.stderr, new RegExp(`bs discussions topics ${OU} 12001`));

    const denied = await discussions(
      root,
      [{ status: 403, body: 'Not authorized' }],
      ['posts', '1092755', '12001', '31001', '--json'],
    );
    assert.equal(denied.code, EXIT_CODES.permission_denied);
    assert.match(denied.stderr, /past-term/);

    const shape = await discussions(
      root,
      [jsonStep({ Objects: POSTS, Next: null })],
      ['posts', String(OU), '12001', '31001', '--json'],
    );
    assert.equal(shape.code, EXIT_CODES.error);
    assert.equal(shape.stdout, '');
    assert.match(shape.stderr, /unexpected response shape, expected a JSON array/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('discussions posts whose first page answers 401 re-mints once and resumes from page one', async () => {
  const { root } = seeded();
  try {
    const r = await discussions(
      root,
      [bogusBearerStep, mintOkStep(NEW_JWT), jsonStep(POSTS.slice(0, 2)), jsonStep(POSTS.slice(2))],
      ['posts', String(OU), '12001', '31001', '--json', '--page-size', '2'],
    );
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(
      r.calls.map((c) => c.method),
      ['GET', 'POST', 'GET', 'GET'],
    );
    assert.equal(split(r.calls[2]?.url ?? '').query.get('pageNumber'), '1');
    assert.equal(r.calls[2]?.headers.authorization, `Bearer ${NEW_JWT}`);
    assert.equal(r.calls[3]?.headers.authorization, `Bearer ${NEW_JWT}`);
    assert.equal(parseJson<ListOut<Post>>(r.stdout).count, 3);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------------------------
// argument validation, help
// ---------------------------------------------------------------------------------------------

test('discussions forums/topics/posts reject bad ids, page sizes and limits before any request', async () => {
  const { root } = seeded();
  try {
    for (const bad of ['abc', '0', '-3', '1.5']) {
      const forums = await discussions(root, [jsonStep(FORUMS)], ['forums', bad, '--json']);
      assert.equal(forums.code, EXIT_CODES.usage, `forums ${bad}`);
      assert.equal(forums.calls.length, 0);
      const topics = await discussions(
        root,
        [jsonStep(TOPICS_1)],
        ['topics', String(OU), bad, '--json'],
      );
      assert.equal(topics.code, EXIT_CODES.usage, `topics ${bad}`);
      assert.equal(topics.calls.length, 0);
      const posts = await discussions(
        root,
        [jsonStep(POSTS)],
        ['posts', String(OU), '12001', bad, '--json'],
      );
      assert.equal(posts.code, EXIT_CODES.usage, `posts ${bad}`);
      assert.equal(posts.calls.length, 0);
    }
    for (const bad of ['0', '1001', 'ten']) {
      const r = await discussions(
        root,
        [jsonStep(POSTS)],
        ['posts', String(OU), '12001', '31001', '--json', '--page-size', bad],
      );
      assert.equal(r.code, EXIT_CODES.usage, `--page-size ${bad}`);
      assert.equal(r.calls.length, 0);
    }
    const limit = await discussions(
      root,
      [jsonStep(POSTS)],
      ['posts', String(OU), '12001', '31001', '--json', '--limit', '0'],
    );
    assert.equal(limit.code, EXIT_CODES.usage);
    assert.equal(limit.calls.length, 0);
    for (const argv of [['forums'], ['topics'], ['posts', String(OU), '12001']]) {
      const r = await discussions(root, [jsonStep(FORUMS)], [...argv, '--json']);
      assert.equal(r.code, EXIT_CODES.usage, argv.join(' '));
      assert.equal(r.calls.length, 0);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('discussions --help and schema create no state directory', async () => {
  const { root } = tempRoot('bs-discussions-');
  const state = `${root}/state`;
  try {
    for (const argv of [
      ['discussions', '--help'],
      ['discussions', 'posts', '--help'],
      ['schema', 'discussions', 'topics'],
    ]) {
      const r = await runCli(['--root', state, ...argv]);
      assert.equal(r.code, 0, argv.join(' '));
      assert.throws(() => readFileSync(state), argv.join(' '));
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
