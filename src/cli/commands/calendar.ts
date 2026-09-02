/**
 * `bs calendar events [ou...] [--from] [--to] [--type]` (PRD 6.2, 6.3). Goes through `withData`
 * (ladder, one re-mint) and the `src/d2l/calendar.ts` route.
 *
 * Without org units it resolves the caller's active course offerings via `listEnrollments`
 * (the `bs courses list` defaults) and sends their ids in `orgUnitIdsCSV`, 100 per request,
 * fanned out through a bounded pool (`BS_CONCURRENCY`) with per-chunk isolation. The window
 * defaults to now → +30 days. This tenant answers an empty page (instructors never opt in), so
 * an empty list is exit 0 (3 under --fail-empty).
 */
import { type Command, InvalidArgumentError, Option } from 'commander';
import { isoSeconds } from '../../core/dates.js';
import { AuthRequiredError, BsError, CancelledError, UsageError } from '../../core/errors.js';
import { boundedPool, collect } from '../../core/http/index.js';
import { type Column, type Row, Table } from '../../core/output.js';
import {
  type CalendarEvent,
  EVENT_TYPE_NAMES,
  type EventTypeName,
  eventOf,
  listMyEvents,
  MAX_ORG_UNITS_PER_REQUEST,
} from '../../d2l/calendar.js';
import { courseOf, listEnrollments } from '../../d2l/courses.js';
import type { CliContext } from '../context.js';
import { emitList, listEnvelope, withData } from '../data.js';
import { parsePositiveInt, typed } from '../options.js';
import { parseOrgUnit } from './courses.js';

export const DEFAULT_WINDOW_DAYS = 30;
const DAY_MS = 86_400_000;

/** `--from`/`--to`: an ISO-8601 date (`2026-09-02`, UTC midnight) or timestamp. */
export function parseDate(value: string): Date {
  const v = value.trim();
  const iso = /^\d{4}-\d{2}-\d{2}$/.test(v) ? `${v}T00:00:00Z` : v;
  const m = /^(\d{4})-(\d{2})-(\d{2})T/.exec(iso);
  const date = new Date(iso);
  const calendarOk =
    m !== null &&
    Number(m[2]) >= 1 &&
    Number(m[2]) <= 12 &&
    Number(m[3]) >= 1 &&
    Number(m[3]) <= new Date(Date.UTC(Number(m[1]), Number(m[2]), 0)).getUTCDate();
  if (!calendarOk || isoSeconds(iso) === null) {
    throw new InvalidArgumentError(
      'expected an ISO-8601 date (2026-09-02) or timestamp (2026-09-02T00:00:00Z).',
    );
  }
  return date;
}

/** Variadic `[ou...]`: commander folds each value through this with the previous list. */
function collectOrgUnits(value: string, previous: number[] = []): number[] {
  return [...previous, parseOrgUnit(value)];
}

/** `--plain` flattens `associated` into three columns. */
export const EVENT_COLUMNS: readonly (
  | keyof CalendarEvent
  | 'associatedType'
  | 'associatedId'
  | 'associatedLink'
)[] = [
  'id',
  'courseId',
  'courseCode',
  'title',
  'description',
  'start',
  'end',
  'allDay',
  'type',
  'associatedType',
  'associatedId',
  'associatedLink',
  'url',
];

function eventRow(e: CalendarEvent): Row {
  return {
    id: e.id,
    courseId: e.courseId,
    courseCode: e.courseCode,
    title: e.title,
    description: e.description,
    start: e.start,
    end: e.end,
    allDay: e.allDay,
    type: e.type,
    associatedType: e.associated?.type ?? null,
    associatedId: e.associated?.id ?? null,
    associatedLink: e.associated?.link ?? null,
    url: e.url,
  };
}

function eventTable(rows: readonly CalendarEvent[], from: Date, to: Date): string {
  if (rows.length === 0) {
    return `No calendar events between ${isoSeconds(from.toISOString())} and ${isoSeconds(to.toISOString())}.\n`;
  }
  const table = new Table(['ID', 'START', 'END', 'TYPE', 'COURSE', 'TITLE']);
  for (const e of rows) {
    table.row([
      e.id,
      e.start ?? '',
      e.end ?? '',
      e.type ?? '',
      e.courseCode ?? e.courseId ?? '',
      e.title,
    ]);
  }
  return table.render();
}

function isFatal(err: unknown): boolean {
  return (
    err instanceof AuthRequiredError || err instanceof CancelledError || !(err instanceof BsError)
  );
}

