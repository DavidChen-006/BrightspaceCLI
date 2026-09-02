/**
 * `bs upcoming` (PRD 6.2 upcoming row, 6.3 Item shape, 9 fan-out): the content-due route and
 * the pure merger the command feeds with what the per-course routes returned.
 *
 * - `myItemsDueUrl()` / `listMyItemsDue()`: `GET content/myItems/due/?orgUnitIdsCSV=` (d2l-api-web
 *   Extra E), an ObjectListPage of ScheduledItem across at most 100 org units per request; a
 *   longer id list is walked in chunks of 100 (`chunkOrgUnits`).
 * - `scheduledItemOf()`: one ScheduledItem onto the Item shape with `kind: 'content'` (`UserId`
 *   and `OrgUnitId` are string D2LIDs; `ItemUrl` is absolutised, never templated).
 * - `mergeUpcoming()`: assignments, quizzes, discussion topics and content-due items → one list
 *   of items whose `dueDate` falls in `[now, now + days]`, deduplicated by `(kind, id)` and sorted
 *   by `dueDate`, then `title`; the per-course failures pass through untouched so the command can
 *   summarise them (Brightspace-Bar sweep: 403 on past-term courses is steady state).
 */
import { isoSeconds } from '../core/dates.js';
import { d2lUrl, type HttpClient, objectListPage, type PageOptions } from '../core/http/index.js';
import type { Assignment } from './assignments.js';
import { d2lId, isRecord, optionalString } from './common.js';
import { absoluteUrl } from './content.js';
import type { DiscussionTopic } from './discussions.js';
import type { LeTenant, Quiz } from './quizzes.js';

export const MAX_ORG_UNITS_PER_REQUEST = 100;
export const DEFAULT_UPCOMING_DAYS = 14;
const DAY_MS = 86_400_000;

export const UPCOMING_KINDS = ['assignment', 'quiz', 'discussion', 'content'] as const;
export type UpcomingKind = (typeof UPCOMING_KINDS)[number];

// ---------------------------------------------------------------------------------------------
// Wire shape (documented fields only; the parser tolerates anything missing)
// ---------------------------------------------------------------------------------------------

export interface ScheduledItem {
  UserId: string;
  OrgUnitId: string;
  ItemId: number;
  ItemName: string;
  /** 0 Module, 1 Topic. */
  ItemType: number;
  ItemUrl: string | null;
  StartDate: string | null;
  EndDate: string | null;
  DueDate: string | null;
  CompletionType: number;
  DateCompleted: string | null;
  ActivityType: number;
  IsExempt: boolean;
}

// ---------------------------------------------------------------------------------------------
// Curated shapes (PRD 6.3 Item plus the course name the fan-out already knows)
// ---------------------------------------------------------------------------------------------

/** An Item before the window filter: `dueDate` may still be null. */
export interface UpcomingCandidate {
  id: number;
  courseId: number;
  /** From the enrollment listing; null when the caller named the courses (`--course`). */
  courseName: string | null;
  kind: UpcomingKind;
  /** Instructor-authored: wrapped under --wrap-untrusted. */
  title: string;
  dueDate: string | null;
  startDate: string | null;
  endDate: string | null;
  url: string | null;
  gradeItemId: number | null;
}

/** The PRD Item shape as `bs upcoming` emits it: every item has a due date in the window. */
export interface UpcomingItem extends UpcomingCandidate {
  dueDate: string;
}

/** One failed route of the fan-out; `courseId` is null for a `content/myItems/due/` chunk. */
export interface UpcomingFailure {
  courseId: number | null;
  courseName: string | null;
  /** The HTTP status when the failure was a response (403 = past-term), else null. */
  status: number | null;
  message: string;
}

export interface UpcomingResult {
  items: UpcomingItem[];
  failures: UpcomingFailure[];
}

/** `--plain` columns (PRD 6.3). */
export const UPCOMING_COLUMNS: readonly (keyof UpcomingItem)[] = [
  'kind',
  'courseId',
  'courseName',
  'id',
  'title',
  'dueDate',
  'url',
];

// ---------------------------------------------------------------------------------------------
// Route
// ---------------------------------------------------------------------------------------------

/** Splits org unit ids into request-sized chunks (order kept, duplicates kept). */
export function chunkOrgUnits(ids: readonly number[]): number[][] {
  const out: number[][] = [];
  for (let i = 0; i < ids.length; i += MAX_ORG_UNITS_PER_REQUEST) {
    out.push(ids.slice(i, i + MAX_ORG_UNITS_PER_REQUEST));
  }
  return out;
}

export function myItemsDueUrl(cfg: LeTenant, orgUnitIds: readonly number[]): string {
  if (orgUnitIds.length === 0) throw new Error('myItemsDueUrl: at least one org unit id');
  if (orgUnitIds.length > MAX_ORG_UNITS_PER_REQUEST) {
    throw new Error(`myItemsDueUrl: at most ${MAX_ORG_UNITS_PER_REQUEST} org units per request`);
  }
  return d2lUrl(cfg.baseUrl, `/d2l/api/le/${cfg.leVersion}/content/myItems/due/`, {
    orgUnitIdsCSV: orgUnitIds.join(','),
  });
}

