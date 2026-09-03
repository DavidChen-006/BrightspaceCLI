/**
 * `bs upcoming [--days N] [--kinds ...] [--course <ou>]... [--limit n]` (PRD 6.2, 6.3, 9).
 *
 * The one workflow command: every active course (the `bs courses list` defaults, or the
 * `--course` ids) is fanned out through `boundedPool(cfg.concurrency)`. One pool unit is either
 * a course (its `dropbox/folders/`, `quizzes/` and `discussions/forums/(id)/topics/` routes, run in
 * sequence so the pool bound is the number of requests in flight) or one
 * `content/myItems/due/?orgUnitIdsCSV=` chunk of at most 100 courses. Every unit isolates its
 * failures: a route failing costs only its items and lands in the envelope's `failures`; the
 * first 403 ends a course (Brightspace-Bar sweep: 403 is the steady state on 25/27 courses) and
 * its remaining routes are skipped. Denied courses are NAMED in ONE stderr line (the first three,
 * then a count), with per-course detail — and `forbiddenNote()`'s diagnosis — under --verbose;
 * other failures warn one line each. The command only fails when nothing at all succeeded and no
 * course was denied (then the first error is reported), or on auth/cancellation.
 * `src/d2l/upcoming.ts` owns the window/dedupe/sort.
 */
import { type Command, InvalidArgumentError, Option } from 'commander';
import type { TenantConfig } from '../../core/config.js';
import { AuthRequiredError, BsError, CancelledError } from '../../core/errors.js';
import { boundedPool, collect, type HttpClient } from '../../core/http/index.js';
import { type Column, Table } from '../../core/output.js';
import { type Assignment, assignmentOf, listFolders } from '../../d2l/assignments.js';
import { courseOf, listEnrollments } from '../../d2l/courses.js';
import {
  type DiscussionTopic,
  forumOf,
  listForums,
  listTopics,
  topicOf,
} from '../../d2l/discussions.js';
import { listQuizzes, type Quiz, quizOf } from '../../d2l/quizzes.js';
import {
  chunkOrgUnits,
  DEFAULT_UPCOMING_DAYS,
  listMyItemsDue,
  mergeUpcoming,
  scheduledItemOf,
  UPCOMING_COLUMNS,
  UPCOMING_KINDS,
  type UpcomingCandidate,
  type UpcomingFailure,
  type UpcomingItem,
  type UpcomingKind,
} from '../../d2l/upcoming.js';
import type { CliContext } from '../context.js';
import { emitList, forbiddenNote, httpStatusOf, listEnvelope, withData } from '../data.js';
import { parsePositiveInt, typed } from '../options.js';
import { parseOrgUnit } from './courses.js';

/** `--kinds a,b`: a non-empty comma-separated subset of the four kinds (order and case kept). */
export function parseKinds(value: string): UpcomingKind[] {
  const kinds = value
    .split(',')
    .map((k) => k.trim())
    .filter((k) => k.length > 0);
  if (kinds.length === 0) {
    throw new InvalidArgumentError(
      `expected a comma-separated list of ${UPCOMING_KINDS.join(', ')}.`,
    );
  }
  const bad = kinds.filter((k) => !(UPCOMING_KINDS as readonly string[]).includes(k));
  if (bad.length > 0) {
    throw new InvalidArgumentError(
      `unknown kind ${bad.join(', ')}; expected ${UPCOMING_KINDS.join(', ')}.`,
    );
  }
  return [...new Set(kinds)] as UpcomingKind[];
}

/** Repeatable `--course <ou>`: commander folds each value through this with the previous list. */
function collectCourses(value: string, previous: number[] = []): number[] {
  return [...previous, parseOrgUnit(value)];
}

interface UpcomingOptions {
  days?: number;
  kinds?: UpcomingKind[];
  course?: number[];
  limit?: number;
}

