/**
 * Dropbox folders (assignments) and my submissions (d2l-api-web A-11, A-12; Brightspace-Bar
 * sweep A-11 and the AssignmentPipeline fixture README).
 *
 * - `foldersUrl()` is a bare-array collection (no paging); `folderUrl()`, `mySubmissionsUrl()`,
 *   `attachmentUrl()` and `submissionFileUrl()` are the single-item and stream routes.
 * - `assignmentOf()` / `assignmentDetailOf()` / `submissionOf()` are pure parsers onto the PRD
 *   6.3 Item shape (`kind: 'assignment'`) and the Submission shape. `Id` and `Name` are fatal
 *   (an item without them is undecodable); every other field survives as null. Dates go
 *   through `isoSeconds`. `url` is the only computed value and is always the PRD deep link —
 *   never `LinkAttachments[].Href`, which is an instructor-attached external resource.
 * - Measured quirks the parsers honour: `Availability` is null itself on every real folder;
 *   `CustomInstructions` is `{Text, Html}`; the six counters are -1 for a learner (not
 *   surfaced); enums arrive as ints on this tenant but the docs allow names, so both decode.
 */
import { isoSeconds } from '../core/dates.js';
import { BsError } from '../core/errors.js';
import { d2lUrl, displayPath, type HttpClient } from '../core/http/index.js';
import { d2lId, isRecord, type LeTenant, optionalBoolean, optionalString } from './common.js';
import { assignmentUrl } from './links.js';

/** The LE tenant view lives in `common.ts`; re-exported so existing imports keep resolving. */
export type { LeTenant } from './common.js';

// ---------------------------------------------------------------------------------------------
// Wire shapes (documented fields only; parsers tolerate anything missing)
// ---------------------------------------------------------------------------------------------

export interface RichText {
  Text: string;
  Html: string;
}

export interface FileAttachment {
  FileId: number;
  FileName: string;
  Size: number;
}

export interface DropboxFolder {
  Id: number;
  CategoryId: number | null;
  Name: string;
  CustomInstructions: RichText;
  Attachments: FileAttachment[];
  Availability: {
    StartDate: string | null;
    EndDate: string | null;
    StartDateAvailabilityType: number | string | null;
    EndDateAvailabilityType: number | string | null;
  } | null;
  GroupTypeId: number | null;
  DueDate: string | null;
  DisplayInCalendar: boolean;
  Assessment: { ScoreDenominator: number | null; Rubrics: unknown[] };
  IsHidden: boolean;
  LinkAttachments: { LinkId: number; LinkName?: string; Name?: string; Href: string }[];
  ActivityId: string | null;
  IsAnonymous: boolean;
  DropboxType: number | string;
  SubmissionType: number | string;
  CompletionType: number | string;
  GradeItemId: number | null;
}

export interface EntityDropbox {
  Entity: {
    EntityId: number | string;
    EntityType: 'User' | 'Group' | string;
    DisplayName?: string;
    Name?: string;
  };
  Status: number | string;
  Feedback: {
    Score: number | null;
    Feedback: RichText;
    RubricAssessments: unknown[];
    IsGraded: boolean;
    Files: FileAttachment[];
    Links: unknown[];
  } | null;
  Submissions: {
    Id: number;
    SubmittedBy: { Id: string; DisplayName: string };
    SubmissionDate: string | null;
    Comment: RichText;
    Files: (FileAttachment & { isRead: boolean; isFlagged: boolean })[];
  }[];
  CompletionDate: string | null;
}

// ---------------------------------------------------------------------------------------------
// Curated shapes (PRD 6.3)
// ---------------------------------------------------------------------------------------------

/** The PRD Item shape for `kind: 'assignment'`. */
export interface Assignment {
  id: number;
  courseId: number;
  kind: 'assignment';
  /** Instructor-authored: wrapped under --wrap-untrusted. */
  title: string;
  dueDate: string | null;
  startDate: string | null;
  endDate: string | null;
  url: string;
  gradeItemId: number | null;
}

/** RichText fields keep D2L's two forms; both keys are free text and wrap under --wrap-untrusted. */
export interface Rich {
  text: string | null;
  html: string | null;
}

export interface Attachment {
  fileId: number | string | null;
  fileName: string | null;
  size: number | null;
}

export interface LinkAttachment {
  linkId: number | string | null;
  /** Instructor-authored: wrapped. */
  name: string | null;
  /** An external resource, never the assignment page. */
  href: string | null;
}

