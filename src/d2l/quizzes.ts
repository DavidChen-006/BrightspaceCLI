/**
 * Quizzes (d2l-api-web A-13; Brightspace-Bar sweep A-13).
 *
 * - `quizzes/` is an ObjectListPage `{Objects, Next}` (NOT a bare array like `dropbox/folders/`;
 *   the shared decoder would silently yield nothing); `listQuizzes()` walks `Next` via
 *   `objectListPage`, which rejects the bare-array shape.
 * - `quizzes/(quizId)` is one QuizReadData; `quizzes/(quizId)/attempts/?userId=` is an
 *   ObjectListPage of QuizAttemptData whose learner access is unverified (expect 403).
 * - `quizOf()` / `quizDetailOf()` / `attemptOf()` are pure parsers onto the PRD 6.3 Item shape
 *   (`kind: 'quiz'`): every value is read, only `url` is computed, dates normalise to
 *   whole-second UTC or null. Only `QuizId, Name, DueDate, IsActive` were captured with
 *   values; the other keys follow the docs and the parsers tolerate either rich-text nesting
 *   (`{Text:{Text,Html},IsDisplayed}` per the docs, or flat `{Text,Html}` as recorded).
 */
import type { TenantConfig } from '../core/config.js';
import { isoSeconds } from '../core/dates.js';
import { d2lUrl, type HttpClient, objectListPage, type PageOptions } from '../core/http/index.js';
import { d2lId, isRecord, optionalBoolean, optionalString } from './common.js';
import { quizUrl } from './links.js';

/** What an LE route needs to know about the tenant. */
export type LeTenant = Pick<TenantConfig, 'baseUrl' | 'leVersion'>;

// ---------------------------------------------------------------------------------------------
// Wire shapes (documented fields only; parsers tolerate anything missing)
// ---------------------------------------------------------------------------------------------

export interface RichText {
  Text: string;
  Html: string;
}

/** The docs' shape for Description/Instructions/Header/Footer on QuizReadData. */
export interface DisplayedRichText {
  Text: RichText;
  IsDisplayed: boolean;
}

export interface QuizReadData {
  QuizId: number;
  Name: string;
  IsActive: boolean;
  SortOrder: number;
  DueDate: string | null;
  StartDate: string | null;
  EndDate: string | null;
  GradeItemId: number | null;
  ActivityId: string | null;
  Description: DisplayedRichText | RichText | null;
  Instructions: DisplayedRichText | RichText | null;
  Header: DisplayedRichText | RichText | null;
  Footer: DisplayedRichText | RichText | null;
  AttemptsAllowed: { IsUnlimited: boolean; NumberOfAttemptsAllowed: number | null } | null;
  LateSubmissionInfo: { LateSubmissionOption: number; LateLimitMinutes: number | null } | null;
  SubmissionTimeLimit: { IsEnforced: boolean; ShowClock: boolean; TimeLimitValue: number } | null;
}

export interface QuizAttemptData {
  AttemptId: number;
  QuizId: number;
  UserId: number | string;
  AttemptNumber: number;
  Score: number | null;
  Started: string | null;
  Completed: string | null;
  AttemptFeedback: RichText | null;
  IsPublished: boolean;
  AttemptDueDate: string | null;
}

// ---------------------------------------------------------------------------------------------
// Curated shapes (PRD 6.3 Item with kind 'quiz')
// ---------------------------------------------------------------------------------------------

export interface Quiz {
  id: number;
  courseId: number;
  kind: 'quiz';
  /** Instructor-authored: wrapped under --wrap-untrusted. */
  title: string;
  dueDate: string | null;
  startDate: string | null;
  endDate: string | null;
  url: string;
  gradeItemId: number | null;
  isActive: boolean;
  /** `AttemptsAllowed.NumberOfAttemptsAllowed`; null when unlimited or unknown. */
  attemptsAllowed: number | null;
  unlimitedAttempts: boolean;
  /** `SubmissionTimeLimit.TimeLimitValue` (minutes); null when the quiz has no limit. */
  timeLimit: number | null;
  timeLimitEnforced: boolean;
}