interface CourseRef {
  id: number;
  name: string | null;
  /** From the enrollment, for `forbiddenNote()`; unknown under `--course` (no listing).  */
  endDate: string | null;
  isActive: boolean;
}

type Unit = { kind: 'course'; course: CourseRef } | { kind: 'content'; ids: number[] };

interface UnitResult {
  assignments: Assignment[];
  quizzes: Quiz[];
  topics: DiscussionTopic[];
  content: UpcomingCandidate[];
  failures: UpcomingFailure[];
  /** The errors behind `failures`, in order, for the "nothing succeeded" case. */
  errors: BsError[];
  /** How many routes answered (a unit with none is "nothing succeeded"). */
  ok: number;
  skipped: number;
}

interface Fetched {
  result: ReturnType<typeof mergeUpcoming>;
  ok: number;
  firstError: BsError | null;
  /** Each fanned-out course's access window, so a 403 can be explained (bs-6j8). */
  terms: Map<number, { endDate: string | null; isActive: boolean }>;
}

function emptyResult(): UnitResult {
  return {
    assignments: [],
    quizzes: [],
    topics: [],
    content: [],
    failures: [],
    errors: [],
    ok: 0,
    skipped: 0,
  };
}

function isFatal(err: unknown): boolean {
  return (
    err instanceof AuthRequiredError || err instanceof CancelledError || !(err instanceof BsError)
  );
}

function failureOf(err: BsError, course: CourseRef | null): UpcomingFailure {
  return {
    courseId: course?.id ?? null,
    courseName: course?.name ?? null,
    status: httpStatusOf(err),
    message: err.message,
  };
}

/** One course: its routes in sequence, each isolated; the first 403 ends the course. */
async function fetchCourse(
  http: HttpClient,
  cfg: TenantConfig,
  course: CourseRef,
  kinds: ReadonlySet<UpcomingKind>,
  page: { warn: (m: string) => void },
): Promise<UnitResult> {
  const out = emptyResult();
  const ou = course.id;
  const routes: Array<() => Promise<void>> = [];
  if (kinds.has('assignment')) {
    routes.push(async () => {
      for (const raw of await listFolders(http, cfg, ou)) {
        const a = assignmentOf(raw, ou, cfg.baseUrl);
        if (a === null) out.skipped += 1;
        else out.assignments.push(a);
      }
    });
  }
  if (kinds.has('quiz')) {
    routes.push(async () => {
      for (const raw of await collect(listQuizzes(http, cfg, ou, page))) {
        const q = quizOf(raw, ou, cfg.baseUrl);
        if (q === null) out.skipped += 1;
        else out.quizzes.push(q);
      }
    });
  }
  if (kinds.has('discussion')) {
    routes.push(async () => {
      const forums: number[] = [];
      for (const raw of await listForums(http, cfg, ou)) {
        const f = forumOf(raw, ou, cfg.baseUrl);
        if (f === null) out.skipped += 1;
        else forums.push(f.id);
      }
      for (const forumId of forums) {
        for (const raw of await listTopics(http, cfg, ou, forumId)) {
          const t = topicOf(raw, ou, cfg.baseUrl, forumId);
          if (t === null) out.skipped += 1;
          else out.topics.push(t);
        }
      }
    });
  }
  for (const route of routes) {
    try {
      await route();
      out.ok += 1;
    } catch (err) {
      if (isFatal(err)) throw err;
      const failure = failureOf(err as BsError, course);
      out.failures.push(failure);
      out.errors.push(err as BsError);
      if (failure.status === 403) break;
    }
  }
  return out;
}

