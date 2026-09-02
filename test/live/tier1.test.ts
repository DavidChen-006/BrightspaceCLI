/**
 * Live tier 1 and the tier-2 record (PRD 7 rungs 1–2, PRD 12 "Live").
 *
 * Tier 1 — the silent rung. `session.json` is deleted while `profile/` survives, and
 * `bs auth refresh` has to re-mint from the ~90-day Entra profile with no window and no human.
 * It launches headless Chromium, so it is opt-in on top of `BS_LIVE`:
 *
 *   npm run build
 *   BS_LIVE=1 BS_LIVE_TIER=1 BS_ROOT="$HOME/Library/Application Support/bs" npm run test:live
 *
 * The real root is never mutated: it is copied to a throwaway directory first (profile included —
 * that is the point of the tier) and the copy is what loses its session. `BS_LIVE_KEEP=1` leaves
 * the copy behind for inspection.
 *
 * Tier 2 — from an empty root, `bs auth login` with exactly one MFA number typed into
 * Authenticator. It is MANUAL and stays manual: it costs a human and an MFA tap, it cannot assert
 * anything the other tiers do not, and automating it would mean parking credentials somewhere.
 * See the skipped test at the bottom for the exact commands.
 */
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdtempSync, rmSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  describeRun,
  liveGate,
  parseJsonStdout,
  requireBuild,
  requireLiveRoot,
  runBs,
} from './harness.js';

const gate = liveGate();
const tierOptIn = process.env.BS_LIVE_TIER === '1';

/** The silent rung goes to the network and drives a headless browser; 30 s of polling plus launch. */
const REFRESH_TIMEOUT_MS = 180_000;

if (!gate.enabled) {
  test('live tier 1', { skip: gate.reason }, () => {});
} else if (!tierOptIn) {
  test('live tier 1', {
    skip: 'BS_LIVE_TIER=1 not set — tier 1 launches headless Chromium on a copy of BS_ROOT',
  }, () => {});
} else {
  const ROOT = requireLiveRoot();
  requireBuild();

  test('tier 1: session.json deleted, profile kept -> auth refresh re-mints silently', async (t) => {
    const copy = mkdtempSync(path.join(tmpdir(), 'bs-live-tier1-'));
    try {
      cpSync(ROOT, copy, { recursive: true });
      const session = path.join(copy, 'session.json');
      assert.ok(existsSync(session), `the copy has no session.json at ${session}`);
      unlinkSync(session);
      assert.ok(
        existsSync(path.join(copy, 'profile')),
        'the copy has no profile/ — without the Entra wristband tier 1 IS tier 2',
      );
      t.diagnostic(`copied BS_ROOT to ${copy}; session.json deleted, profile/ intact`);

      const run = await runBs(['auth', 'refresh', '--json'], {
        root: copy,
        timeoutMs: REFRESH_TIMEOUT_MS,
      });
      assert.equal(run.code, 0, describeRun(run));
      const refreshed = parseJsonStdout<{ state: string; profileExists: boolean }>(run);
      assert.equal(refreshed.state, 'fresh', describeRun(run));
      assert.equal(refreshed.profileExists, true, 'the refresh must not consume the profile');
      assert.ok(existsSync(session), 'auth refresh wrote no session.json');
      t.diagnostic(`silent rung re-minted in ${run.ms} ms`);

      // PRD 12's Definition of done states the recovery in terms of `bs auth status`; status
      // itself never climbs above rung 0 (AGENTS.md, auth.ts), so the claim is checked here,
      // after the refresh has restored the session.
      const status = await runBs(['auth', 'status', '--json'], { root: copy });
      assert.equal(status.code, 0, describeRun(status));
      assert.equal(parseJsonStdout<{ state: string }>(status).state, 'fresh');
    } finally {
      if (process.env.BS_LIVE_KEEP === '1') {
        t.diagnostic(`BS_LIVE_KEEP=1 — the copy survives at ${copy}`);
      } else {
        rmSync(copy, { recursive: true, force: true });
      }
    }
  });

  test('tier 2 (manual): empty root -> bs auth login, exactly one MFA', {
    skip:
      'tier 2 is never automated: it costs a human and one MFA tap. Run it by hand:\n' +
      '  export BS_ROOT="$(mktemp -d)/bs"\n' +
      '  node dist/bin/bs.js auth login --json      # type the relayed number into Authenticator\n' +
      '  node dist/bin/bs.js whoami --json          # then tier 0 against that root',
  }, () => {});
}