function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

interface EventsOptions {
  from?: Date;
  to?: Date;
  type?: EventTypeName;
  limit?: number;
  raw?: boolean;
}

export function register(program: Command, ctx: CliContext): void {
  const cmd = program.command('calendar').description('Calendar events across your courses');

  cmd
    .command('events')
    .description(
      'Calendar events in a window (default: now to +30 days) for the given courses, or every active course. Empty on tenants where instructors do not publish to the calendar.',
    )
    .argument(
      '[ou...]',
      'org unit ids (default: every active course from your enrollments)',
      collectOrgUnits,
    )
    .addOption(
      typed(
        new Option(
          '--from <date>',
          'window start, ISO-8601 date or timestamp (default: now)',
        ).argParser(parseDate),
        'string',
      ),
    )
    .addOption(
      typed(
        new Option(
          '--to <date>',
          `window end, ISO-8601 date or timestamp (default: --from + ${DEFAULT_WINDOW_DAYS} days)`,
        ).argParser(parseDate),
        'string',
      ),
    )
    .addOption(
      typed(
        new Option('--type <kind>', 'only one EVENTTYPE_T kind (due = eventType 6)').choices([
          ...EVENT_TYPE_NAMES,
        ]),
        'string',
      ),
    )
    .addOption(
      typed(
        new Option('--limit <n>', 'stop after n events (no further pages fetched)').argParser(
          parsePositiveInt,
        ),
        'number',
      ),
    )
    .option('--raw', 'emit the EventDataInfo objects as D2L sent them')
    .action(async (ous: number[] | undefined, opts: EventsOptions) => {
      const startedAt = Date.now();
      const from = opts.from ?? new Date(startedAt);
      const to = opts.to ?? new Date(from.getTime() + DEFAULT_WINDOW_DAYS * DAY_MS);
      if (to.getTime() <= from.getTime()) {
        throw new UsageError(
          `--to (${to.toISOString()}) must be after --from (${from.toISOString()})`,
        );
      }
      const page = { warn: (m: string) => ctx.warn(m) };

      const { raw, baseUrl } = await withData(ctx, async (http, cfg) => {
        let ids = ous ?? [];
        if (ids.length === 0) {
          const enrollments = await collect(listEnrollments(http, cfg, { now: from }, page));
          ids = enrollments
            .map((e) => courseOf(e, cfg.baseUrl)?.id)
            .filter((id): id is number => id !== undefined);
          if (ids.length === 0) {
            ctx.warn('no active course in your enrollments; nothing to ask the calendar for');
            return { raw: [] as unknown[], baseUrl: cfg.baseUrl };
          }
        }
        const chunks = chunk(ids, MAX_ORG_UNITS_PER_REQUEST);
        const results = await boundedPool(chunks, cfg.concurrency, (orgUnitIds) =>
          collect(
            listMyEvents(http, cfg, { orgUnitIds, from, to, eventType: opts.type }, page),
            opts.limit,
          ),
        );
        const failures: BsError[] = [];
        const raw: unknown[] = [];
        for (const r of results) {
          if (r.ok) raw.push(...r.value);
          else if (isFatal(r.error)) throw r.error;
          else failures.push(r.error as BsError);
        }
        if (failures.length === chunks.length) throw failures[0];
        for (const f of failures) ctx.warn(`${f.message}; the events of those courses are omitted`);
        return { raw: raw.slice(0, opts.limit), baseUrl: cfg.baseUrl };
      });

      if (opts.raw) {
        emitList(ctx, listEnvelope(raw, startedAt), { raw: true });
        return;
      }
      const items: CalendarEvent[] = [];
      let skipped = 0;
      for (const item of raw) {
        const event = eventOf(item, baseUrl);
        if (event === null) skipped += 1;
        else items.push(event);
      }
      if (skipped > 0 && items.length === 0) {
        throw new BsError('error', `none of ${raw.length} event(s) was decodable`, {
          hint: 'Run: bs calendar events <ou> --raw  to inspect the payload, or bs auth doctor',
        });
      }
      if (skipped > 0) ctx.warn(`skipped ${skipped} undecodable event(s) of ${raw.length}`);
      emitList(ctx, listEnvelope(items, startedAt), {
        tsv: { columns: EVENT_COLUMNS as readonly (string | Column)[], rows: items.map(eventRow) },
        human: () => eventTable(items, from, to),
      });
    });
}