/** One `content/myItems/due/` chunk (at most 100 courses). */
async function fetchContentChunk(
  http: HttpClient,
  cfg: TenantConfig,
  ids: readonly number[],
  page: { warn: (m: string) => void },
): Promise<UnitResult> {
  const out = emptyResult();
  try {
    for (const raw of await collect(listMyItemsDue(http, cfg, ids, page))) {
      const c = scheduledItemOf(raw, cfg.baseUrl);
      if (c === null) out.skipped += 1;
      else out.content.push(c);
    }
    out.ok += 1;
  } catch (err) {
    if (isFatal(err)) throw err;
    const failure = failureOf(err as BsError, null);
    out.errors.push(err as BsError);
    out.failures.push({
      ...failure,
      message: `${failure.message} (content/myItems/due/ for ${ids.length} course${ids.length === 1 ? '' : 's'})`,
    });
  }
  return out;
}

function upcomingTable(items: readonly UpcomingItem[], days: number): string {
  if (items.length === 0) return `Nothing due in the next ${days} day${days === 1 ? '' : 's'}.\n`;
  const table = new Table(['DUE', 'KIND', 'COURSE', 'ID', 'TITLE']);
  for (const i of items) {
    table.row([i.dueDate, i.kind, i.courseName ?? i.courseId, i.id, i.title]);
  }
  return table.render();
}

