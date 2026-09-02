/**
 * Live tier 0 (PRD 12 "Live", PRD 7 rung 0): a session is already in place, so every check here
 * is free — no browser, no MFA, no human. It is the tier CI-style reruns and the orchestrator's
 * post-merge sweep use.
 *
 *   npm run build
 *   BS_LIVE=1 BS_ROOT="$HOME/Library/Application Support/bs" npm run test:live
 *
 * Tier 1 lives in `tier1.test.ts` (opt in with `BS_LIVE_TIER=1`); tier 2 is manual and documented
 * there. Everything runs against the built binary through `runBs()`, so exit codes (PRD 6.4) and
 * the stdout/stderr split are the shipped ones.
 *
 * The one tenant fact that shapes these assertions: 25 of 27 enrollments on this tenant are
 * past-term and answer 403 on every per-course route (docs/evidence/brightspace-bar-sweep.md,
 * quirk 2). So the suite picks the first course that is BOTH `isActive` and `canAccess` and holds
 * every per-course check to exit 0 on that one; a 403 anywhere else (inside `bs upcoming`'s
 * fan-out) is recorded as "past-term, skipped", never as a failure.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readSession } from '../../src/auth/session.js';
import { createHttp } from '../../src/core/http/index.js';
import { resolvePaths } from '../../src/core/paths.js';
import { calendarUrl, discussionsUrl } from '../../src/d2l/links.js';
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
  runBs,
} from './harness.js';

const gate = liveGate();

if (!gate.enabled) {
  test('live tier 0', { skip: gate.reason }, () => {});
} else {
  const ROOT = requireLiveRoot();
  requireBuild();

  const LP_VERSION = process.env.BS_LP_VERSION?.trim() || '1.62';

  /** Memoises an async step so several tests can share one round trip. */
  function once<T>(make: () => Promise<T>): () => Promise<T> {
    let pending: Promise<T> | null = null;
    return () => {
      pending ??= make();
      return pending;
    };
  }

  const bs = (args: readonly string[]) => runBs(args, { root: ROOT });

  function assertExit(run: CliRun, expected: number): void {
    assert.equal(run.code, expected, `${describeRun(run)} (expected exit ${expected})`);
  }

  const session = once(async () => {
    const s = readSession(resolvePaths({ root: ROOT }));
    assert.ok(s, `no readable session.json under ${ROOT}`);
    return s;
  });

  const courses = once(async () => {
    const run = await bs(['courses', 'list', '--json']);
    assertExit(run, 0);
    return itemsOf<LiveCourse>(run);
  });

  const course = once(async () => {
    const picked = chooseCourse(await courses());
    assert.ok(
      picked,
      'no enrollment is both isActive and canAccess — every per-course check needs a ' +
        'current-term course. Run `bs courses list --json` and check the term.',
    );
    return picked;
  });

  // ── the session itself ──────────────────────────────────────────────────────────────────────

  test('tier 0: auth status --json reports a fresh session', async (t) => {
    const run = await bs(['auth', 'status', '--json']);
    assertExit(run, 0);
    const status = parseJsonStdout<{ state: string; profileExists: boolean }>(run);
    assert.equal(status.state, 'fresh', describeRun(run));
    t.diagnostic(`profileExists=${status.profileExists} (tier 1 needs it)`);
  });

  test('tier 0: whoami --json carries a numeric id', async (t) => {
    const run = await bs(['whoami', '--json']);
    assertExit(run, 0);
    const me = parseJsonStdout<{ id: unknown; uniqueName: unknown }>(run);
    assert.equal(typeof me.id, 'number', `whoami.id was ${JSON.stringify(me.id)}`);
    t.diagnostic(`whoami id=${String(me.id)}`);
  });

  test('tier 0: courses list --json is non-empty and yields a current-term course', async (t) => {
    const list = await courses();
    assert.ok(list.length > 0, 'courses list returned no items');
    const picked = await course();
    assert.equal(typeof picked.id, 'number');
    assert.ok(typeof picked.name === 'string' && picked.name.length > 0);
    t.diagnostic(`${list.length} courses; chosen ou=${picked.id}`);
  });

  // ── the per-course read commands (PRD 12 Definition of done) ────────────────────────────────

  const COURSE_COMMANDS: ReadonlyArray<{ name: string; args: (ou: number) => string[] }> = [
    { name: 'assignments list', args: (ou) => ['assignments', 'list', String(ou), '--json'] },
    { name: 'quizzes list', args: (ou) => ['quizzes', 'list', String(ou), '--json'] },
    { name: 'grades list', args: (ou) => ['grades', 'list', String(ou), '--json'] },
    { name: 'announcements list', args: (ou) => ['announcements', 'list', String(ou), '--json'] },
    {
      name: 'content toc --flat',
      args: (ou) => ['content', 'toc', String(ou), '--flat', '--json'],
    },
    { name: 'discussions forums', args: (ou) => ['discussions', 'forums', String(ou), '--json'] },
    { name: 'discussions topics', args: (ou) => ['discussions', 'topics', String(ou), '--json'] },
    { name: 'calendar events', args: (ou) => ['calendar', 'events', String(ou), '--json'] },
  ];

  for (const command of COURSE_COMMANDS) {
    test(`tier 0: ${command.name} <ou> --json exits 0 (empty allowed)`, async (t) => {
      const ou = (await course()).id;
      const run = await bs(command.args(ou));
      assertExit(run, 0);
      const items = itemsOf(run);
      t.diagnostic(`${command.name} ou=${ou}: ${items.length} items in ${run.ms} ms`);
    });
  }

  // ── the workflow command and the escape hatch ───────────────────────────────────────────────

  test('tier 0: upcoming --json exits 0 and only past-term 403s land in failures', async (t) => {
    const run = await bs(['upcoming', '--json']);
    assertExit(run, 0);
    const envelope = parseJsonStdout<{
      items: unknown[];
      failures: Array<{ courseId: number | null; status: number | null; message: string }>;
    }>(run);
    assert.ok(Array.isArray(envelope.items), describeRun(run));
    const failures = envelope.failures ?? [];
    const notPastTerm = failures.filter((f) => f.status !== 403);
    assert.deepEqual(
      notPastTerm,
      [],
      `upcoming reported failures that are not past-term 403s: ${JSON.stringify(notPastTerm)}`,
    );
    t.diagnostic(
      `${envelope.items.length} upcoming items; ${failures.length} past-term, skipped (403)`,
    );
  });

  test('tier 0: api GET /d2l/api/lp/<lp>/users/whoami agrees with bs whoami', async (t) => {
    const [mine, raw] = await Promise.all([
      bs(['whoami', '--json']),
      bs(['api', 'GET', `/d2l/api/lp/${LP_VERSION}/users/whoami`, '--json']),
    ]);
    assertExit(mine, 0);
    assertExit(raw, 0);
    const curated = parseJsonStdout<{ id: number; uniqueName: string | null }>(mine);
    const payload = parseJsonStdout<{ Identifier: string; UniqueName: string }>(raw);
    assert.equal(Number(payload.Identifier), curated.id, 'Identifier != whoami.id');
    if (curated.uniqueName !== null) {
      assert.equal(payload.UniqueName, curated.uniqueName);
    }
    t.diagnostic(`lp ${LP_VERSION}: Identifier=${payload.Identifier}`);
  });

  // ── deep links (bs-fwr) ─────────────────────────────────────────────────────────────────────

  /**
   * bs-fwr: `discussionsUrl`, `discussionTopicUrl` and `calendarUrl` were written from standard
   * D2L paths with no live capture behind them. A wrong template is a 404, so every generated
   * link is fetched once with the session cookies (these are web routes: the Bearer means nothing
   * to them, the `d2lSessionVal` cookies do) and only 404 fails. A redirect to the login page is
   * still a real route, and 403 is the past-term steady state.
   */
  test('tier 0: generated deep links respond non-404 (bs-fwr)', async (t) => {
    const s = await session();
    const ou = (await course()).id;
    const base = s.baseUrl;
    const http = createHttp({ timeoutMs: 30_000 });

    const targets: Array<{ label: string; url: string }> = [
      { label: 'course home', url: (await course()).url },
      { label: 'discussions list (bs-fwr)', url: discussionsUrl(base, ou) },
      { label: 'calendar (bs-fwr)', url: calendarUrl(base, ou) },
    ];

    const fromFirstRow = async (label: string, args: string[]) => {
      const run = await bs(args);
      if (run.code !== 0) return;
      const first = itemsOf<{ url?: unknown }>(run)[0];
      if (first && typeof first.url === 'string' && first.url.startsWith('http')) {
        targets.push({ label, url: first.url });
      }
    };
    await fromFirstRow('assignment', ['assignments', 'list', String(ou), '--json']);
    await fromFirstRow('quiz', ['quizzes', 'list', String(ou), '--json']);
    await fromFirstRow('discussion topic (bs-fwr)', [
      'discussions',
      'topics',
      String(ou),
      '--json',
    ]);
    await fromFirstRow('calendar event', ['calendar', 'events', String(ou), '--json']);

    const dead: string[] = [];
    for (const target of targets) {
      const res = await http.request({
        method: 'HEAD',
        url: target.url,
        headers: { cookie: s.cookieHeader, 'x-csrf-token': s.csrfToken },
      });
      t.diagnostic(`${res.status} ${target.label}: ${target.url}`);
      if (!isDeepLinkAlive(res.status)) dead.push(`${target.label} -> 404 ${target.url}`);
    }
    assert.deepEqual(dead, [], `deep-link templates that 404: ${dead.join('; ')}`);
  });

  // ── the output contract (PRD 6.1) ───────────────────────────────────────────────────────────

  test('tier 0: --wrap-untrusted marks a fetched text field', async () => {
    const run = await bs(['courses', 'list', '--json', '--wrap-untrusted']);
    assertExit(run, 0);
    assert.match(run.stdout, /<<<EXTERNAL_UNTRUSTED_CONTENT id="/, describeRun(run));
    assert.match(run.stdout, /<<<END_EXTERNAL_UNTRUSTED_CONTENT id="/, describeRun(run));
  });

  test('tier 0: --plain writes a TSV header row', async () => {
    const run = await bs(['courses', 'list', '--plain']);
    assertExit(run, 0);
    const header = run.stdout.split('\n')[0] ?? '';
    assert.ok(header.includes('\t'), `expected a tab-separated header, got: ${header}`);
    assert.ok(header.startsWith('id\t'), `expected the header to start with id, got: ${header}`);
  });

  test('tier 0: --select narrows every item to the named fields', async () => {
    const run = await bs(['courses', 'list', '--json', '--results-only', '--select', 'id,name']);
    assertExit(run, 0);
    const items = parseJsonStdout<Array<Record<string, unknown>>>(run);
    assert.ok(items.length > 0, describeRun(run));
    for (const item of items) {
      assert.deepEqual(Object.keys(item).sort(), ['id', 'name'], JSON.stringify(item));
    }
  });

  test('tier 0: --fail-empty exits 3 on a list that is genuinely empty', async (t) => {
    const ou = (await course()).id;
    // Calendar is empty on this tenant (Brightspace-Bar A-21) and a far-future `--since` empties
    // announcements; either one proves the flag. Both being non-empty is itself worth reporting.
    const candidates: Array<{ label: string; args: string[] }> = [
      { label: 'calendar events', args: ['calendar', 'events', String(ou), '--json'] },
      {
        label: 'announcements --since 2999-01-01',
        args: ['announcements', 'list', String(ou), '--since', '2999-01-01', '--json'],
      },
    ];
    const tried: string[] = [];
    for (const candidate of candidates) {
      const plain = await bs(candidate.args);
      if (plain.code !== 0) {
        tried.push(`${candidate.label}: exit ${plain.code}`);
        continue;
      }
      if (itemsOf(plain).length > 0) {
        tried.push(`${candidate.label}: not empty`);
        continue;
      }
      const failEmpty = await bs([...candidate.args, '--fail-empty']);
      assertExit(failEmpty, 3);
      assert.equal(itemsOf(failEmpty).length, 0, 'the empty output is still written before exit 3');
      t.diagnostic(`--fail-empty proven on ${candidate.label}`);
      return;
    }
    assert.fail(
      `no candidate list was empty, so --fail-empty was not exercised: ${tried.join('; ')}`,
    );
  });
}
