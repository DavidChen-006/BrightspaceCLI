/**
 * Announcements (D2L "news"; d2l-api-web A-16, Brightspace-Bar sweep A-16).
 *
 * - `newsUrl()` builds the one collection route (`news/?since=` is its only parameter; the
 *   answer is a bare array with no paging) and `attachmentUrl()` the file-stream route.
 * - `listNews()` fetches the array; `streamAttachment()` opens a file body.
 * - `announcementOf()` is the pure parser onto the PRD 6.3 Announcement shape. Rules pinned by
 *   Brightspace-Bar's tests and kept here verbatim: only `IsPublished === false` is excluded
 *   (a missing field is not a draft); `date` is `StartDate ?? CreatedDate` where "unreadable"
 *   and "absent" fall through alike; the list is sorted newest-first client-side because the
 *   server order is observed, not promised. Attachment sizes read `FileSize` (the documented
 *   key) then `Size` (what the tenant actually sends).
 */
import { isoSeconds, toD2lDateTime } from '../core/dates.js';
import { BsError } from '../core/errors.js';
import {
  classify,
  d2lUrl,
  displayPath,
  type HttpClient,
  type HttpStream,
  type Query,
  toError,
} from '../core/http/index.js';
import { isRecord, type LeTenant, optionalBoolean, optionalString } from './common.js';
import { announcementsUrl } from './links.js';

/** The LE tenant view lives in `common.ts`; re-exported so existing imports keep resolving. */
export type { LeTenant } from './common.js';

// ---------------------------------------------------------------------------------------------
// Wire shapes (documented fields only; parsers tolerate anything missing)
// ---------------------------------------------------------------------------------------------

export interface NewsAttachment {
  FileId: number;
  FileName: string;
  /** Documented name. */
  FileSize?: number;
  /** What the tenant sends (Brightspace-Bar sweep A-16). */
  Size?: number;
}

export interface NewsItem {
  Id: number;
  IsHidden: boolean;
  Attachments: NewsAttachment[];
  Title: string;
  Body: { Text: string; Html: string | null };
  CreatedBy: number | null;
  CreatedDate: string | null;
  LastModifiedBy: number | null;
  LastModifiedDate: string | null;
  StartDate: string | null;
  EndDate: string | null;
  IsGlobal: boolean;
  IsPublished: boolean;
  ShowOnlyInCourseOfferings: boolean;
  IsAuthorInfoShown: boolean;
  IsPinned: boolean;
  PinnedDate: string | null;
  IsStartDateShown: boolean;
  SortOrder: number;
}

// ---------------------------------------------------------------------------------------------
// Curated shapes (PRD 6.3)
// ---------------------------------------------------------------------------------------------

export interface Attachment {
  fileId: number;
  fileName: string;
  /** Bytes as reported by D2L; null when neither size key is present. */
  size: number | null;
}

export interface Announcement {
  id: number;
  courseId: number;
  /** Instructor-authored: wrapped under --wrap-untrusted, as are bodyText and bodyHtml. */
  title: string;
  /** `Body.Text` as served; falls back to `Body.Html` with tags stripped; null with no body. */
  bodyText: string | null;
  bodyHtml: string | null;
  /** `StartDate ?? CreatedDate`, whole-second UTC; null when neither is readable. */
  date: string | null;
  pinned: boolean;
  attachments: Attachment[];
  url: string;
}

/** `--plain` columns for `announcements list`: every key but `bodyHtml` (use --json for it). */
export const ANNOUNCEMENT_COLUMNS: readonly (keyof Announcement)[] = [
  'id',
  'courseId',
  'title',
  'date',
  'pinned',
  'attachments',
  'bodyText',
  'url',
];

// ---------------------------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------------------------

export interface ListNewsOptions {
  /** Only items since this instant (D2L's own filter; rendered as UTCDateTime with ms). */
  since?: Date;
}

export function newsUrl(cfg: LeTenant, ou: number, options: ListNewsOptions = {}): string {
  const query: Query = {
    since: options.since === undefined ? undefined : toD2lDateTime(options.since),
  };
  return d2lUrl(cfg.baseUrl, `/d2l/api/le/${cfg.leVersion}/${ou}/news/`, query);
}

export function attachmentUrl(cfg: LeTenant, ou: number, newsId: number, fileId: number): string {
  return d2lUrl(
    cfg.baseUrl,
    `/d2l/api/le/${cfg.leVersion}/${ou}/news/${newsId}/attachments/${fileId}`,
  );
}

/** The bare NewsItem array as sent; anything but an array is a shape error (exit 1). */
export async function listNews(
  http: HttpClient,
  cfg: LeTenant,
  ou: number,
  options: ListNewsOptions = {},
): Promise<unknown[]> {
  const url = newsUrl(cfg, ou, options);
  const payload = await http.json<unknown>({ method: 'GET', url });
  if (!Array.isArray(payload)) {
    throw new BsError('error', `GET ${displayPath(url)}: expected a news item array`, {
      hint: 'Run: bs auth doctor',
    });
  }
  return payload;
}