/** `bs quizzes get`: the Quiz plus the free text and late-submission policy. */
export interface QuizDetail extends Quiz {
  /** Instructor-authored free text: wrapped under --wrap-untrusted. */
  description: string | null;
  descriptionHtml: string | null;
  instructions: string | null;
  lateSubmissionOption: number | null;
  lateLimitMinutes: number | null;
  activityId: string | null;
}

export interface QuizAttempt {
  id: number;
  quizId: number;
  courseId: number;
  userId: number | string | null;
  attemptNumber: number | null;
  score: number | null;
  started: string | null;
  completed: string | null;
  dueDate: string | null;
  isPublished: boolean;
  /** Instructor feedback text: wrapped under --wrap-untrusted. */
  feedback: string | null;
  url: string;
}

export const QUIZ_COLUMNS: readonly (keyof Quiz)[] = [
  'id',
  'courseId',
  'kind',
  'title',
  'dueDate',
  'startDate',
  'endDate',
  'url',
  'gradeItemId',
  'isActive',
  'attemptsAllowed',
  'unlimitedAttempts',
  'timeLimit',
  'timeLimitEnforced',
];

export const ATTEMPT_COLUMNS: readonly (keyof QuizAttempt)[] = [
  'id',
  'quizId',
  'courseId',
  'userId',
  'attemptNumber',
  'score',
  'started',
  'completed',
  'dueDate',
  'isPublished',
  'feedback',
  'url',
];

// ---------------------------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------------------------

export function quizzesUrl(cfg: LeTenant, ou: number): string {
  return d2lUrl(cfg.baseUrl, `/d2l/api/le/${cfg.leVersion}/${ou}/quizzes/`);
}

export function quizItemUrl(cfg: LeTenant, ou: number, quizId: number): string {
  return d2lUrl(cfg.baseUrl, `/d2l/api/le/${cfg.leVersion}/${ou}/quizzes/${quizId}`);
}

export function quizAttemptsUrl(
  cfg: LeTenant,
  ou: number,
  quizId: number,
  userId: number | string,
): string {
  return d2lUrl(cfg.baseUrl, `/d2l/api/le/${cfg.leVersion}/${ou}/quizzes/${quizId}/attempts/`, {
    userId,
  });
}

/** Raw QuizReadData objects across every `Next` page; stop iterating to stop fetching. */
export function listQuizzes(
  http: HttpClient,
  cfg: LeTenant,
  ou: number,
  page: PageOptions = {},
): AsyncGenerator<QuizReadData, void, undefined> {
  return objectListPage<QuizReadData>(
    quizzesUrl(cfg, ou),
    (url) => http.json<unknown>({ method: 'GET', url }),
    page,
  );
}

export function getQuiz(
  http: HttpClient,
  cfg: LeTenant,
  ou: number,
  quizId: number,
): Promise<QuizReadData> {
  return http.json<QuizReadData>({ method: 'GET', url: quizItemUrl(cfg, ou, quizId) });
}

/** Raw QuizAttemptData objects for one user across every `Next` page. */
export function listAttempts(
  http: HttpClient,
  cfg: LeTenant,
  ou: number,
  quizId: number,
  userId: number | string,
  page: PageOptions = {},
): AsyncGenerator<QuizAttemptData, void, undefined> {
  return objectListPage<QuizAttemptData>(
    quizAttemptsUrl(cfg, ou, quizId, userId),
    (url) => http.json<unknown>({ method: 'GET', url }),
    page,
  );
}

// ---------------------------------------------------------------------------------------------
// Parsers
// ---------------------------------------------------------------------------------------------

function optionalNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function optionalInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) ? value : null;
}

/** `{Text:{Text,Html},IsDisplayed}` (docs) or `{Text,Html}` (recorded) → `{text, html}`. */
function richTextOf(value: unknown): { text: string | null; html: string | null } {
  if (!isRecord(value)) return { text: null, html: null };
  const inner = isRecord(value.Text) ? value.Text : value;
  return { text: optionalString(inner.Text), html: optionalString(inner.Html) };
}

