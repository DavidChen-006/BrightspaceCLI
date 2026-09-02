/**
 * Discussions (d2l-api-web A-20; Brightspace-Bar sweep A-20: no live capture, doc-shaped only).
 *
 * - `discussions/forums/` and `forums/(f)/topics/` are bare arrays (`listForums()` /
 *   `listTopics()` reject anything else). Topics carry a first-class `DueDate` (LE >= 1.90),
 *   `ScoringType` and `ScoreOutOf`: the only pure acquisition source for due dates.
 * - `forums/(f)/topics/(t)/posts/?pageSize=&pageNumber=&sort=-creationdate` is page-numbered
 *   with no HasMore flag; `listPosts()` walks it via `pageNumbered` (stop on a short page).
 * - `forumOf()` / `topicOf()` / `postOf()` are pure parsers onto the PRD 6.3 shapes: every value
 *   is read, only `url` is computed (deep links from `links.ts`), dates normalise to
 *   whole-second UTC or null, and the post author is `PostingUserDisplayName` (Extra A: user
 *   lookups are privacy-gated, so nothing here depends on them).
 */
import { isoSeconds } from '../core/dates.js';
import { BsError } from '../core/errors.js';
import {
  d2lUrl,
  displayPath,
  type HttpClient,
  type PageOptions,
  pageNumbered,
} from '../core/http/index.js';
import { d2lId, isRecord, optionalBoolean, optionalString } from './common.js';
import { discussionsUrl, discussionThreadUrl, discussionTopicUrl } from './links.js';
import type { LeTenant, RichText } from './quizzes.js';

/** `pageSize` max/default on the posts route is 1000 (A-20); 100 keeps pages small. */
export const DEFAULT_POST_PAGE_SIZE = 100;
export const MAX_POST_PAGE_SIZE = 1000;

// ---------------------------------------------------------------------------------------------
// Wire shapes (documented fields only; parsers tolerate anything missing)
// ---------------------------------------------------------------------------------------------

export interface Forum {
  ForumId: number;
  Name: string;
  Description: RichText | null;
  StartDate: string | null;
  EndDate: string | null;
  PostStartDate: string | null;
  PostEndDate: string | null;
  AllowAnonymous: boolean;
  IsLocked: boolean;
  IsHidden: boolean;
  RequiresApproval: boolean;
}

export interface Topic {
  ForumId: number;
  TopicId: number;
  Name: string;
  Description: RichText | null;
  StartDate: string | null;
  EndDate: string | null;
  DueDate?: string | null;
  IsLocked: boolean;
  IsHidden: boolean;
  RequiresApproval: boolean;
  ScoringType: string | null;
  ScoreOutOf: number | null;
}

export interface Post {
  ForumId: number;
  PostId: number;
  TopicId: number;
  PostingUserId: number | string | null;
  PostingUserDisplayName: string;
  ThreadId: number;
  ParentPostId: number | null;
  Message: RichText | null;
  Subject: string;
  DatePosted: string | null;
  IsAnonymous: boolean;
  IsDeleted: boolean;
  ReplyPostIds: number[];
  IsRead: boolean;
  Attachments?: { FileId: number; FileName: string; Size: number }[];
}

// ---------------------------------------------------------------------------------------------
// Curated shapes (PRD 6.3 Discussion topic / post; the forum row is the container)
// ---------------------------------------------------------------------------------------------

export interface DiscussionForum {
  id: number;
  courseId: number;
  /** Instructor-authored: wrapped under --wrap-untrusted. */
  name: string;
  description: string | null;
  descriptionHtml: string | null;
  startDate: string | null;
  endDate: string | null;
  postStartDate: string | null;
  postEndDate: string | null;
  isLocked: boolean;
  isHidden: boolean;
  requiresApproval: boolean;
  allowAnonymous: boolean;
  url: string;
}

export interface DiscussionTopic {
  id: number;
  forumId: number | null;
  courseId: number;
  /** Instructor-authored: wrapped under --wrap-untrusted. */
  name: string;
  description: string | null;
  descriptionHtml: string | null;
  dueDate: string | null;
  startDate: string | null;
  endDate: string | null;
  scoreOutOf: number | null;
  scoringType: string | null;
  requiresApproval: boolean;
  isLocked: boolean;
  isHidden: boolean;
  url: string;
}

export interface PostAttachment {
  fileId: number | null;
  fileName: string | null;
  size: number | null;
}

export interface DiscussionPost {
  id: number;
  topicId: number | null;
  forumId: number | null;
  courseId: number;
  threadId: number | null;
  parentId: number | null;
  /** Learner-authored free text: wrapped under --wrap-untrusted (subject, body, author). */
  subject: string;
  bodyText: string;
  bodyHtml: string | null;
  author: string | null;
  authorId: number | string | null;
  date: string | null;
  /** `ReplyPostIds`: the direct replies to this post. */
  replies: number[];
  isRead: boolean;
  isAnonymous: boolean;
  isDeleted: boolean;
  attachments: PostAttachment[];
  url: string;
}