/**
 * Raw ScheduledItem objects still due across the given org units: one ObjectListPage walk per
 * chunk of 100 ids, chunks in order. Stop iterating to stop fetching.
 */
export async function* listMyItemsDue(
  http: HttpClient,
  cfg: LeTenant,
  orgUnitIds: readonly number[],
  page: PageOptions = {},
): AsyncGenerator<unknown, void, undefined> {
  for (const chunk of chunkOrgUnits(orgUnitIds)) {
    yield* objectListPage<unknown>(
      myItemsDueUrl(cfg, chunk),
      (url) => http.json<unknown>({ method: 'GET', url }),
      page,
    );
  }
}

// ---------------------------------------------------------------------------------------------
// Parsers
// ---------------------------------------------------------------------------------------------

function optionalInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) ? value : null;
}

/** One ScheduledItem onto the Item shape (`kind: 'content'`); null without a numeric ItemId/OrgUnitId. */
export function scheduledItemOf(item: unknown, baseUrl: string): UpcomingCandidate | null {
  if (!isRecord(item)) return null;
  const id = optionalInteger(item.ItemId);
  const courseId = d2lId(item.OrgUnitId);
  if (id === null || typeof courseId !== 'number') return null;
  return {
    id,
    courseId,
    courseName: null,
    kind: 'content',
    title: optionalString(item.ItemName) ?? '',
    dueDate: isoSeconds(item.DueDate),
    startDate: isoSeconds(item.StartDate),
    endDate: isoSeconds(item.EndDate),
    url: absoluteUrl(baseUrl, item.ItemUrl),
    gradeItemId: null,
  };
}

export function candidateOfAssignment(a: Assignment): UpcomingCandidate {
  return {
    id: a.id,
    courseId: a.courseId,
    courseName: null,
    kind: 'assignment',
    title: a.title,
    dueDate: a.dueDate,
    startDate: a.startDate,
    endDate: a.endDate,
    url: a.url,
    gradeItemId: a.gradeItemId,
  };
}

export function candidateOfQuiz(q: Quiz): UpcomingCandidate {
  return {
    id: q.id,
    courseId: q.courseId,
    courseName: null,
    kind: 'quiz',
    title: q.title,
    dueDate: q.dueDate,
    startDate: q.startDate,
    endDate: q.endDate,
    url: q.url,
    gradeItemId: q.gradeItemId,
  };
}

export function candidateOfTopic(t: DiscussionTopic): UpcomingCandidate {
  return {
    id: t.id,
    courseId: t.courseId,
    courseName: null,
    kind: 'discussion',
    title: t.name,
    dueDate: t.dueDate,
    startDate: t.startDate,
    endDate: t.endDate,
    url: t.url,
    gradeItemId: null,
  };
}

// ---------------------------------------------------------------------------------------------
// Merger
// ---------------------------------------------------------------------------------------------

export interface UpcomingSources {
  assignments?: readonly Assignment[];
  quizzes?: readonly Quiz[];
  topics?: readonly DiscussionTopic[];
  /** Already parsed through `scheduledItemOf`. */
  content?: readonly UpcomingCandidate[];
  failures?: readonly UpcomingFailure[];
}

export interface UpcomingWindow {
  now: Date;
  /** Whole days from `now`; the window is inclusive at both ends. */
  days: number;
}

function compareItems(a: UpcomingItem, b: UpcomingItem): number {
  if (a.dueDate !== b.dueDate) return a.dueDate < b.dueDate ? -1 : 1;
  if (a.title !== b.title) return a.title < b.title ? -1 : 1;
  if (a.kind !== b.kind) return a.kind < b.kind ? -1 : 1;
  return a.id - b.id;
}

/**
 * Keeps the dated candidates whose `dueDate` lies in `[now, now + days]`, drops duplicates by
 * `(kind, id)` (first wins), fills `courseName` from the map and sorts by `dueDate`, then
 * `title`. Failures pass through unchanged.
 */
export function mergeUpcoming(
  sources: UpcomingSources,
  window: UpcomingWindow,
  courseNames: ReadonlyMap<number, string | null> = new Map(),
): UpcomingResult {
  const from = window.now.getTime();
  const to = from + window.days * DAY_MS;
  const candidates: UpcomingCandidate[] = [
    ...(sources.assignments ?? []).map(candidateOfAssignment),
    ...(sources.quizzes ?? []).map(candidateOfQuiz),
    ...(sources.topics ?? []).map(candidateOfTopic),
    ...(sources.content ?? []),
  ];
  const seen = new Set<string>();
  const items: UpcomingItem[] = [];
  for (const c of candidates) {
    if (c.dueDate === null) continue;
    const at = Date.parse(c.dueDate);
    if (Number.isNaN(at) || at < from || at > to) continue;
    const key = `${c.kind}:${c.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    items.push({
      ...c,
      dueDate: c.dueDate,
      courseName: courseNames.get(c.courseId) ?? c.courseName,
    });
  }
  items.sort(compareItems);
  return { items, failures: [...(sources.failures ?? [])] };
}
