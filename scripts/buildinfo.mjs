#!/usr/bin/env node
// Writes dist/buildinfo.json ({commit, date}) after tsc. Best effort: when git is missing
// or this is not a checkout, commit is "unknown". Never fails the build.
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function git(args) {
  try {
    return execFileSync('git', args, {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5000,
    }).trim();
  } catch {
    return '';
  }
}

let commit = git(['rev-parse', '--short=12', 'HEAD']) || 'unknown';
if (commit !== 'unknown' && git(['status', '--porcelain', '--untracked-files=no']) !== '') {
  commit += '-dirty';
}
const date = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');

const dist = path.join(root, 'dist');
mkdirSync(dist, { recursive: true });
writeFileSync(path.join(dist, 'buildinfo.json'), `${JSON.stringify({ commit, date }, null, 2)}\n`);