export const FORUM_COLUMNS: readonly (keyof DiscussionForum)[] = [
  'id',
  'courseId',
  'name',
  'description',
  'descriptionHtml',
  'startDate',
  'endDate',
  'postStartDate',
  'postEndDate',
  'isLocked',
  'isHidden',
  'requiresApproval',
  'allowAnonymous',
  'url',
];

export const TOPIC_COLUMNS: readonly (keyof DiscussionTopic)[] = [
  'id',
  'forumId',
  'courseId',
  'name',
  'description',
  'descriptionHtml',
  'dueDate',
  'startDate',
  'endDate',
  'scoreOutOf',
  'scoringType',
  'requiresApproval',
  'isLocked',
  'isHidden',
  'url',
];

export const POST_COLUMNS: readonly (keyof DiscussionPost)[] = [
  'id',
  'topicId',
  'forumId',
  'courseId',
  'threadId',
  'parentId',
  'subject',
  'bodyText',
  'bodyHtml',
  'author',
  'authorId',
  'date',
  'replies',
  'isRead',
  'isAnonymous',
  'isDeleted',
  'attachments',
  'url',
];

// ---------------------------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------------------------

export function forumsUrl(cfg: LeTenant, ou: number): string {
  return d2lUrl(cfg.baseUrl, `/d2l/api/le/${cfg.leVersion}/${ou}/discussions/forums/`);
}

export function topicsUrl(cfg: LeTenant, ou: number, forumId: number): string {
  return d2lUrl(
    cfg.baseUrl,
    `/d2l/api/le/${cfg.leVersion}/${ou}/discussions/forums/${forumId}/topics/`,
  );
}

export interface PostsQuery {
  /** `threadsOnly=true`: top-level posts only. */
  threadsOnly?: boolean;
}

/** The posts collection with `sort=-creationdate`; `pageSize`/`pageNumber` come from `pageNumbered`. */
export function postsUrl(
  cfg: LeTenant,
  ou: number,
  forumId: number,
  topicId: number,
  query: PostsQuery = {},
): string {
  return d2lUrl(
    cfg.baseUrl,
    `/d2l/api/le/${cfg.leVersion}/${ou}/discussions/forums/${forumId}/topics/${topicId}/posts/`,
    { threadsOnly: query.threadsOnly ? true : undefined, sort: '-creationdate' },
  );
}

function expectArray(url: string, payload: unknown, rawHint: string): unknown[] {
  if (Array.isArray(payload)) return payload;
  throw new BsError('error', `GET ${displayPath(url)}: expected a bare array`, {
    hint: `Run: ${rawHint}  to inspect the payload, or bs auth doctor`,
  });
}

/** The forums of an org unit (bare array of Forum). */
export async function listForums(http: HttpClient, cfg: LeTenant, ou: number): Promise<unknown[]> {
  const url = forumsUrl(cfg, ou);
  return expectArray(
    url,
    await http.json<unknown>({ method: 'GET', url }),
    `bs discussions forums ${ou} --raw`,
  );
}

/** The topics of one forum (bare array of Topic). */
export async function listTopics(
  http: HttpClient,
  cfg: LeTenant,
  ou: number,
  forumId: number,
): Promise<unknown[]> {
  const url = topicsUrl(cfg, ou, forumId);
  return expectArray(
    url,
    await http.json<unknown>({ method: 'GET', url }),
    `bs discussions topics ${ou} ${forumId} --raw`,
  );
}

export interface ListPostsOptions extends PostsQuery {
  pageSize?: number;
}

