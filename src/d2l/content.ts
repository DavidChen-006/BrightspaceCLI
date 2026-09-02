/**
 * Content (d2l-api-web A-17, A-18, A-19; Brightspace-Bar sweep A-17).
 *
 * - `content/toc?ignoreDateRestrictions=true` is one GET per course returning `{Modules:[...]}`,
 *   a tree of modules (`Modules[]`, `Topics[]`). TOC topics carry NO DueDate/Description; their
 *   server `Url` is the deep link (absolute for link topics, a content-space path for file
 *   topics — absolutised against the tenant here, never rebuilt from a template).
 * - `content/topics/(id)` is one ContentObject Topic (has DueDate, Description); 400 when the
 *   id names a module.
 * - `content/modules/(id)/structure/` is an array of ContentObject (Module `Type:0`, Topic `Type:1`).
 * - `content/topics/(id)/file` streams the bytes of a file topic; 400 "Content topic is not a
 *   file" for link/LTI/quiz topics (PRD 6.4: a usage error naming the topic `Url`).
 *
 * `flattenToc()` / `tocTree()` / `topicDetailOf()` / `moduleChildOf()` are pure parsers onto the
 * PRD 6.3 Topic shape (`kind: 'content'`): every value is read, dates normalise to whole-second
 * UTC or null, enums map to their CONTENTACTIVITYTYPE_T / CONTENT_TOPIC_T names with the numeric
 * id kept alongside. No live capture exists (sweep A-17): fixtures are doc-shaped.
 */
import { isoSeconds } from '../core/dates.js';
import { UsageError } from '../core/errors.js';
import {
  classify,
  d2lUrl,
  type HttpClient,
  type StreamOutcome,
  toError,
} from '../core/http/index.js';
import { isRecord, optionalBoolean, optionalString } from './common.js';
import type { LeTenant } from './quizzes.js';

// ---------------------------------------------------------------------------------------------
// Wire shapes (documented fields only; parsers tolerate anything missing)
// ---------------------------------------------------------------------------------------------

export interface TocTopic {
  TopicId: number;
  Identifier: string;
  TypeIdentifier: string;
  Title: string;
  Bookmarked: boolean;
  Unread: boolean;
  Url: string | null;
  SortOrder: number;
  StartDateTime: string | null;
  EndDateTime: string | null;
  ActivityId: string | null;
  CompletionType: number;
  IsExempt: boolean;
  IsHidden: boolean;
  IsLocked: boolean;
  IsBroken: boolean;
  ToolId: number | null;
  ToolItemId: number | null;
  ActivityType: number;
  GradeItemId: number | null;
  LastModifiedDate: string | null;
}

export interface TocModuleData {
  ModuleId: number;
  Title: string;
  SortOrder: number;
  StartDateTime: string | null;
  EndDateTime: string | null;
  Modules: TocModuleData[];
  Topics: TocTopic[];
  IsHidden: boolean;
  IsLocked: boolean;
  PacingStartDate: string | null;
  PacingEndDate: string | null;
  DefaultPath: string | null;
  LastModifiedDate: string | null;
}

export interface TableOfContents {
  Modules: TocModuleData[];
}

export interface RichText {
  Text: string;
  Html: string;
}

/** `content/topics/(id)` and the `Type:1` entries of `modules/(id)/structure/`. */
export interface ContentTopic {
  TopicType: number;
  Url: string | null;
  StartDate: string | null;
  EndDate: string | null;
  DueDate: string | null;
  IsHidden: boolean;
  IsLocked: boolean;
  IsBroken: boolean;
  OpenAsExternalResource: boolean | null;
  Id: number;
  Title: string;
  ShortTitle: string | null;
  Type: 1;
  Description: RichText | null;
  ParentModuleId: number | null;
  ActivityId: string | null;
  Duration: number | null;
  IsExempt: boolean;
  ToolId: number | null;
  ToolItemId: number | null;
  ActivityType: number;
  GradeItemId: number | null;
  LastModifiedDate: string | null;
  AssociatedGradeItemIds: number[];
}

