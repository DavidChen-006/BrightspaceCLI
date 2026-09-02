/**
 * Date helpers for the D2L wire format (d2l-api-web Extra D).
 *
 * UTCDateTime on input is `yyyy-MM-ddTHH:mm:ss.fffZ` with the milliseconds mandatory;
 * `Date.prototype.toISOString()` complies. On output D2L is inconsistent
 * (`2026-03-01T04:59:00.000Z` and `2026-09-15T23:59:00Z` both occur), so readers normalise to
 * whole-second UTC and treat anything unreadable as "no date".
 */
import { UsageError } from './errors.js';

/** Renders a Date as a D2L UTCDateTime query value. */
export function toD2lDateTime(date: Date): string {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) {
    throw new UsageError('invalid date', {
      hint: 'Use an ISO-8601 timestamp such as 2026-09-02T00:00:00Z',
    });
  }
  return date.toISOString();
}

/**
 * Ported from Brightspace-Bar `session-capture/src/fetch-engine.mjs` (bottom): accepts an
 * ISO-8601 timestamp with optional fractional seconds and a `Z` or numeric offset.
 */
const ISO_8601 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:?\d{2})$/;

/** Whole-second UTC (`yyyy-MM-ddTHH:mm:ssZ`) for a D2L date string; null when unreadable. */
export function isoSeconds(raw: unknown): string | null {
  if (typeof raw !== 'string' || !ISO_8601.test(raw)) return null;
  const at = new Date(raw);
  return Number.isNaN(at.getTime()) ? null : `${at.toISOString().slice(0, 19)}Z`;
}

/** Whole-second UTC (`yyyy-MM-ddTHH:mm:ssZ`) for an epoch-millisecond instant. */
export function isoAtMs(ms: number): string {
  return `${new Date(ms).toISOString().slice(0, 19)}Z`;
}
