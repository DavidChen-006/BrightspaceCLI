/**
 * Hermetic tests for `scripts/e2e.sh`'s refusals (bs-bo2).
 *
 * The script talks to the real tenant, so the one thing that must be provable without one is that
 * it does NOT: without `BS_LIVE=1` (and without `BS_ROOT`) it exits 2 having built nothing,
 * spawned nothing and created nothing. The script checks argv and the environment before it
 * touches the filesystem, which is what makes spawning it here safe.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(fileURLToPath(new URL('../../', import.meta.url)));
const SCRIPT = path.join(REPO_ROOT, 'scripts', 'e2e.sh');

interface ShResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Runs the script with an environment built from scratch: nothing from this shell leaks in. */
function runScript(args: string[], env: NodeJS.ProcessEnv = {}): Promise<ShResult> {
  return new Promise((resolve, reject) => {
    const child = spawn('bash', [SCRIPT, ...args], {
      cwd: REPO_ROOT,
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: process.env.HOME ?? '/tmp', ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (c: string) => {
      stdout += c;
    });
    child.stderr.on('data', (c: string) => {
      stderr += c;
    });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

test('scripts/e2e.sh exists and is executable', () => {
  assert.ok(existsSync(SCRIPT), `${SCRIPT} is missing`);
  assert.equal(statSync(SCRIPT).mode & 0o111, 0o111, 'the script is not executable');
});

test('scripts/e2e.sh without BS_LIVE exits 2 and says nothing ran', async () => {
  const result = await runScript([]);
  assert.equal(result.code, 2, result.stderr);
  assert.match(result.stderr, /REFUSED/);
  assert.match(result.stderr, /BS_LIVE=1 is required/);
  assert.match(result.stderr, /Nothing was run, built or created/);
});

test('scripts/e2e.sh with BS_LIVE but no BS_ROOT exits 2 naming BS_ROOT', async () => {
  const result = await runScript([], { BS_LIVE: '1' });
  assert.equal(result.code, 2, result.stderr);
  assert.match(result.stderr, /BS_ROOT is required/);
});

test('scripts/e2e.sh rejects an unknown argument before checking the environment', async () => {
  const result = await runScript(['--wat']);
  assert.equal(result.code, 2, result.stderr);
  assert.match(result.stderr, /unknown argument: --wat/);
});

test('scripts/e2e.sh --tier only accepts 1; tier 2 stays manual', async () => {
  const result = await runScript(['--tier', '2']);
  assert.equal(result.code, 2, result.stderr);
  assert.match(result.stderr, /tier 2 is manual/);
});

test('scripts/e2e.sh --help documents the tiers and the required environment', async () => {
  const result = await runScript(['--help']);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /--tier 1/);
  assert.match(result.stdout, /BS_LIVE=1/);
  assert.match(result.stdout, /BS_ROOT/);
  assert.match(result.stdout, /TIER 2 IS MANUAL/);
});