/** Opens the attachment body; a non-2xx answer is classified like any route (404 → 5, 403 → 6). */
export async function streamAttachment(
  http: HttpClient,
  cfg: LeTenant,
  ou: number,
  newsId: number,
  fileId: number,
): Promise<HttpStream> {
  const outcome = await http.requestStream({
    method: 'GET',
    url: attachmentUrl(cfg, ou, newsId, fileId),
  });
  if (!outcome.ok) throw toError(classify(outcome.response));
  return outcome.stream;
}

// ---------------------------------------------------------------------------------------------
// Parsers
// ---------------------------------------------------------------------------------------------

const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, code: string) => {
    if (code[0] === '#') {
      const point =
        code[1] === 'x' || code[1] === 'X'
          ? Number.parseInt(code.slice(2), 16)
          : Number(code.slice(1));
      return Number.isFinite(point) && point > 0 && point <= 0x10ffff
        ? String.fromCodePoint(point)
        : match;
    }
    return NAMED_ENTITIES[code.toLowerCase()] ?? match;
  });
}

/**
 * Plain text from a fragment of HTML: block boundaries become newlines, other tags vanish,
 * entities are decoded, runs of spaces collapse. A fallback for items without `Body.Text`.
 */
export function stripHtml(html: string): string {
  const withBreaks = html
    .replace(/<\s*br\s*\/?>/gi, '\n')
    .replace(/<\/\s*(p|div|li|h[1-6]|tr|blockquote|pre)\s*>/gi, '\n')
    .replace(/<[^>]*>/g, '');
  return decodeEntities(withBreaks)
    .replace(/ /g, ' ')
    .split('\n')
    .map((line) => line.replace(/[ \t\r\f\v]+/g, ' ').trim())
    .filter((line) => line !== '')
    .join('\n');
}

export function attachmentOf(value: unknown): Attachment | null {
  if (!isRecord(value)) return null;
  const fileId = value.FileId;
  if (typeof fileId !== 'number' || !Number.isInteger(fileId)) return null;
  const size =
    typeof value.FileSize === 'number'
      ? value.FileSize
      : typeof value.Size === 'number'
        ? value.Size
        : null;
  return { fileId, fileName: optionalString(value.FileName) ?? '', size };
}

/** One NewsItem onto the Announcement shape; null when it carries no integer `Id`. */
export function announcementOf(item: unknown, ou: number, baseUrl: string): Announcement | null {
  if (!isRecord(item)) return null;
  const id = item.Id;
  if (typeof id !== 'number' || !Number.isInteger(id)) return null;
  const body = isRecord(item.Body) ? item.Body : {};
  const bodyHtml = optionalString(body.Html);
  const bodyText = optionalString(body.Text) ?? (bodyHtml === null ? null : stripHtml(bodyHtml));
  const attachments = Array.isArray(item.Attachments)
    ? item.Attachments.map(attachmentOf).filter((a): a is Attachment => a !== null)
    : [];
  return {
    id,
    courseId: ou,
    title: optionalString(item.Title) ?? '',
    bodyText,
    bodyHtml,
    date: isoSeconds(item.StartDate) ?? isoSeconds(item.CreatedDate),
    pinned: optionalBoolean(item.IsPinned),
    attachments,
    url: announcementsUrl(baseUrl, ou),
  };
}

/** Only an explicit `IsPublished: false` is a draft; a missing field is not. */
export function isPublished(item: unknown): boolean {
  return !(isRecord(item) && item.IsPublished === false);
}

/**
 * Newest first, undated last. Dates are whole-second UTC strings of one width, so they compare
 * chronologically as text; equal dates return 0 and keep the server's order (stable sort).
 */
export function newestFirst(a: Pick<Announcement, 'date'>, b: Pick<Announcement, 'date'>): number {
  if (a.date === b.date) return 0;
  if (a.date === null) return 1;
  if (b.date === null) return -1;
  return a.date < b.date ? 1 : -1;
}

/**
 * Decodes a news payload into the curated list: drafts dropped, undecodable items reported
 * through `onSkip` rather than silently lost, sorted newest-first. Apply `--limit` after this.
 */
export function announcements(
  items: readonly unknown[],
  ou: number,
  baseUrl: string,
  onSkip: (item: unknown) => void = () => {},
): Announcement[] {
  const out: Announcement[] = [];
  for (const item of items) {
    if (!isPublished(item)) continue;
    const announcement = announcementOf(item, ou, baseUrl);
    if (announcement === null) onSkip(item);
    else out.push(announcement);
  }
  return out.sort(newestFirst);
}
