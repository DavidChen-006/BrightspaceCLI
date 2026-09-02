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

const FIXTURES = new URL('../fixtures/', import.meta.url);
const WHOAMI: Record<string, unknown> = JSON.parse(
  readFileSync(new URL('whoami-doc-shaped.json', FIXTURES), 'utf8'),
);
const FOLDERS: Record<string, unknown>[] = JSON.parse(
  readFileSync(new URL('dropbox-folders-440703.json', FIXTURES), 'utf8'),
);

const BASE = 'https://purdue.brightspace.com';
const WHOAMI_PATH = '/d2l/api/lp/1.62/users/whoami';
const FOLDERS_PATH = '/d2l/api/le/1.96/440703/dropbox/folders/';
const MINT_PATH = '/d2l/lp/auth/oauth2/token';

const FAR_FUTURE = '2999-01-01T00:00:00Z';
const FRESH_JWT = fakeJwt({ exp: Date.parse(FAR_FUTURE) / 1000, sub: 'first' });
const NEW_JWT = fakeJwt({ exp: Date.parse(FAR_FUTURE) / 1000, sub: 'second' });

function seeded() {
  const t = tempRoot('bs-api-');
  writeSession(t.paths, fakeSession({ jwt: FRESH_JWT, jwtExpiresAt: FAR_FUTURE }));
  return t;
}

async function api(root: string, steps: Step[], args: string[]) {
  const ft = fakeTransport(steps);
  const r = await runCli(['--root', root, 'api', ...args], { transport: ft.transport });
  return { ...r, calls: ft.calls };
}

