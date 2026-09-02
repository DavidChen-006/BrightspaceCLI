import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const REPO = fileURLToPath(new URL('../../', import.meta.url));
const PROBE = path.join(REPO, 'test', 'helpers', 'playwright-probe.ts');

interface ProbeResult {
  mode: string;
  argv: string[];
  code: number;
  loaded: boolean;
  sample: string[];
}

async function probe(args: string[], root: string): Promise<ProbeResult> {
  const { stdout } = await exec(process.execPath, ['--import', 'tsx', PROBE, ...args], {
    cwd: REPO,
    env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', BS_ROOT: root },
    timeout: 120_000,
  });
  return JSON.parse(stdout.trim()) as ProbeResult;
}

test('the probe detects playwright-core when it is imported (positive control)', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'bs-probe-'));
  try {
    const r = await probe(['control'], root);
    assert.equal(r.loaded, true, JSON.stringify(r));
    assert.ok(r.sample[0]?.includes('playwright-core'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('--help, version, schema and auth status never load playwright-core', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'bs-probe-'));
  try {
    const cases: [string[], number][] = [
      [['--help'], 0],
      [['version', '--json'], 0],
      [['schema', '--json'], 0],
      [['auth', 'status', '--json'], 4],
    ];
    const results = await Promise.all(
      cases.map(([argv]) => probe(['cli', ...argv], path.join(root, argv.join('-')))),
    );
    for (const [i, r] of results.entries()) {
      const [argv, code] = cases[i] as [string[], number];
      assert.equal(r.code, code, `${argv.join(' ')}: ${JSON.stringify(r)}`);
      assert.equal(
        r.loaded,
        false,
        `${argv.join(' ')} loaded playwright-core: ${JSON.stringify(r.sample)}`,
      );
    }
    assert.equal(existsSync(path.join(root, '--help')), false, '--help created no state');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
