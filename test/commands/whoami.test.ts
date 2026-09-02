import assert from 'node:assert/strict';
import { readFileSync, rmSync } from 'node:fs';
import { test } from 'node:test';
import { HINT_LOGIN } from '../../src/auth/ladder.js';
import { writeSession } from '../../src/auth/session.js';
import { EXIT_CODES } from '../../src/core/errors.js';
import {
  assertNoSecrets,
  bogusBearerStep,
  fakeJwt,
  fakeSession,
  mintOkStep,
  secretsOf,
  tempRoot,
} from '../helpers/auth.js';
import { parseJson, runCli } from '../helpers/cli.js';
import { fakeTransport, jsonStep, type Step } from '../helpers/http.js';

const FIXTURES = new URL('../fixtures/', import.meta.url);
const WHOAMI = JSON.parse(readFileSync(new URL('whoami-doc-shaped.json', FIXTURES), 'utf8'));

const FAR_FUTURE = '2999-01-01T00:00:00Z';
const FRESH_JWT = fakeJwt({ exp: Date.parse(FAR_FUTURE) / 1000, sub: 'first' });
const NEW_JWT = fakeJwt({ exp: Date.parse(FAR_FUTURE) / 1000, sub: 'second' });

function seeded() {
  const t = tempRoot('bs-whoami-');
  writeSession(t.paths, fakeSession({ jwt: FRESH_JWT, jwtExpiresAt: FAR_FUTURE }));
  return t;
}

async function whoami(root: string, steps: Step[], extra: string[] = [], env = {}) {
  const ft = fakeTransport(steps);
  const r = await runCli(['--root', root, 'whoami', ...extra], { transport: ft.transport, env });
  return { ...r, calls: ft.calls };
}

test('whoami --json: curated shape, Bearer attached, LP route from config', async () => {
  const { root } = seeded();
  try {
    const r = await whoami(root, [jsonStep(WHOAMI)], ['--json']);
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(parseJson(r.stdout), {
      id: 123456,
      firstName: 'Ada',
      lastName: 'Lovelace',
      uniqueName: 'alovelace',
      pronouns: 'she/her',
    });
    assert.equal(r.calls.length, 1);
    assert.equal(r.calls[0]?.method, 'GET');
    assert.equal(r.calls[0]?.url, 'https://purdue.brightspace.com/d2l/api/lp/1.62/users/whoami');
    assert.equal(r.calls[0]?.headers.authorization, `Bearer ${FRESH_JWT}`);
    assert.equal(r.stderr, '');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('whoami honours BS_LP_VERSION', async () => {
  const { root } = seeded();
  try {
    const r = await whoami(root, [jsonStep(WHOAMI)], ['--json'], { BS_LP_VERSION: '1.70' });
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.calls[0]?.url, 'https://purdue.brightspace.com/d2l/api/lp/1.70/users/whoami');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('whoami --plain: one TSV header and one row', async () => {
  const { root } = seeded();
  try {
    const r = await whoami(root, [jsonStep(WHOAMI)], ['--plain']);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(
      r.stdout,
      'id\tfirstName\tlastName\tuniqueName\tpronouns\n123456\tAda\tLovelace\talovelace\tshe/her\n',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('whoami human mode: a single line naming the user', async () => {
  const { root } = seeded();
  try {
    const r = await whoami(root, [jsonStep(WHOAMI)]);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.stdout.trimEnd().split('\n').length, 1);
    assert.ok(r.stdout.includes('Ada Lovelace'), r.stdout);
    assert.ok(r.stdout.includes('alovelace'), r.stdout);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('whoami --raw emits the WhoAmIUser payload untouched and ignores --select', async () => {
  const { root } = seeded();
  try {
    const r = await whoami(root, [jsonStep(WHOAMI)], ['--json', '--raw', '--select', 'id']);
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(parseJson(r.stdout), WHOAMI);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('whoami --wrap-untrusted wraps names, never the id or uniqueName', async () => {
  const { root } = seeded();
  try {
    const r = await whoami(root, [jsonStep(WHOAMI)], ['--json', '--wrap-untrusted']);
    assert.equal(r.code, 0, r.stderr);
    const out = parseJson<Record<string, unknown>>(r.stdout);
    assert.match(String(out.firstName), /^<<<EXTERNAL_UNTRUSTED_CONTENT id="[0-9a-f]{16}">>>/);
    assert.equal(out.id, 123456);
    assert.equal(out.uniqueName, 'alovelace');
    assert.deepEqual(out.externalContent, {
      untrusted: true,
      source: 'brightspace',
      wrapped: true,
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('whoami with no session: exit 4, login hint, no network at all', async () => {
  const { root } = tempRoot('bs-whoami-');
  try {
    const r = await whoami(root, [jsonStep(WHOAMI)], ['--json']);
    assert.equal(r.code, EXIT_CODES.auth_required);
    assert.equal(r.stdout, '');
    assert.ok(r.stderr.includes(HINT_LOGIN), r.stderr);
    assert.equal(r.calls.length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('whoami whose first call answers 401: one re-mint, the call is repeated with the new JWT', async () => {
  const { root, paths } = seeded();
  try {
    const session = fakeSession({ jwt: FRESH_JWT, jwtExpiresAt: FAR_FUTURE });
    const r = await whoami(
      root,
      [bogusBearerStep, mintOkStep(NEW_JWT), jsonStep(WHOAMI)],
      ['--json', '--verbose'],
    );
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(
      r.calls.map((c) => c.method),
      ['GET', 'POST', 'GET'],
    );
    assert.equal(r.calls[0]?.headers.authorization, `Bearer ${FRESH_JWT}`);
    assert.equal(r.calls[2]?.headers.authorization, `Bearer ${NEW_JWT}`);
    assert.equal(parseJson<{ id: number }>(r.stdout).id, 123456);
    const secrets = [...secretsOf(session), FRESH_JWT, NEW_JWT];
    assertNoSecrets(r.stdout, secrets, 'stdout');
    assertNoSecrets(r.stderr, secrets, 'stderr');
    assert.ok(readFileSync(paths.sessionFile, 'utf8').includes(NEW_JWT), 'new JWT cached');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('whoami whose call answers 401 twice: exit 4 after exactly one re-mint', async () => {
  const { root } = seeded();
  try {
    const r = await whoami(
      root,
      [bogusBearerStep, mintOkStep(NEW_JWT), bogusBearerStep],
      ['--json'],
    );
    assert.equal(r.code, EXIT_CODES.auth_required);
    assert.equal(r.calls.length, 3);
    assert.ok(r.stderr.includes(HINT_LOGIN), r.stderr);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('whoami --help creates no state directory', async () => {
  const { root } = tempRoot('bs-whoami-');
  const state = `${root}/state`;
  try {
    const r = await runCli(['--root', state, 'whoami', '--help']);
    assert.equal(r.code, 0);
    assert.throws(() => readFileSync(state));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