/** The `Type:0` entries of `modules/(id)/structure/`. */
export interface ContentModule {
  Structure: unknown[];
  ModuleStartDate: string | null;
  ModuleEndDate: string | null;
  ModuleDueDate: string | null;
  IsHidden: boolean;
  IsLocked: boolean;
  Id: number;
  Title: string;
  ShortTitle: string | null;
  Color: string | null;
  Type: 0;
  Description: RichText | null;
  ParentModuleId: number | null;
  Duration: number | null;
  LastModifiedDate: string | null;
}

export type ContentObject = ContentTopic | ContentModule;

// ---------------------------------------------------------------------------------------------
// Enums (d2l-api-web A-17 CONTENTACTIVITYTYPE_T, A-18 CONTENT_TOPIC_T)
// ---------------------------------------------------------------------------------------------

const ACTIVITY_TYPES: Readonly<Record<number, string>> = {
  [-1]: 'Unknown',
  0: 'Module',
  1: 'File',
  2: 'Link',
  3: 'Dropbox',
  4: 'Quiz',
  5: 'DiscussionForum',
  6: 'DiscussionTopic',
  7: 'LTI',
  8: 'Chat',
  9: 'Schedule',
  10: 'Checklist',
  11: 'SelfAssessment',
  12: 'Survey',
  13: 'OnlineRoom',
  14: 'CourseLink',
  20: 'Scorm',
  21: 'Scorm',
  22: 'Scorm',
  23: 'Scorm',
  24: 'Scorm',
  25: 'Lor',
  26: 'LorScorm',
  27: 'LTIAdvantage',
  28: 'OrgUnit',
  29: 'ActivityInstance',
};

const TOPIC_TYPES: Readonly<Record<number, string>> = {
  1: 'File',
  3: 'Link',
  5: 'Scorm',
  6: 'Scorm',
  7: 'Scorm',
  8: 'Scorm',
};

/** `ToolId` of externally hosted LTI topics (Brightspace-Bar sweep A-17): never downloadable. */
export const LTI_TOOL_ID = 390000;

export function activityTypeName(value: unknown): string {
  return (typeof value === 'number' && ACTIVITY_TYPES[value]) || 'Unknown';
}

export function topicTypeName(value: unknown): string {
  return (typeof value === 'number' && TOPIC_TYPES[value]) || 'Unknown';
}

// ---------------------------------------------------------------------------------------------
// Curated shapes (PRD 6.3 Topic, kind 'content')
// ---------------------------------------------------------------------------------------------

/** One TOC topic: the PRD Topic shape plus its module `path` and `depth`. */
export interface Topic {
  id: number;
  courseId: number;
  kind: 'content';
  moduleId: number | null;
  /** 1 for a topic in a top-level module. */
  depth: number;
  /** Module titles from the root, joined with " / " (instructor-authored, like `title`). */
  path: string;
  /** Instructor-authored: wrapped under --wrap-untrusted. */
  title: string;
  /** CONTENTACTIVITYTYPE_T name (`File`, `Link`, `Quiz`, `LTI`, ...); `activityTypeId` is the number. */
  activityType: string;
  activityTypeId: number | null;
  toolId: number | null;
  toolItemId: number | null;
  /** The server `Url`, absolutised against the tenant; null when D2L sent none. */
  url: string | null;
  /** Always null on TOC rows (A-17: no DueDate there); set on `bs content get`. */
  dueDate: string | null;
  startDate: string | null;
  endDate: string | null;
  isHidden: boolean;
  isLocked: boolean;
  isExempt: boolean;
  isBroken: boolean;
  gradeItemId: number | null;
}

/** One module of the TOC tree with its topics and child modules. */
export interface TocModule {
  id: number;
  courseId: number;
  kind: 'module';
  parentId: number | null;
  /** 0 for a top-level module. */
  depth: number;
  /** Instructor-authored: wrapped under --wrap-untrusted. */
  title: string;
  startDate: string | null;
  endDate: string | null;
  isHidden: boolean;
  isLocked: boolean;
  lastModified: string | null;
  topics: Topic[];
  modules: TocModule[];
}