export interface Availability {
  startDate: string | null;
  endDate: string | null;
  startType: string | null;
  endType: string | null;
}

/** `bs assignments get`: the Item plus what only `dropbox/folders/(id)` is read for. */
export interface AssignmentDetail extends Assignment {
  instructions: Rich;
  attachments: Attachment[];
  linkAttachments: LinkAttachment[];
  availability: Availability | null;
  isHidden: boolean;
  dropboxType: string | null;
  submissionType: string | null;
  completionType: string | null;
  scoreDenominator: number | null;
}

export interface SubmissionFile extends Attachment {
  isRead: boolean;
  isFlagged: boolean;
}

export interface SubmissionEntry {
  id: number | string | null;
  submittedBy: { id: number | string | null; displayName: string | null } | null;
  date: string | null;
  comment: Rich | null;
  files: SubmissionFile[];
}

export interface Feedback {
  score: number | null;
  isGraded: boolean;
  text: string | null;
  html: string | null;
  files: Attachment[];
}

/** One EntityDropbox from `mysubmissions/`: the learner (or their group) in one folder. */
export interface Submission {
  entityId: number | string | null;
  entityType: string | null;
  name: string | null;
  folderId: number;
  courseId: number;
  status: string | null;
  completionDate: string | null;
  feedback: Feedback | null;
  submissions: SubmissionEntry[];
  url: string;
}

export const ASSIGNMENT_COLUMNS: readonly (keyof Assignment)[] = [
  'id',
  'courseId',
  'kind',
  'title',
  'dueDate',
  'startDate',
  'endDate',
  'url',
  'gradeItemId',
];

// ---------------------------------------------------------------------------------------------
// Enums (d2l-api-web A-11, A-12): ints on the wire here, names allowed by the docs
// ---------------------------------------------------------------------------------------------

const DROPBOX_TYPES = ['', 'group', 'individual'] as const;
const SUBMISSION_TYPES = ['file', 'text', 'onPaper', 'observed', 'fileOrText'] as const;
const COMPLETION_TYPES = ['onSubmission', 'dueDate', 'manuallyByLearner', 'onEvaluation'] as const;
const AVAILABILITY_TYPES = ['accessRestricted', 'submissionRestricted', 'hidden'] as const;
const SUBMISSION_STATUSES = ['unsubmitted', 'submitted', 'draft', 'published'] as const;

