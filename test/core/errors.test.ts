import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  AuthRequiredError,
  BsError,
  CancelledError,
  ConfigError,
  EmptyResultsError,
  EXIT_CODES,
  exitCodeFor,
  formatError,
  isSilent,
  NotFoundError,
  PermissionDeniedError,
  RateLimitedError,
  RetryableError,
  UsageError,
} from '../../src/core/errors.js';

test('EXIT_CODES is the PRD 6.4 table', () => {
  assert.deepEqual(EXIT_CODES, {
    ok: 0,
    error: 1,
    usage: 2,
    empty_results: 3,
    auth_required: 4,
    not_found: 5,
    permission_denied: 6,
    rate_limited: 7,
    retryable: 8,
    config: 10,
    cancelled: 130,
  });
});

test('each error class maps to its exit code', () => {
  assert.equal(exitCodeFor(new UsageError('u')), 2);
  assert.equal(exitCodeFor(new EmptyResultsError()), 3);
  assert.equal(exitCodeFor(new AuthRequiredError('a')), 4);
  assert.equal(exitCodeFor(new NotFoundError('n')), 5);
  assert.equal(exitCodeFor(new PermissionDeniedError('p')), 6);
  assert.equal(exitCodeFor(new RateLimitedError('r')), 7);
  assert.equal(exitCodeFor(new RetryableError('r')), 8);
  assert.equal(exitCodeFor(new ConfigError('c')), 10);
  assert.equal(exitCodeFor(new CancelledError()), 130);
  assert.equal(exitCodeFor(new BsError('error', 'generic')), 1);
  assert.equal(new BsError('not_found', 'x').exitCode, 5);
});

test('commander usage errors map to 2, help/version display to 0', () => {
  const commanderLike = (code: string) => Object.assign(new Error('x'), { code, exitCode: 1 });
  for (const code of [
    'commander.unknownOption',
    'commander.unknownCommand',
    'commander.missingArgument',
    'commander.optionMissingArgument',
    'commander.missingMandatoryOptionValue',
    'commander.excessArguments',
    'commander.invalidArgument',
    'commander.conflictingOption',
    'commander.help',
  ]) {
    assert.equal(exitCodeFor(commanderLike(code)), 2, code);
  }
  assert.equal(exitCodeFor(commanderLike('commander.helpDisplayed')), 0);
  assert.equal(exitCodeFor(commanderLike('commander.version')), 0);
});

test('unknown failures are 1; AbortError is cancelled', () => {
  assert.equal(exitCodeFor(new Error('boom')), 1);
  assert.equal(exitCodeFor('string'), 1);
  assert.equal(exitCodeFor(undefined), 1);
  const abort = new Error('aborted');
  abort.name = 'AbortError';
  assert.equal(exitCodeFor(abort), 130);
});

test('formatError: diagnosis line, blank line, indented next step', () => {
  assert.equal(
    formatError(new AuthRequiredError('No Brightspace session.')),
    'bs: No Brightspace session.\n\n  Run: bs auth login',
  );
  assert.equal(
    formatError(new NotFoundError('nope', { hint: 'Check the id' })),
    'bs: nope\n\n  Check the id',
  );
  assert.equal(formatError(new Error('plain')), 'bs: plain');
  assert.equal(formatError('weird'), 'bs: weird');
});

test('silent errors carry an exit code but print nothing', () => {
  assert.equal(isSilent(new EmptyResultsError()), true);
  assert.equal(isSilent(new CancelledError()), true);
  assert.equal(isSilent(new UsageError('x')), false);
  assert.equal(isSilent(new Error('x')), false);
});

test('errors preserve cause and are instanceof Error', () => {
  const cause = new Error('inner');
  const err = new RetryableError('outer', { cause });
  assert.equal(err.cause, cause);
  assert.ok(err instanceof Error);
  assert.ok(err instanceof BsError);
  assert.equal(err.name, 'RetryableError');
});