/** `bs content get`: the Topic shape (no TOC path/depth) plus dueDate, description and type. */
export interface TopicDetail {
  id: number;
  courseId: number;
  kind: 'content';
  moduleId: number | null;
  /** Not derivable from the single-topic route; `bs content toc --flat` has it. */
  path: null;
  title: string;
  activityType: string;
  activityTypeId: number | null;
  /** CONTENT_TOPIC_T name (`File`, `Link`, `Scorm`); only `File` topics can be downloaded. */
  topicType: string;
  topicTypeId: number | null;
  toolId: number | null;
  toolItemId: number | null;
  url: string | null;
  dueDate: string | null;
  startDate: string | null;
  endDate: string | null;
  isHidden: boolean;
  isLocked: boolean;
  isExempt: boolean;
  isBroken: boolean;
  gradeItemId: number | null;
  associatedGradeItemIds: number[];
  openAsExternalResource: boolean | null;
  /** Instructor-authored free text: wrapped under --wrap-untrusted. */
  description: string | null;
  descriptionHtml: string | null;
  activityId: string | null;
  duration: number | null;
  lastModified: string | null;
}

/** A child module as `modules/(id)/structure/` reports it. */
export interface ModuleSummary {
  id: number;
  courseId: number;
  kind: 'module';
  parentId: number | null;
  title: string;
  description: string | null;
  descriptionHtml: string | null;
  dueDate: string | null;
  startDate: string | null;
  endDate: string | null;
  isHidden: boolean;
  isLocked: boolean;
  lastModified: string | null;
}

export type ModuleChild = ModuleSummary | TopicDetail;

export const TOPIC_COLUMNS: readonly (keyof Topic)[] = [
  'id',
  'courseId',
  'kind',
  'moduleId',
  'depth',
  'path',
  'title',
  'activityType',
  'activityTypeId',
  'toolId',
  'toolItemId',
  'url',
  'dueDate',
  'startDate',
  'endDate',
  'isHidden',
  'isLocked',
  'isExempt',
  'isBroken',
  'gradeItemId',
];

/** Union of the two child shapes; a cell is empty where a kind lacks the key. */
export const MODULE_CHILD_COLUMNS: readonly (keyof ModuleSummary | keyof TopicDetail)[] = [
  'id',
  'courseId',
  'kind',
  'title',
  'parentId',
  'moduleId',
  'activityType',
  'topicType',
  'url',
  'dueDate',
  'startDate',
  'endDate',
  'isHidden',
  'isLocked',
  'gradeItemId',
];

// ---------------------------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------------------------

function contentBase(cfg: LeTenant, ou: number): string {
  return `/d2l/api/le/${cfg.leVersion}/${ou}/content`;
}

export function contentTocUrl(cfg: LeTenant, ou: number): string {
  return d2lUrl(cfg.baseUrl, `${contentBase(cfg, ou)}/toc`, { ignoreDateRestrictions: true });
}

export function contentTopicUrl(cfg: LeTenant, ou: number, topicId: number): string {
  return d2lUrl(cfg.baseUrl, `${contentBase(cfg, ou)}/topics/${topicId}`);
}

export function contentTopicFileUrl(cfg: LeTenant, ou: number, topicId: number): string {
  return d2lUrl(cfg.baseUrl, `${contentBase(cfg, ou)}/topics/${topicId}/file`);
}

export function contentModuleStructureUrl(cfg: LeTenant, ou: number, moduleId: number): string {
  return d2lUrl(cfg.baseUrl, `${contentBase(cfg, ou)}/modules/${moduleId}/structure/`);
}

export function getToc(http: HttpClient, cfg: LeTenant, ou: number): Promise<TableOfContents> {
  return http.json<TableOfContents>({ method: 'GET', url: contentTocUrl(cfg, ou) });
}

/**
 * One topic. A 400 here means the id names a module (A-18), which is a usage error (exit 2)
 * rather than an unclassified failure.
 */