/** Int index or case-insensitive name → canonical name; unknown values pass through as text. */
export function enumName(value: unknown, names: readonly string[]): string | null {
  if (typeof value === 'number' && Number.isInteger(value)) {
    const name = names[value];
    return name !== undefined && name !== '' ? name : String(value);
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed === '') return null;
    const match = names.find((n) => n !== '' && n.toLowerCase() === trimmed.toLowerCase());
    return match ?? trimmed;
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------------------------

function folders(cfg: LeTenant, ou: number): string {
  return `/d2l/api/le/${cfg.leVersion}/${ou}/dropbox/folders/`;
}

export function foldersUrl(cfg: LeTenant, ou: number): string {
  return d2lUrl(cfg.baseUrl, folders(cfg, ou));
}

export function folderUrl(cfg: LeTenant, ou: number, folderId: number): string {
  return d2lUrl(cfg.baseUrl, `${folders(cfg, ou)}${folderId}`);
}

export function mySubmissionsUrl(cfg: LeTenant, ou: number, folderId: number): string {
  return d2lUrl(cfg.baseUrl, `${folders(cfg, ou)}${folderId}/submissions/mysubmissions/`);
}

export function attachmentUrl(cfg: LeTenant, ou: number, folderId: number, fileId: number): string {
  return d2lUrl(cfg.baseUrl, `${folders(cfg, ou)}${folderId}/attachments/${fileId}`);
}

export function submissionFileUrl(
  cfg: LeTenant,
  ou: number,
  folderId: number,
  submissionId: number,
  fileId: number,
): string {
  return d2lUrl(
    cfg.baseUrl,
    `${folders(cfg, ou)}${folderId}/submissions/${submissionId}/files/${fileId}`,
  );
}

/** The bare array of DropboxFolder items (validated as an array; items decoded by the caller). */
export async function listFolders(http: HttpClient, cfg: LeTenant, ou: number): Promise<unknown[]> {
  const url = foldersUrl(cfg, ou);
  return asArray(await http.json<unknown>({ method: 'GET', url }), url);
}

export function getFolder(
  http: HttpClient,
  cfg: LeTenant,
  ou: number,
  folderId: number,
): Promise<DropboxFolder> {
  return http.json<DropboxFolder>({ method: 'GET', url: folderUrl(cfg, ou, folderId) });
}

/** The bare array of EntityDropbox items for the caller (empty when nothing was submitted). */
export async function listMySubmissions(
  http: HttpClient,
  cfg: LeTenant,
  ou: number,
  folderId: number,
): Promise<unknown[]> {
  const url = mySubmissionsUrl(cfg, ou, folderId);
  return asArray(await http.json<unknown>({ method: 'GET', url }), url);
}

/** A 2xx whose body is not the documented bare array is a shape error (exit 1, doctor hint). */
function asArray(value: unknown, url: string): unknown[] {
  if (Array.isArray(value)) return value;
  throw new BsError(
    'error',
    `GET ${displayPath(url)}: unexpected response shape, expected a JSON array`,
    { hint: 'Run: bs auth doctor' },
  );
}

// ---------------------------------------------------------------------------------------------
// Parsers
// ---------------------------------------------------------------------------------------------

function optionalNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function richOf(value: unknown): Rich {
  const r = isRecord(value) ? value : {};
  return { text: optionalString(r.Text), html: optionalString(r.Html) };
}

function attachmentOf(value: unknown): Attachment | null {
  if (!isRecord(value)) return null;
  return {
    fileId: d2lId(value.FileId),
    fileName: optionalString(value.FileName),
    size: optionalNumber(value.Size),
  };
}

function attachmentsOf(value: unknown): Attachment[] {
  if (!Array.isArray(value)) return [];
  return value.map(attachmentOf).filter((a): a is Attachment => a !== null);
}

function linkAttachmentsOf(value: unknown): LinkAttachment[] {
  if (!Array.isArray(value)) return [];
  const out: LinkAttachment[] = [];
  for (const item of value) {
    if (!isRecord(item)) continue;
    out.push({
      linkId: d2lId(item.LinkId),
      name: optionalString(item.LinkName) ?? optionalString(item.Name),
      href: optionalString(item.Href),
    });
  }
  return out;
}

function availabilityOf(value: unknown): Availability | null {
  if (!isRecord(value)) return null;
  return {
    startDate: isoSeconds(value.StartDate),
    endDate: isoSeconds(value.EndDate),
    startType: enumName(value.StartDateAvailabilityType, AVAILABILITY_TYPES),
    endType: enumName(value.EndDateAvailabilityType, AVAILABILITY_TYPES),
  };
}

/** One DropboxFolder onto the Item shape; null without a numeric `Id` and a string `Name`. */
export function assignmentOf(item: unknown, ou: number, baseUrl: string): Assignment | null {
  if (!isRecord(item)) return null;
  const id = item.Id;
  const name = item.Name;
  if (typeof id !== 'number' || !Number.isInteger(id) || typeof name !== 'string') return null;
  const availability = isRecord(item.Availability) ? item.Availability : {};
  return {
    id,
    courseId: ou,
    kind: 'assignment',
    title: name,
    dueDate: isoSeconds(item.DueDate),
    startDate: isoSeconds(availability.StartDate),
    endDate: isoSeconds(availability.EndDate),
    url: assignmentUrl(baseUrl, ou, id),
    gradeItemId: optionalNumber(item.GradeItemId),
  };
}

export function assignmentDetailOf(
  item: unknown,
  ou: number,
  baseUrl: string,
): AssignmentDetail | null {
  const base = assignmentOf(item, ou, baseUrl);
  if (base === null || !isRecord(item)) return null;
  const assessment = isRecord(item.Assessment) ? item.Assessment : {};
  return {
    ...base,
    instructions: richOf(item.CustomInstructions),
    attachments: attachmentsOf(item.Attachments),
    linkAttachments: linkAttachmentsOf(item.LinkAttachments),
    availability: availabilityOf(item.Availability),
    isHidden: optionalBoolean(item.IsHidden),
    dropboxType: enumName(item.DropboxType, DROPBOX_TYPES),
    submissionType: enumName(item.SubmissionType, SUBMISSION_TYPES),
    completionType: enumName(item.CompletionType, COMPLETION_TYPES),
    scoreDenominator: optionalNumber(assessment.ScoreDenominator),
  };
}

function feedbackOf(value: unknown): Feedback | null {
  if (!isRecord(value)) return null;
  const rich = richOf(value.Feedback);
  return {
    score: optionalNumber(value.Score),
    isGraded: optionalBoolean(value.IsGraded),
    text: rich.text,
    html: rich.html,
    files: attachmentsOf(value.Files),
  };
}

function submissionFilesOf(value: unknown): SubmissionFile[] {
  if (!Array.isArray(value)) return [];
  const out: SubmissionFile[] = [];
  for (const item of value) {
    const file = attachmentOf(item);
    if (file === null || !isRecord(item)) continue;
    out.push({
      ...file,
      isRead: optionalBoolean(item.isRead ?? item.IsRead),
      isFlagged: optionalBoolean(item.isFlagged ?? item.IsFlagged),
    });
  }
  return out;
}

function submissionEntriesOf(value: unknown): SubmissionEntry[] {
  if (!Array.isArray(value)) return [];
  const out: SubmissionEntry[] = [];
  for (const item of value) {
    if (!isRecord(item)) continue;
    const by = isRecord(item.SubmittedBy) ? item.SubmittedBy : null;
    out.push({
      id: d2lId(item.Id),
      submittedBy: by ? { id: d2lId(by.Id), displayName: optionalString(by.DisplayName) } : null,
      date: isoSeconds(item.SubmissionDate),
      comment: isRecord(item.Comment) ? richOf(item.Comment) : null,
      files: submissionFilesOf(item.Files),
    });
  }
  return out;
}

/** One EntityDropbox onto the Submission shape; null unless it is an object. */
export function submissionOf(
  item: unknown,
  ou: number,
  folderId: number,
  baseUrl: string,
): Submission | null {
  if (!isRecord(item)) return null;
  const entity = isRecord(item.Entity) ? item.Entity : {};
  return {
    entityId: d2lId(entity.EntityId),
    entityType: optionalString(entity.EntityType),
    name: optionalString(entity.DisplayName) ?? optionalString(entity.Name),
    folderId,
    courseId: ou,
    status: enumName(item.Status, SUBMISSION_STATUSES),
    completionDate: isoSeconds(item.CompletionDate),
    feedback: feedbackOf(item.Feedback),
    submissions: submissionEntriesOf(item.Submissions),
    url: assignmentUrl(baseUrl, ou, folderId),
  };
}

// ---------------------------------------------------------------------------------------------
// File names for downloads
// ---------------------------------------------------------------------------------------------

/**
 * RFC 6266: `filename*=charset'lang'percent-encoded` wins over `filename="..."` / `filename=...`.
 * Returns the raw (unsanitised) name or null when the header names nothing.
 */
export function contentDispositionFilename(header: string | undefined): string | null {
  if (header === undefined) return null;
  const extended = /filename\*\s*=\s*([^']*)'[^']*'([^;]+)/i.exec(header);
  if (extended?.[2]) {
    const encoded = extended[2].trim().replace(/^"|"$/g, '');
    try {
      const decoded = decodeURIComponent(encoded);
      if (decoded.trim() !== '') return decoded;
    } catch {
      // Fall through to the plain form.
    }
  }
  const quoted = /filename\s*=\s*"((?:[^"\\]|\\.)*)"/i.exec(header);
  if (quoted?.[1] !== undefined) {
    const name = quoted[1].replace(/\\(.)/g, '$1');
    return name.trim() === '' ? null : name;
  }
  const bare = /filename\s*=\s*([^;]+)/i.exec(header);
  if (bare?.[1] !== undefined) {
    const name = bare[1].trim();
    return name === '' ? null : name;
  }
  return null;
}

const MAX_FILE_NAME_BYTES = 255;

/**
 * A single path component safe to join under the out directory: directories stripped (both
 * separators), control characters removed, leading dots dropped (no hidden or `..` names),
 * whitespace trimmed, length capped; `fallback` when nothing usable remains.
 */
export function safeFileName(raw: string | null | undefined, fallback: string): string {
  if (typeof raw !== 'string') return fallback;
  const last = raw.split(/[\\/]/).pop() ?? '';
  let name = last
    // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what we strip
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/^\.+/, '')
    .trim();
  if (name === '') return fallback;
  while (Buffer.byteLength(name, 'utf8') > MAX_FILE_NAME_BYTES) name = name.slice(0, -1);
  return name === '' ? fallback : name;
}