/** Raw Post objects across every page (stop on a short page); stop iterating to stop fetching. */
export function listPosts(
  http: HttpClient,
  cfg: LeTenant,
  ou: number,
  forumId: number,
  topicId: number,
  options: ListPostsOptions = {},
  page: PageOptions = {},
): AsyncGenerator<unknown, void, undefined> {
  return pageNumbered<unknown>(
    postsUrl(cfg, ou, forumId, topicId, options),
    (url) => http.json<unknown>({ method: 'GET', url }),
    options.pageSize ?? DEFAULT_POST_PAGE_SIZE,
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

/** `{Text,Html}` (docs) or `{Text:{Text,Html}}` (the quiz nesting) → `{text, html}`. */
function richTextOf(value: unknown): { text: string | null; html: string | null } {
  if (!isRecord(value)) return { text: null, html: null };
  const inner = isRecord(value.Text) ? value.Text : value;
  return { text: optionalString(inner.Text), html: optionalString(inner.Html) };
}

/** One Forum onto the DiscussionForum shape; null when it carries no numeric ForumId. */
export function forumOf(item: unknown, ou: number, baseUrl: string): DiscussionForum | null {
  if (!isRecord(item)) return null;
  const id = item.ForumId;
  if (typeof id !== 'number' || !Number.isInteger(id)) return null;
  const description = richTextOf(item.Description);
  return {
    id,
    courseId: ou,
    name: optionalString(item.Name) ?? '',
    description: description.text,
    descriptionHtml: description.html,
    startDate: isoSeconds(item.StartDate),
    endDate: isoSeconds(item.EndDate),
    postStartDate: isoSeconds(item.PostStartDate),
    postEndDate: isoSeconds(item.PostEndDate),
    isLocked: optionalBoolean(item.IsLocked),
    isHidden: optionalBoolean(item.IsHidden),
    requiresApproval: optionalBoolean(item.RequiresApproval),
    allowAnonymous: optionalBoolean(item.AllowAnonymous),
    url: discussionsUrl(baseUrl, ou),
  };
}

/**
 * One Topic onto the PRD 6.3 Discussion topic shape; null when it carries no numeric TopicId.
 * `forumId` is read from the payload, falling back to the forum the caller listed.
 */
export function topicOf(
  item: unknown,
  ou: number,
  baseUrl: string,
  forumId: number | null = null,
): DiscussionTopic | null {
  if (!isRecord(item)) return null;
  const id = item.TopicId;
  if (typeof id !== 'number' || !Number.isInteger(id)) return null;
  const description = richTextOf(item.Description);
  return {
    id,
    forumId: optionalInteger(item.ForumId) ?? forumId,
    courseId: ou,
    name: optionalString(item.Name) ?? '',
    description: description.text,
    descriptionHtml: description.html,
    dueDate: isoSeconds(item.DueDate),
    startDate: isoSeconds(item.StartDate),
    endDate: isoSeconds(item.EndDate),
    scoreOutOf: optionalNumber(item.ScoreOutOf),
    scoringType: optionalString(item.ScoringType),
    requiresApproval: optionalBoolean(item.RequiresApproval),
    isLocked: optionalBoolean(item.IsLocked),
    isHidden: optionalBoolean(item.IsHidden),
    url: discussionTopicUrl(baseUrl, ou, id),
  };
}

function attachmentOf(value: unknown): PostAttachment | null {
  if (!isRecord(value)) return null;
  return {
    fileId: optionalInteger(value.FileId),
    fileName: optionalString(value.FileName),
    size: optionalNumber(value.Size),
  };
}

/** One Post onto the PRD 6.3 post shape; null when it carries no numeric PostId. */
export function postOf(item: unknown, ou: number, baseUrl: string): DiscussionPost | null {
  if (!isRecord(item)) return null;
  const id = item.PostId;
  if (typeof id !== 'number' || !Number.isInteger(id)) return null;
  const message = richTextOf(item.Message);
  const topicId = optionalInteger(item.TopicId);
  const threadId = optionalInteger(item.ThreadId);
  const replies = Array.isArray(item.ReplyPostIds)
    ? item.ReplyPostIds.filter((r): r is number => typeof r === 'number' && Number.isInteger(r))
    : [];
  const attachments = Array.isArray(item.Attachments)
    ? item.Attachments.map(attachmentOf).filter((a): a is PostAttachment => a !== null)
    : [];
  let url = discussionsUrl(baseUrl, ou);
  if (threadId !== null) url = discussionThreadUrl(baseUrl, ou, threadId);
  else if (topicId !== null) url = discussionTopicUrl(baseUrl, ou, topicId);
  return {
    id,
    topicId,
    forumId: optionalInteger(item.ForumId),
    courseId: ou,
    threadId,
    parentId: optionalInteger(item.ParentPostId),
    subject: optionalString(item.Subject) ?? '',
    bodyText: message.text ?? '',
    bodyHtml: message.html,
    author: optionalString(item.PostingUserDisplayName),
    authorId: d2lId(item.PostingUserId),
    date: isoSeconds(item.DatePosted),
    replies,
    isRead: optionalBoolean(item.IsRead),
    isAnonymous: optionalBoolean(item.IsAnonymous),
    isDeleted: optionalBoolean(item.IsDeleted),
    attachments,
    url,
  };
}

/** Decodes a stream of Post objects, reporting undecodable ones instead of dropping them silently. */
export async function* posts(
  items: AsyncIterable<unknown>,
  ou: number,
  baseUrl: string,
  onSkip: (item: unknown) => void = () => {},
): AsyncGenerator<DiscussionPost, void, undefined> {
  for await (const item of items) {
    const post = postOf(item, ou, baseUrl);
    if (post === null) onSkip(item);
    else yield post;
  }
}