export async function getTopic(
  http: HttpClient,
  cfg: LeTenant,
  ou: number,
  topicId: number,
): Promise<ContentTopic> {
  const response = await http.request({ method: 'GET', url: contentTopicUrl(cfg, ou, topicId) });
  const c = classify(response, { expectJson: true });
  if (c.kind === 'Failed' && c.status === 400) {
    throw new UsageError(c.message, {
      hint: `${topicId} is not a topic id (a module id?). Run: bs content module ${ou} ${topicId}  or: bs content toc ${ou} --flat`,
    });
  }
  if (c.kind !== 'ok') throw toError(c);
  return JSON.parse(response.body) as ContentTopic;
}

export function getModuleStructure(
  http: HttpClient,
  cfg: LeTenant,
  ou: number,
  moduleId: number,
): Promise<unknown> {
  return http.json<unknown>({ method: 'GET', url: contentModuleStructureUrl(cfg, ou, moduleId) });
}

/** The file bytes on 2xx; otherwise the buffered response for the caller to classify. */
export function streamTopicFile(
  http: HttpClient,
  cfg: LeTenant,
  ou: number,
  topicId: number,
  signal?: AbortSignal,
): Promise<StreamOutcome> {
  return http.requestStream({ method: 'GET', url: contentTopicFileUrl(cfg, ou, topicId), signal });
}

// ---------------------------------------------------------------------------------------------
// Parsers
// ---------------------------------------------------------------------------------------------

function optionalInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) ? value : null;
}

function optionalNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function integerList(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is number => typeof v === 'number' && Number.isInteger(v));
}

/** `{Text, Html}` → `{text, html}`; anything else is absent. */
function richTextOf(value: unknown): { text: string | null; html: string | null } {
  if (!isRecord(value)) return { text: null, html: null };
  return { text: optionalString(value.Text), html: optionalString(value.Html) };
}

/**
 * The server `Url` made absolute: link topics carry `https://...`, file topics a content-space
 * path such as `/content/enforced/<ou>-<code>/file.pdf` (A-17). Unparseable values are null.
 */
export function absoluteUrl(baseUrl: string, value: unknown): string | null {
  if (typeof value !== 'string' || value.trim() === '') return null;
  try {
    return new URL(value, `${baseUrl}/`).toString();
  } catch {
    return null;
  }
}

function tocTopicOf(
  item: unknown,
  ou: number,
  baseUrl: string,
  moduleId: number,
  depth: number,
  path: string,
): Topic | null {
  if (!isRecord(item)) return null;
  const id = item.TopicId;
  if (typeof id !== 'number' || !Number.isInteger(id)) return null;
  return {
    id,
    courseId: ou,
    kind: 'content',
    moduleId,
    depth,
    path,
    title: optionalString(item.Title) ?? '',
    activityType: activityTypeName(item.ActivityType),
    activityTypeId: optionalInteger(item.ActivityType),
    toolId: optionalInteger(item.ToolId),
    toolItemId: optionalInteger(item.ToolItemId),
    url: absoluteUrl(baseUrl, item.Url),
    dueDate: isoSeconds(item.DueDate),
    startDate: isoSeconds(item.StartDateTime),
    endDate: isoSeconds(item.EndDateTime),
    isHidden: optionalBoolean(item.IsHidden),
    isLocked: optionalBoolean(item.IsLocked),
    isExempt: optionalBoolean(item.IsExempt),
    isBroken: optionalBoolean(item.IsBroken),
    gradeItemId: optionalInteger(item.GradeItemId),
  };
}

