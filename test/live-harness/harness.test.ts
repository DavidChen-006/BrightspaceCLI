/**
 * Hermetic tests for the live-E2E harness itself (bs-bo2).
 *
 * `test/live/` only runs against a real tenant, so the parts of it that can be wrong without a
 * tenant — the gate, the fail-fast preconditions, the JSON/exit-code parsing and the course
 * choice — are exercised here, inside `npm test`. Nothing in this file opens a socket or spawns
 * the CLI.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  type CliRun,
  chooseCourse,
  describeRun,
  isDeepLinkAlive,
  itemsOf,
  type LiveCourse,
  liveGate,
  parseJsonStdout,
  requireBuild,
  requireLiveRoot,
} from '../live/harness.js';

function run(overrides: Partial<CliRun> = {}): CliRun {
  return {
    argv: ['courses', 'list', '--json'],
    code: 0,
    stdout: '',
    stderr: '',
    ms: 1,
    ...overrides,
  };
}

function course(overrides: Partial<LiveCourse> = {}): LiveCourse {
  return {
    id: 1,
    name: 'Course',
    isActive: true,
    canAccess: true,
    url: 'https://example.test/d2l/home/1',
    ...overrides,
  };
}

test('liveGate: absent BS_LIVE skips with a reason naming the script that sets it', () => {
  const gate = liveGate({});
  assert.equal(gate.enabled, false);
  assert.match(gate.reason, /BS_LIVE is not set/);
  assert.match(gate.reason, /npm run test:live/);
});

test('liveGate: falsey values are off, anything else is on', () => {
  for (const value of ['', '0', 'false', 'no', 'off', ' OFF ']) {
    assert.equal(liveGate({ BS_LIVE: value }).enabled, false, `BS_LIVE=${JSON.stringify(value)}`);
  }
  for (const value of ['1', 'true', 'yes']) {
    assert.equal(liveGate({ BS_LIVE: value }).enabled, true, `BS_LIVE=${JSON.stringify(value)}`);
  }
  assert.equal(liveGate({ BS_LIVE: '1' }).reason, 'BS_LIVE=1');
});

test('requireLiveRoot: no BS_ROOT fails fast and names the fix', () => {
  assert.throws(
    () => requireLiveRoot({}),
    (err: Error) =>
      /BS_ROOT is required/.test(err.message) && /npm run test:live/.test(err.message),
  );
  assert.throws(() => requireLiveRoot({ BS_ROOT: '   ' }), /BS_ROOT is required/);
});

test('requireLiveRoot: a root without session.json names the login that creates one', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'bs-live-harness-'));
  try {
    assert.throws(
      () => requireLiveRoot({ BS_ROOT: root }),
      (err: Error) =>
        /no session\.json/.test(err.message) &&
        err.message.includes(path.join(root, 'session.json')) &&
        /bs auth login/.test(err.message),
    );
    writeFileSync(path.join(root, 'session.json'), '{}');
    assert.equal(requireLiveRoot({ BS_ROOT: root }), path.resolve(root));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('requireBuild: a missing dist/bin/bs.js points at npm run build', () => {
  assert.throws(
    () => requireBuild(path.join(tmpdir(), 'definitely-not-built', 'bs.js')),
    /npm run build/,
  );
});

test('parseJsonStdout: parses --json stdout and blames the command when it is not JSON', () => {
  assert.deepEqual(parseJsonStdout(run({ stdout: '{"a":1}' })), { a: 1 });
  assert.throws(
    () => parseJsonStdout(run({ stdout: 'Usage: bs ...', code: 2, stderr: 'boom' })),
    (err: Error) =>
      /stdout was not JSON/.test(err.message) &&
      /bs courses list --json -> exit 2/.test(err.message),
  );
});

test('itemsOf: accepts the PRD 6.3 envelope and rejects anything else', () => {
  const ok = run({ stdout: '{"items":[{"id":1}],"count":1,"fetchedAt":"2026-09-02T00:00:00Z"}' });
  assert.deepEqual(itemsOf(ok), [{ id: 1 }]);
  assert.throws(() => itemsOf(run({ stdout: '{"id":1}' })), /expected \{items, count, fetchedAt\}/);
});

test('describeRun: one line with the argv, the exit code and the last stderr line', () => {
  const line = describeRun(run({ code: 6, stderr: 'warn: something\nerror: 403 past-term\n' }));
  assert.equal(line, 'bs courses list --json -> exit 6 | error: 403 past-term');
  assert.equal(describeRun(run()), 'bs courses list --json -> exit 0');
});

test('chooseCourse: the first enrollment that is both active and accessible', () => {
  const list = [
    course({ id: 10, canAccess: false }),
    course({ id: 11, isActive: false }),
    course({ id: 12 }),
    course({ id: 13 }),
  ];
  assert.equal(chooseCourse(list)?.id, 12);
  // The tenant's steady state: 25 of 27 enrollments are past-term (canAccess false).
  assert.equal(chooseCourse([course({ id: 10, canAccess: false })]), null);
  assert.equal(chooseCourse([course({ canAccess: null })]), null);
  assert.equal(chooseCourse([]), null);
});

test('isDeepLinkAlive: only a 404 condemns a link template (bs-fwr)', () => {
  for (const status of [200, 302, 401, 403, 405, 500]) {
    assert.equal(isDeepLinkAlive(status), true, `status ${status}`);
  }
  assert.equal(isDeepLinkAlive(404), false);
});