/** One QuizReadData onto the Quiz shape; null when it carries no numeric QuizId. */
export function quizOf(item: unknown, ou: number, baseUrl: string): Quiz | null {
  if (!isRecord(item)) return null;
  const id = item.QuizId;
  if (typeof id !== 'number' || !Number.isInteger(id)) return null;
  const attempts = isRecord(item.AttemptsAllowed) ? item.AttemptsAllowed : {};
  const limit = isRecord(item.SubmissionTimeLimit) ? item.SubmissionTimeLimit : {};
  return {
    id,
    courseId: ou,
    kind: 'quiz',
    title: optionalString(item.Name) ?? '',
    dueDate: isoSeconds(item.DueDate),
    startDate: isoSeconds(item.StartDate),
    endDate: isoSeconds(item.EndDate),
    url: quizUrl(baseUrl, ou, id),
    gradeItemId: optionalInteger(item.GradeItemId),
    isActive: optionalBoolean(item.IsActive),
    attemptsAllowed: optionalInteger(attempts.NumberOfAttemptsAllowed),
    unlimitedAttempts: optionalBoolean(attempts.IsUnlimited),
    timeLimit: optionalNumber(limit.TimeLimitValue),
    timeLimitEnforced: optionalBoolean(limit.IsEnforced),
  };
}

export function quizDetailOf(item: unknown, ou: number, baseUrl: string): QuizDetail | null {
  const quiz = quizOf(item, ou, baseUrl);
  if (quiz === null || !isRecord(item)) return null;
  const description = richTextOf(item.Description);
  const instructions = richTextOf(item.Instructions);
  const late = isRecord(item.LateSubmissionInfo) ? item.LateSubmissionInfo : {};
  return {
    ...quiz,
    description: description.text,
    descriptionHtml: description.html,
    instructions: instructions.text,
    lateSubmissionOption: optionalInteger(late.LateSubmissionOption),
    lateLimitMinutes: optionalNumber(late.LateLimitMinutes),
    activityId: optionalString(item.ActivityId),
  };
}

/** One QuizAttemptData onto the QuizAttempt shape; null when it carries no numeric AttemptId. */
export function attemptOf(item: unknown, ou: number, baseUrl: string): QuizAttempt | null {
  if (!isRecord(item)) return null;
  const id = item.AttemptId;
  if (typeof id !== 'number' || !Number.isInteger(id)) return null;
  const quizId = optionalInteger(item.QuizId) ?? 0;
  return {
    id,
    quizId,
    courseId: ou,
    userId: d2lId(item.UserId),
    attemptNumber: optionalInteger(item.AttemptNumber),
    score: optionalNumber(item.Score),
    started: isoSeconds(item.Started),
    completed: isoSeconds(item.Completed),
    dueDate: isoSeconds(item.AttemptDueDate),
    isPublished: optionalBoolean(item.IsPublished),
    feedback: richTextOf(item.AttemptFeedback).text,
    url: quizUrl(baseUrl, ou, quizId),
  };
}

/** Decodes a stream of QuizReadData, reporting undecodable objects instead of dropping them silently. */
export async function* quizzes(
  items: AsyncIterable<unknown>,
  ou: number,
  baseUrl: string,
  onSkip: (item: unknown) => void = () => {},
): AsyncGenerator<Quiz, void, undefined> {
  for await (const item of items) {
    const quiz = quizOf(item, ou, baseUrl);
    if (quiz === null) onSkip(item);
    else yield quiz;
  }
}

/** Decodes a stream of QuizAttemptData the same way. */
export async function* attempts(
  items: AsyncIterable<unknown>,
  ou: number,
  baseUrl: string,
  onSkip: (item: unknown) => void = () => {},
): AsyncGenerator<QuizAttempt, void, undefined> {
  for await (const item of items) {
    const attempt = attemptOf(item, ou, baseUrl);
    if (attempt === null) onSkip(item);
    else yield attempt;
  }
}
