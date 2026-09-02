import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isoSeconds, toD2lDateTime } from '../../src/core/dates.js';
import { UsageError } from '../../src/core/errors.js';

test('toD2lDateTime renders yyyy-MM-ddTHH:mm:ss.fffZ (milliseconds required by D2L)', () => {
  assert.equal(
    toD2lDateTime(new Date(Date.UTC(2026, 8, 2, 4, 59, 0, 0))),
    '2026-09-02T04:59:00.000Z',
  );
  assert.equal(toD2lDateTime(new Date('2026-03-01T04:59:00.123Z')), '2026-03-01T04:59:00.123Z');
  assert.equal(toD2lDateTime(new Date(0)), '1970-01-01T00:00:00.000Z');
});

test('toD2lDateTime rejects an invalid date with a UsageError', () => {
  assert.throws(() => toD2lDateTime(new Date('nope')), UsageError);
});

test('isoSeconds normalizes D2L date strings to whole-second UTC', () => {
  assert.equal(isoSeconds('2026-03-01T04:59:00.000Z'), '2026-03-01T04:59:00Z');
  assert.equal(isoSeconds('2026-09-15T23:59:00Z'), '2026-09-15T23:59:00Z');
  assert.equal(
    isoSeconds('2026-09-15T23:59:00.999Z'),
    '2026-09-15T23:59:00Z',
    'truncates, never rounds',
  );
  assert.equal(isoSeconds('2026-09-15T19:59:00-04:00'), '2026-09-15T23:59:00Z');
  assert.equal(isoSeconds('2026-09-15T19:59:00.5-0400'), '2026-09-15T23:59:00Z');
});

test('isoSeconds yields null for anything unreadable (fail-open)', () => {
  for (const raw of [
    null,
    undefined,
    42,
    '',
    '2026-09-15',
    '2026-09-15T23:59:00',
    'yesterday',
    '2026-13-45T00:00:00Z',
    {},
  ]) {
    assert.equal(isoSeconds(raw), null, JSON.stringify(raw));
  }
});