test('api refuses every non-read method with exit 2 before any request', async () => {
  const { root } = seeded();
  try {
    for (const method of ['POST', 'post', 'PUT', 'PATCH', 'DELETE', 'TRACE', 'CONNECT', 'FETCH']) {
      const r = await api(root, [jsonStep(WHOAMI)], [method, WHOAMI_PATH, '--json']);
      assert.equal(r.code, EXIT_CODES.usage, method);
      assert.equal(r.calls.length, 0, method);
      assert.equal(r.stdout, '', method);
      assert.match(r.stderr, /GET, HEAD or OPTIONS/, method);
      assert.match(r.stderr, /read-only/, method);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('api rejects paths outside /d2l/ with an example in the hint, before any request', async () => {
  const { root } = seeded();
  try {
    for (const path of [
      'users/whoami',
      '/api/lp/1.62/users/whoami',
      'https://purdue.brightspace.com/d2l/api/lp/1.62/users/whoami',
      '/d2l',
      '/d2lx/api',
      '//evil.example/d2l/api',
      '/d2l/../etc/passwd',
    ]) {
      const r = await api(root, [jsonStep(WHOAMI)], ['GET', path, '--json']);
      assert.equal(r.code, EXIT_CODES.usage, path);
      assert.equal(r.calls.length, 0, path);
      assert.equal(r.stdout, '', path);
      assert.match(r.stderr, /\/d2l\/api\/lp\/1\.62\/users\/whoami/, path);
    }
    for (const argv of [
      ['GET'],
      [],
      ['GET', WHOAMI_PATH, 'extra'],
      ['GET', WHOAMI_PATH, '--query', 'novalue'],
      ['GET', WHOAMI_PATH, '--query', '=v'],
      ['GET', WHOAMI_PATH, '--json', '--plain'],
    ]) {
      const r = await api(root, [jsonStep(WHOAMI)], argv);
      assert.equal(r.code, EXIT_CODES.usage, argv.join(' '));
      assert.equal(r.calls.length, 0, argv.join(' '));
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('api GET emits the JSON payload losslessly with the Bearer attached; --select projects it', async () => {
  const { root } = seeded();
  try {
    const r = await api(root, [jsonStep(WHOAMI)], ['GET', WHOAMI_PATH, '--json']);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.calls.length, 1);
    assert.equal(r.calls[0]?.method, 'GET');
    assert.equal(r.calls[0]?.url, `${BASE}${WHOAMI_PATH}`);
    assert.equal(r.calls[0]?.headers.authorization, `Bearer ${FRESH_JWT}`);
    assert.equal('x-http-method-override' in (r.calls[0]?.headers ?? {}), false);
    assert.deepEqual(parseJson(r.stdout), WHOAMI);
    assert.equal(r.stderr, '');

    // Lower-case method and a bare array payload are fine; nothing is re-shaped.
    const list = await api(root, [jsonStep(FOLDERS)], ['get', FOLDERS_PATH, '--json']);
    assert.equal(list.code, 0, list.stderr);
    assert.equal(list.calls[0]?.method, 'GET');
    assert.deepEqual(parseJson(list.stdout), FOLDERS);

    const sel = await api(
      root,
      [jsonStep(FOLDERS)],
      ['GET', FOLDERS_PATH, '--json', '--select', 'Id,Name'],
    );
    assert.deepEqual(
      parseJson(sel.stdout),
      FOLDERS.map((f) => ({ Id: f.Id, Name: f.Name })),
    );

    // Human mode prints the pretty JSON too; --plain flattens the object into one TSV row.
    const human = await api(root, [jsonStep(WHOAMI)], ['GET', WHOAMI_PATH]);
    assert.equal(human.code, 0, human.stderr);
    assert.deepEqual(parseJson(human.stdout), WHOAMI);
    const plain = await api(root, [jsonStep(WHOAMI)], ['GET', WHOAMI_PATH, '--plain']);
    assert.equal(plain.code, 0, plain.stderr);
    const lines = plain.stdout.trimEnd().split('\n');
    assert.equal(lines.length, 2);
    assert.equal(lines[0], Object.keys(WHOAMI).join('\t'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('api --query appends URL-encoded parameters after those already in the path', async () => {
  const { root } = seeded();
  try {
    const r = await api(
      root,
      [jsonStep({ PagingInfo: { Bookmark: '', HasMoreItems: false }, Items: [] })],
      [
        'GET',
        '/d2l/api/lp/1.62/enrollments/myenrollments/?orgUnitTypeId=3',
        '--query',
        'isActive=true',
        '--query',
        'sortBy=OrgUnitName',
        '--query',
        'q=a b&c=d',
        '--query',
        'flag=',
        '--json',
      ],
    );
    assert.equal(r.code, 0, r.stderr);
    const u = new URL(r.calls[0]?.url ?? '');
    assert.equal(u.origin + u.pathname, `${BASE}/d2l/api/lp/1.62/enrollments/myenrollments/`);
    assert.deepEqual(
      [...u.searchParams.entries()],
      [
        ['orgUnitTypeId', '3'],
        ['isActive', 'true'],
        ['sortBy', 'OrgUnitName'],
        ['q', 'a b&c=d'],
        ['flag', ''],
      ],
    );
    assert.ok(u.search.includes('q=a+b%26c%3Dd'), u.search);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('api prints a non-JSON body as text; --raw forces text passthrough even for JSON', async () => {
  const { root } = seeded();
  try {
    const text: Step = {
      status: 200,
      headers: { 'content-type': 'text/plain' },
      body: 'Timestamp out of range',
    };
    const human = await api(root, [text], ['GET', WHOAMI_PATH]);
    assert.equal(human.code, 0, human.stderr);
    assert.equal(human.stdout, 'Timestamp out of range\n');

    // Under --json stdout stays JSON: the text becomes a JSON string.
    const json = await api(root, [text], ['GET', WHOAMI_PATH, '--json']);
    assert.equal(json.code, 0, json.stderr);
    assert.equal(parseJson(json.stdout), 'Timestamp out of range');

    // --raw: the body exactly as received (whitespace included), one trailing newline.
    const body = '{"Identifier": "170259",\n  "FirstName": "Ada"}';
    const raw = await api(
      root,
      [{ status: 200, headers: { 'content-type': 'application/json' }, body }],
      ['GET', WHOAMI_PATH, '--json', '--raw', '--select', 'Identifier'],
    );
    assert.equal(raw.code, 0, raw.stderr);
    assert.equal(raw.stdout, `${body}\n`);

    const empty = await api(root, [{ status: 204, body: '' }], ['OPTIONS', WHOAMI_PATH]);
    assert.equal(empty.code, 0, empty.stderr);
    assert.equal(empty.calls[0]?.method, 'OPTIONS');
    assert.equal(empty.stdout, '');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('api HEAD prints the response headers as an object', async () => {
  const { root } = seeded();
  try {
    const r = await api(
      root,
      [
        {
          status: 200,
          headers: { 'Content-Type': 'application/json', 'X-Request-Cost': '2' },
          body: '',
        },
      ],
      ['HEAD', WHOAMI_PATH, '--json'],
    );
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.calls[0]?.method, 'HEAD');
    assert.deepEqual(parseJson(r.stdout), {
      'content-type': 'application/json',
      'x-request-cost': '2',
    });
    const plain = await api(
      root,
      [{ status: 200, headers: { 'content-type': 'text/html' }, body: '' }],
      ['head', WHOAMI_PATH, '--plain'],
    );
    assert.equal(plain.stdout, 'content-type\ntext/html\n');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('api --wrap-untrusted wraps the free-text leaves of the payload only when the flag is on', async () => {
  const { root } = seeded();
  try {
    const wrapped = await api(
      root,
      [jsonStep(FOLDERS)],
      ['GET', FOLDERS_PATH, '--json', '--wrap-untrusted'],
    );
    assert.equal(wrapped.code, 0, wrapped.stderr);
    const out = parseJson<Record<string, unknown>[]>(wrapped.stdout);
    const marker = new RegExp(
      `^${MARKER_START} id="([0-9a-f]{16})">>>\\nSource: brightspace\\n---\\n[\\s\\S]*\\n${MARKER_END} id="\\1">>>$`,
    );
    assert.match(String(out[0]?.Name), marker);
    assert.equal(out[0]?.Id, FOLDERS[0]?.Id);
    assert.equal(out[0]?.DueDate, FOLDERS[0]?.DueDate);

    const text = await api(
      root,
      [{ status: 200, headers: { 'content-type': 'text/plain' }, body: 'hello' }],
      ['GET', WHOAMI_PATH, '--wrap-untrusted'],
    );
    assert.match(text.stdout.trimEnd(), marker);

    const off = await api(root, [jsonStep(FOLDERS)], ['GET', FOLDERS_PATH, '--json']);
    assert.deepEqual(parseJson(off.stdout), FOLDERS);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('api maps non-2xx responses: 404 → 5, 403 → 6, 401 → one re-mint then 4', async () => {
  const { root } = seeded();
  try {
    const missing = await api(
      root,
      [jsonStep({ title: 'Not Found', status: 404 }, 404)],
      ['GET', '/d2l/api/lp/1.62/users/nobody', '--json'],
    );
    assert.equal(missing.code, EXIT_CODES.not_found);
    assert.equal(missing.stdout, '');
    assert.match(missing.stderr, /GET \/d2l\/api\/lp\/1\.62\/users\/nobody: HTTP 404/);

    const denied = await api(
      root,
      [{ status: 403, body: 'Not authorized' }],
      ['GET', FOLDERS_PATH, '--json'],
    );
    assert.equal(denied.code, EXIT_CODES.permission_denied);
    assert.equal(denied.stdout, '');

    const reminted = await api(
      root,
      [bogusBearerStep, mintOkStep(NEW_JWT), jsonStep(WHOAMI)],
      ['GET', WHOAMI_PATH, '--json'],
    );
    assert.equal(reminted.code, 0, reminted.stderr);
    assert.deepEqual(
      reminted.calls.map((c) => [c.method, new URL(c.url).pathname]),
      [
        ['GET', WHOAMI_PATH],
        ['POST', MINT_PATH],
        ['GET', WHOAMI_PATH],
      ],
    );
    assert.equal(reminted.calls[2]?.headers.authorization, `Bearer ${NEW_JWT}`);
    assert.deepEqual(parseJson(reminted.stdout), WHOAMI);

    const twice = await api(
      root,
      [bogusBearerStep, mintOkStep(NEW_JWT), bogusBearerStep],
      ['GET', WHOAMI_PATH, '--json'],
    );
    assert.equal(twice.code, EXIT_CODES.auth_required);
    assert.equal(twice.calls.length, 3, 'exactly one re-mint');
    assert.equal(twice.stdout, '');
    assert.equal(twice.stderr.includes(NEW_JWT), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('api with no session: exit 4 and no request', async () => {
  const { root } = tempRoot('bs-api-');
  try {
    const r = await api(root, [jsonStep(WHOAMI)], ['GET', WHOAMI_PATH, '--json']);
    assert.equal(r.code, EXIT_CODES.auth_required);
    assert.equal(r.stdout, '');
    assert.ok(r.stderr.includes(HINT_LOGIN), r.stderr);
    assert.equal(r.calls.length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('api --help and schema create no state directory; the method enum is published', async () => {
  const { root } = tempRoot('bs-api-');
  const state = `${root}/state`;
  try {
    for (const argv of [
      ['api', '--help'],
      ['schema', 'api'],
    ]) {
      const r = await runCli(['--root', state, ...argv]);
      assert.equal(r.code, 0, argv.join(' '));
      assert.throws(() => readFileSync(state), argv.join(' '));
    }
    const schema = await runCli(['--root', state, 'schema', 'api', '--json']);
    const node = parseJson<{
      command: { positionals: { name: string; enum: string[] }[]; flags: { name: string }[] };
    }>(schema.stdout);
    assert.deepEqual(node.command.positionals[0]?.enum, ['GET', 'HEAD', 'OPTIONS']);
    const names = node.command.flags.map((f) => f.name);
    assert.ok(names.includes('query'));
    assert.ok(names.includes('raw'));
    assert.equal(
      names.includes('header'),
      false,
      'no --header: X-HTTP-Method-Override stays impossible',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