function tocModuleOf(
  item: unknown,
  ou: number,
  baseUrl: string,
  parentId: number | null,
  depth: number,
  parentPath: string,
): TocModule | null {
  if (!isRecord(item)) return null;
  const id = item.ModuleId;
  if (typeof id !== 'number' || !Number.isInteger(id)) return null;
  const title = optionalString(item.Title) ?? '';
  const path = parentPath === '' ? title : `${parentPath} / ${title}`;
  const topics: Topic[] = [];
  for (const raw of Array.isArray(item.Topics) ? item.Topics : []) {
    const topic = tocTopicOf(raw, ou, baseUrl, id, depth + 1, path);
    if (topic !== null) topics.push(topic);
  }
  const modules: TocModule[] = [];
  for (const raw of Array.isArray(item.Modules) ? item.Modules : []) {
    const child = tocModuleOf(raw, ou, baseUrl, id, depth + 1, path);
    if (child !== null) modules.push(child);
  }
  return {
    id,
    courseId: ou,
    kind: 'module',
    parentId,
    depth,
    title,
    startDate: isoSeconds(item.StartDateTime),
    endDate: isoSeconds(item.EndDateTime),
    isHidden: optionalBoolean(item.IsHidden),
    isLocked: optionalBoolean(item.IsLocked),
    lastModified: isoSeconds(item.LastModifiedDate),
    topics,
    modules,
  };
}

/** The `{Modules}` payload as a tree of TocModule; modules without a numeric id are skipped. */
export function tocTree(toc: unknown, ou: number, baseUrl: string): TocModule[] {
  if (!isRecord(toc) || !Array.isArray(toc.Modules)) return [];
  const out: TocModule[] = [];
  for (const raw of toc.Modules) {
    const module = tocModuleOf(raw, ou, baseUrl, null, 0, '');
    if (module !== null) out.push(module);
  }
  return out;
}

/** Walks a tree depth-first: a module's own topics first, then its child modules. */
export function flattenTree(modules: readonly TocModule[]): Topic[] {
  const out: Topic[] = [];
  for (const module of modules) {
    out.push(...module.topics);
    out.push(...flattenTree(module.modules));
  }
  return out;
}

/** One row per topic in document order, each with its module `path`. */
export function flattenToc(toc: unknown, ou: number, baseUrl: string): Topic[] {
  return flattenTree(tocTree(toc, ou, baseUrl));
}

/** One ContentObject Topic (A-18) onto TopicDetail; null when it carries no numeric Id. */
export function topicDetailOf(item: unknown, ou: number, baseUrl: string): TopicDetail | null {
  if (!isRecord(item)) return null;
  const id = item.Id;
  if (typeof id !== 'number' || !Number.isInteger(id)) return null;
  const description = richTextOf(item.Description);
  return {
    id,
    courseId: ou,
    kind: 'content',
    moduleId: optionalInteger(item.ParentModuleId),
    path: null,
    title: optionalString(item.Title) ?? '',
    activityType: activityTypeName(item.ActivityType),
    activityTypeId: optionalInteger(item.ActivityType),
    topicType: topicTypeName(item.TopicType),
    topicTypeId: optionalInteger(item.TopicType),
    toolId: optionalInteger(item.ToolId),
    toolItemId: optionalInteger(item.ToolItemId),
    url: absoluteUrl(baseUrl, item.Url),
    dueDate: isoSeconds(item.DueDate),
    startDate: isoSeconds(item.StartDate),
    endDate: isoSeconds(item.EndDate),
    isHidden: optionalBoolean(item.IsHidden),
    isLocked: optionalBoolean(item.IsLocked),
    isExempt: optionalBoolean(item.IsExempt),
    isBroken: optionalBoolean(item.IsBroken),
    gradeItemId: optionalInteger(item.GradeItemId),
    associatedGradeItemIds: integerList(item.AssociatedGradeItemIds),
    openAsExternalResource:
      typeof item.OpenAsExternalResource === 'boolean' ? item.OpenAsExternalResource : null,
    description: description.text,
    descriptionHtml: description.html,
    activityId: optionalString(item.ActivityId),
    duration: optionalNumber(item.Duration),
    lastModified: isoSeconds(item.LastModifiedDate),
  };
}

