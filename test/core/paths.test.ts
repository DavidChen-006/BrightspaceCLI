import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import envPaths from 'env-paths';
import { ensureDirs, platformDataDir, resolvePaths, resolveRoot } from '../../src/core/paths.js';

test('BS_ROOT env overrides the platform default', () => {
  const p = resolvePaths({
    env: { BS_ROOT: '/tmp/bs-env-root' },
    platform: 'darwin',
    homedir: '/Users/x',
  });
  assert.equal(p.root, path.resolve('/tmp/bs-env-root'));
  assert.equal(p.source, 'env');
});

test('--root beats BS_ROOT and relative roots resolve against cwd', () => {
  const p = resolvePaths({
    root: 'rel/root',
    cwd: '/work',
    env: { BS_ROOT: '/tmp/bs-env-root' },
    platform: 'linux',
    homedir: '/home/x',
  });
  assert.equal(p.root, path.resolve('/work', 'rel/root'));
  assert.equal(p.source, 'flag');
});

test('empty BS_ROOT is treated as unset', () => {
  const p = resolveRoot({ env: { BS_ROOT: '' }, platform: 'darwin', homedir: '/Users/x' });
  assert.equal(p.source, 'default');
});

test('darwin default is ~/Library/Application Support/bs', () => {
  const p = resolveRoot({ env: {}, platform: 'darwin', homedir: '/Users/x' });
  assert.equal(p.root, path.join('/Users/x', 'Library', 'Application Support', 'bs'));
  assert.equal(p.source, 'default');
});

test('linux default honors XDG_DATA_HOME, else ~/.local/share/bs', () => {
  assert.equal(
    resolveRoot({ env: { XDG_DATA_HOME: '/xdg/data' }, platform: 'linux', homedir: '/home/x' })
      .root,
    path.join('/xdg/data', 'bs'),
  );
  assert.equal(
    resolveRoot({ env: {}, platform: 'linux', homedir: '/home/x' }).root,
    path.join('/home/x', '.local', 'share', 'bs'),
  );
});

test('win32 default is %LOCALAPPDATA%\\bs\\Data', () => {
  const local = 'C:\\Users\\x\\AppData\\Local';
  assert.equal(
    resolveRoot({ env: { LOCALAPPDATA: local }, platform: 'win32', homedir: 'C:\\Users\\x' }).root,
    path.join(local, 'bs', 'Data'),
  );
  assert.equal(
    resolveRoot({ env: {}, platform: 'win32', homedir: 'C:\\Users\\x' }).root,
    path.join('C:\\Users\\x', 'AppData', 'Local', 'bs', 'Data'),
  );
});

test('the injectable resolver mirrors env-paths on this platform', () => {
  assert.equal(
    platformDataDir(process.platform, os.homedir(), process.env),
    envPaths('bs', { suffix: '' }).data,
  );
});

test('resolvePaths without injection uses env-paths (unless BS_ROOT is set)', () => {
  const p = resolvePaths({ env: {} });
  assert.equal(p.root, envPaths('bs', { suffix: '' }).data);
});

test('every PRD 8.1 file path hangs off the root', () => {
  const p = resolvePaths({ env: { BS_ROOT: '/r' } });
  const root = path.resolve('/r');
  assert.deepEqual(
    {
      profileDir: p.profileDir,
      sessionFile: p.sessionFile,
      credentialsFile: p.credentialsFile,
      configFile: p.configFile,
      cacheDir: p.cacheDir,
      mfaFile: p.mfaFile,
      statusFile: p.statusFile,
    },
    {
      profileDir: path.join(root, 'profile'),
      sessionFile: path.join(root, 'session.json'),
      credentialsFile: path.join(root, 'credentials.json'),
      configFile: path.join(root, 'config.json'),
      cacheDir: path.join(root, 'cache'),
      mfaFile: path.join(root, 'cache', 'mfa.json'),
      statusFile: path.join(root, 'cache', 'status.json'),
    },
  );
});

test('resolvePaths is pure: it never touches the filesystem', () => {
  const base = mkdtempSync(path.join(os.tmpdir(), 'bs-paths-'));
  try {
    const root = path.join(base, 'never-created');
    resolvePaths({ env: { BS_ROOT: root } });
    assert.equal(existsSync(root), false);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('ensureDirs creates root, profile and cache with mode 0700 and is idempotent', () => {
  const base = mkdtempSync(path.join(os.tmpdir(), 'bs-paths-'));
  try {
    const p = resolvePaths({ env: { BS_ROOT: path.join(base, 'nested', 'root') } });
    ensureDirs(p);
    ensureDirs(p);
    for (const dir of [p.root, p.profileDir, p.cacheDir]) {
      const st = statSync(dir);
      assert.ok(st.isDirectory(), `${dir} is a directory`);
      if (process.platform !== 'win32') {
        assert.equal(st.mode & 0o777, 0o700, `${dir} mode`);
      }
    }
    assert.equal(existsSync(p.sessionFile), false, 'ensureDirs creates no files');
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
