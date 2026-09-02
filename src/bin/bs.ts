#!/usr/bin/env node
/**
 * Process boundary: the only file allowed to call process.exit. Everything else returns
 * exit codes from src/core/errors.ts through run().
 */
import { run } from '../cli/program.js';
import { EXIT_CODES } from '../core/errors.js';

process.on('SIGINT', () => {
  process.stderr.write('\n');
  process.exit(EXIT_CODES.cancelled);
});

// `bs ... | head` closes stdout early; that is not an error.
process.stdout.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EPIPE') process.exit(EXIT_CODES.ok);
  throw err;
});

const code = await run(process.argv.slice(2), {
  stdout: process.stdout,
  stderr: process.stderr,
  env: process.env,
  stdinIsTTY: Boolean(process.stdin.isTTY),
  stdoutIsTTY: Boolean(process.stdout.isTTY),
  stderrIsTTY: Boolean(process.stderr.isTTY),
  cwd: process.cwd(),
});
process.exitCode = code;