export function register(program: Command, ctx: CliContext): void {
  program
    .command('upcoming')
    .description(
      'Everything due soon across your active courses: assignments, quizzes, discussion topics and content items with a due date in the window, sorted by due date. Courses that answer 403 are named on one stderr line and land in failures, never fatal.',
    )
    .addOption(
      typed(
        new Option('--days <n>', 'window length in days from now')
          .argParser(parsePositiveInt)
          .default(DEFAULT_UPCOMING_DAYS),
        'number',
      ),
    )
    .addOption(
      typed(
        new Option(
          '--kinds <list>',
          `comma-separated subset of ${UPCOMING_KINDS.join(',')} (default: all; only their routes are requested)`,
        ).argParser(parseKinds),
        'list',
      ),
    )
    .addOption(
      typed(
        new Option(
          '--course <ou>',
          'only this org unit (repeatable; skips the enrollment listing, so courseName is null)',
        ).argParser(collectCourses),
        'list',
      ),
    )
    .addOption(
      typed(
        new Option('--limit <n>', 'keep the first n items after sorting').argParser(
          parsePositiveInt,
        ),
        'number',
      ),
    )
    .action(async (opts: UpcomingOptions) => {
      const startedAt = Date.now();
      const now = new Date(startedAt);
      const days = opts.days ?? DEFAULT_UPCOMING_DAYS;
      const kinds = new Set<UpcomingKind>(opts.kinds ?? UPCOMING_KINDS);
      const page = { warn: (m: string) => ctx.warn(m) };

      const fetched = await withData(ctx, async (http, cfg): Promise<Fetched> => {
        let courses: CourseRef[];
        if (opts.course !== undefined && opts.course.length > 0) {
          courses = [...new Set(opts.course)].map((id) => ({
            id,
            name: null,
            endDate: null,
            isActive: false,
          }));
        } else {
          const enrollments = await collect(listEnrollments(http, cfg, { now }, page));
          courses = enrollments
            .map((e) => courseOf(e, cfg.baseUrl))
            .filter((c): c is NonNullable<typeof c> => c !== null)
            .map((c) => ({
              id: c.id,
              name: c.name === '' ? null : c.name,
              endDate: c.endDate,
              isActive: c.isActive,
            }));
          if (courses.length === 0) {
            ctx.warn('no active course in your enrollments; nothing to look for');
            return {
              result: mergeUpcoming({}, { now, days }),
              ok: 0,
              firstError: null,
              terms: new Map(),
            };
          }
        }
        const courseNames = new Map(courses.map((c) => [c.id, c.name]));
        const wantsCourseRoutes =
          kinds.has('assignment') || kinds.has('quiz') || kinds.has('discussion');
        const units: Unit[] = [
          ...(wantsCourseRoutes ? courses.map((course): Unit => ({ kind: 'course', course })) : []),
          ...(kinds.has('content')
            ? chunkOrgUnits(courses.map((c) => c.id)).map((ids): Unit => ({ kind: 'content', ids }))
            : []),
        ];
        const results = await boundedPool(units, cfg.concurrency, (unit) =>
          unit.kind === 'course'
            ? fetchCourse(http, cfg, unit.course, kinds, page)
            : fetchContentChunk(http, cfg, unit.ids, page),
        );
        const merged = emptyResult();
        for (const r of results) {
          if (!r.ok) throw r.error;
          merged.assignments.push(...r.value.assignments);
          merged.quizzes.push(...r.value.quizzes);
          merged.topics.push(...r.value.topics);
          merged.content.push(...r.value.content);
          merged.failures.push(...r.value.failures);
          merged.errors.push(...r.value.errors);
          merged.ok += r.value.ok;
          merged.skipped += r.value.skipped;
        }
        if (merged.skipped > 0) ctx.warn(`skipped ${merged.skipped} undecodable item(s)`);
        return {
          result: mergeUpcoming(merged, { now, days }, courseNames),
          ok: merged.ok,
          firstError: merged.errors.find((e) => httpStatusOf(e) !== 403) ?? null,
          terms: new Map(courses.map((c) => [c.id, { endDate: c.endDate, isActive: c.isActive }])),
        };
      });

      const { result } = fetched;
      const denied = deniedCourses(result.failures);
      const others = result.failures.filter((f) => !isCourseDenied(f));
      if (fetched.ok === 0 && denied.size === 0 && fetched.firstError !== null) {
        throw fetched.firstError;
      }
      if (denied.size > 0) {
        // Named, not just counted (bs-6j8): "1 course returned 403" left the user re-running
        // the whole command under --verbose to find out whether a course they cared about
        // was skipped.
        ctx.warn(
          `${denied.size} course${denied.size === 1 ? '' : 's'} returned 403: ${namedCourses([...denied.values()])}`,
        );
        for (const f of result.failures) {
          if (!isCourseDenied(f)) continue;
          const term = f.courseId === null ? undefined : fetched.terms.get(f.courseId);
          const note = term === undefined ? null : forbiddenNote(term);
          ctx.debug(`  ${f.courseId} ${f.courseName ?? ''}: ${f.message}${note ? ` ${note}` : ''}`);
        }
      }
      for (const f of others) {
        const what =
          f.courseId === null
            ? "those courses' content items"
            : `the items of course ${f.courseId}`;
        ctx.warn(`${f.message}; ${what} are omitted`);
      }

      const items = opts.limit === undefined ? result.items : result.items.slice(0, opts.limit);
      const envelope = { ...listEnvelope(items, startedAt), failures: result.failures };
      emitList(ctx, envelope, {
        tsv: { columns: UPCOMING_COLUMNS as readonly (string | Column)[] },
        human: () => upcomingTable(items, days),
      });
    });
}

/** A 403 on a course route (a chunk 403 has no course and is reported on its own). */
function isCourseDenied(f: UpcomingFailure): boolean {
  return f.status === 403 && f.courseId !== null;
}

/** The denied courses in failure order, one label each: `Name (id)`, or `course <id>` unnamed. */
function deniedCourses(failures: readonly UpcomingFailure[]): Map<number, string> {
  const out = new Map<number, string>();
  for (const f of failures) {
    if (!isCourseDenied(f) || f.courseId === null || out.has(f.courseId)) continue;
    out.set(
      f.courseId,
      f.courseName === null ? `course ${f.courseId}` : `${f.courseName} (${f.courseId})`,
    );
  }
  return out;
}

/** How many course names one stderr line carries before it starts counting instead. */
const NAMED_DENIED_LIMIT = 3;

function namedCourses(labels: readonly string[]): string {
  if (labels.length <= NAMED_DENIED_LIMIT) return labels.join(', ');
  const rest = labels.length - NAMED_DENIED_LIMIT;
  return `${labels.slice(0, NAMED_DENIED_LIMIT).join(', ')} and ${rest} more; details with --verbose`;
}