function moduleSummaryOf(item: Record<string, unknown>, ou: number): ModuleSummary | null {
  const id = item.Id;
  if (typeof id !== 'number' || !Number.isInteger(id)) return null;
  const description = richTextOf(item.Description);
  return {
    id,
    courseId: ou,
    kind: 'module',
    parentId: optionalInteger(item.ParentModuleId),
    title: optionalString(item.Title) ?? '',
    description: description.text,
    descriptionHtml: description.html,
    dueDate: isoSeconds(item.ModuleDueDate),
    startDate: isoSeconds(item.ModuleStartDate),
    endDate: isoSeconds(item.ModuleEndDate),
    isHidden: optionalBoolean(item.IsHidden),
    isLocked: optionalBoolean(item.IsLocked),
    lastModified: isoSeconds(item.LastModifiedDate),
  };
}

/** One entry of `modules/(id)/structure/`: `Type 0` → ModuleSummary, `Type 1` → TopicDetail. */
export function moduleChildOf(item: unknown, ou: number, baseUrl: string): ModuleChild | null {
  if (!isRecord(item)) return null;
  if (item.Type === 0) return moduleSummaryOf(item, ou);
  if (item.Type === 1) return topicDetailOf(item, ou, baseUrl);
  return null;
}

/** Decodes a structure array, reporting undecodable entries instead of dropping them silently. */
export function moduleChildren(
  items: unknown,
  ou: number,
  baseUrl: string,
  onSkip: (item: unknown) => void = () => {},
): ModuleChild[] | null {
  if (!Array.isArray(items)) return null;
  const out: ModuleChild[] = [];
  for (const item of items) {
    const child = moduleChildOf(item, ou, baseUrl);
    if (child === null) onSkip(item);
    else out.push(child);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Download names (A-19: Content-Disposition, else the topic)
// ---------------------------------------------------------------------------------------------

/** RFC 6266: `filename*=charset''pct-encoded` wins over `filename="..."` / `filename=token`. */
export function filenameFromContentDisposition(header: string | undefined): string | null {
  if (header === undefined || header === '') return null;
  const extended = /filename\*\s*=\s*(?:[\w-]+)?'[^']*'([^;]+)/i.exec(header);
  if (extended?.[1] !== undefined) {
    try {
      const decoded = decodeURIComponent(extended[1].trim().replace(/^"|"$/g, ''));
      if (decoded !== '') return decoded;
    } catch {
      // Malformed percent-encoding: fall through to the plain parameter, then null.
    }
  }
  const plain = /filename\s*=\s*(?:"([^"]*)"|([^;]+))/i.exec(header);
  if (plain === null) return null;
  const name = (plain[1] ?? plain[2] ?? '').trim();
  return name === '' ? null : name;
}

const MAX_FILENAME_LENGTH = 200;

/**
 * A single path component safe on every platform: basename only, no control or reserved
 * characters, no leading dots (hidden files) or surrounding whitespace, bounded length with
 * the extension kept. Empty results fall back to `fallback`.
 */
export function safeFileName(name: string, fallback: string): string {
  const base = name.split(/[\\/]/).pop() ?? '';
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what we strip
  let cleaned = base.replace(/[\x00-\x1f\x7f<>:"|?*]/g, '').trim();
  cleaned = cleaned.replace(/^[. ]+/, '').replace(/[. ]+$/, '');
  if (cleaned === '') return fallback;
  if (cleaned.length > MAX_FILENAME_LENGTH) {
    const dot = cleaned.lastIndexOf('.');
    const ext = dot > 0 && cleaned.length - dot <= 16 ? cleaned.slice(dot) : '';
    cleaned = `${cleaned.slice(0, MAX_FILENAME_LENGTH - ext.length)}${ext}`;
  }
  return cleaned;
}

/** The basename of a file topic's content-space `Url` (`.../lecture01.pdf`), when it has one. */
export function fileNameFromTopicUrl(topic: TopicDetail): string | null {
  if (topic.topicType !== 'File' || topic.url === null) return null;
  try {
    const last = decodeURIComponent(new URL(topic.url).pathname.split('/').pop() ?? '');
    return last.includes('.') ? last : null;
  } catch {
    return null;
  }
}
