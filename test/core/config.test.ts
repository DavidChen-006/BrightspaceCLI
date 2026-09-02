import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { CONFIG_ENV, DEFAULT_CONFIG, loadConfig, readConfigFile } from '../../src/core/config.js';
import { ConfigError } from '../../src/core/errors.js';

function withTempDir<T>(fn: (dir: string) => T): T {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'bs-config-'));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('defaults match PRD 8.3', () => {
  assert.deepEqual(DEFAULT_CONFIG, {
    baseUrl: 'https://purdue.brightspace.com',
    campusText: 'Purdue West Lafayette',
    lpVersion: '1.62',
    leVersion: '1.96',
    courseTypeId: 3,
    browserChannel: 'chromium',
    concurrency: 4,
  });
  assert.deepEqual(loadConfig({ env: {} }), DEFAULT_CONFIG);
});

test('every knob has a BS_* env name', () => {
  assert.deepEqual(CONFIG_ENV, {
    baseUrl: 'BS_BASE_URL',
    campusText: 'BS_CAMPUS_TEXT',
    lpVersion: 'BS_LP_VERSION',
    leVersion: 'BS_LE_VERSION',
    courseTypeId: 'BS_COURSE_TYPE_ID',
    browserChannel: 'BS_BROWSER_CHANNEL',
    concurrency: 'BS_CONCURRENCY',
  });
});

test('precedence: overrides > env > config.json > defaults', () => {
  const cfg = loadConfig({
    env: { BS_LP_VERSION: '1.70', BS_CONCURRENCY: '2', BS_BASE_URL: 'https://env.example.edu/' },
    file: {
      lpVersion: '1.65',
      leVersion: '1.90',
      concurrency: 9,
      baseUrl: 'https://file.example.edu',
    },
    overrides: { baseUrl: 'https://flag.example.edu' },
  });
  assert.equal(cfg.baseUrl, 'https://flag.example.edu');
  assert.equal(cfg.lpVersion, '1.70');
  assert.equal(cfg.leVersion, '1.90');
  assert.equal(cfg.concurrency, 2);
  assert.equal(cfg.campusText, DEFAULT_CONFIG.campusText);
});

test('baseUrl loses its trailing slash', () => {
  assert.equal(
    loadConfig({ env: { BS_BASE_URL: 'https://x.example.edu/' } }).baseUrl,
    'https://x.example.edu',
  );
});

test('a bad base URL is a config error (exit 10)', () => {
  assert.throws(
    () => loadConfig({ env: { BS_BASE_URL: 'not a url' } }),
    (err: unknown) =>
      err instanceof ConfigError && err.exitCode === 10 && /BS_BASE_URL/.test(err.message),
  );
});

test('numeric knobs are coerced and validated', () => {
  assert.equal(loadConfig({ env: { BS_COURSE_TYPE_ID: '7' } }).courseTypeId, 7);
  assert.throws(
    () => loadConfig({ env: { BS_CONCURRENCY: 'many' } }),
    (err: unknown) => err instanceof ConfigError && /BS_CONCURRENCY/.test(err.message),
  );
  assert.throws(
    () => loadConfig({ env: {}, file: { concurrency: 0 } }),
    (err: unknown) => err instanceof ConfigError && /concurrency/.test(err.message),
  );
});

test('config.json is optional: a missing file yields no overrides', () => {
  withTempDir((dir) => {
    const warnings: string[] = [];
    assert.deepEqual(
      readConfigFile(path.join(dir, 'config.json'), (m) => warnings.push(m)),
      {},
    );
    assert.deepEqual(warnings, []);
  });
});

test('config.json is tolerant: corrupt or non-object content is ignored with a warning', () => {
  withTempDir((dir) => {
    const file = path.join(dir, 'config.json');
    const warnings: string[] = [];
    writeFileSync(file, '{ not json');
    assert.deepEqual(
      readConfigFile(file, (m) => warnings.push(m)),
      {},
    );
    writeFileSync(file, '[1,2]');
    assert.deepEqual(
      readConfigFile(file, (m) => warnings.push(m)),
      {},
    );
    assert.equal(warnings.length, 2);
    assert.ok(warnings.every((w) => w.includes('config.json')));
  });
});

test('config.json values are read and unknown keys ignored', () => {
  withTempDir((dir) => {
    const file = path.join(dir, 'config.json');
    writeFileSync(file, JSON.stringify({ campusText: 'Purdue Fort Wayne', bogus: 1 }));
    const cfg = loadConfig({ env: {}, configFile: file });
    assert.equal(cfg.campusText, 'Purdue Fort Wayne');
    assert.equal('bogus' in cfg, false);
  });
});
