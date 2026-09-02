/**
 * Output writers (PRD 6.1, 6.3, 10.3; gogcli 4, 5, 6, 18).
 *
 * Stdout is an API: only these writers produce data on stdout. Everything human goes to
 * stderr via the CLI context.
 */
import { randomBytes } from 'node:crypto';

export type OutputMode = 'json' | 'plain' | 'human';

/** Minimal writable surface shared by process.stdout and test sinks. */
export interface Sink {
  write(chunk: string): unknown;
}

// ---------------------------------------------------------------------------------------------
// JSON
// ---------------------------------------------------------------------------------------------

export interface UntrustedOptions {
  /** 16 hex chars, random per invocation; the same id closes every block. */
  id: string;
  /** Defaults to "brightspace". */
  source?: string;
}

export interface JsonOptions {
  /** Unwrap {items: [...]} to the array (PRD 6.3). */
  resultsOnly?: boolean;
  /** Dot paths to project, per item for lists. */
  select?: readonly string[];
  /** Wrap free text in untrusted markers; omit or false to leave data untouched. */
  wrap?: UntrustedOptions | false;
}

/** Renders 2-space indented JSON with a trailing newline. JSON.stringify never HTML-escapes. */
export function renderJson(value: unknown, options: JsonOptions = {}): string {
  let out = value;
  if (options.resultsOnly) out = unwrapResults(out);
  if (options.select && options.select.length > 0) out = selectFields(out, options.select);
  if (options.wrap) out = wrapUntrusted(out, options.wrap);
  return `${JSON.stringify(out, null, 2)}\n`;
}

export function writeJson(sink: Sink, value: unknown, options: JsonOptions = {}): void {
  sink.write(renderJson(value, options));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** {items: [...]} -> items; anything else is returned as is. */
export function unwrapResults(value: unknown): unknown {
  if (isRecord(value) && Array.isArray(value.items)) return value.items;
  return value;
}

/** Walks a dot path; numeric segments index arrays. Never broadcasts through arrays. */
export function getAtPath(value: unknown, dotPath: string): unknown {
  let current: unknown = value;
  for (const segment of dotPath.split('.')) {
    if (current === null || current === undefined) return undefined;
    if (Array.isArray(current)) {
      if (!/^\d+$/.test(segment)) return undefined;
      current = current[Number(segment)];
    } else if (typeof current === 'object') {
      current = (current as Record<string, unknown>)[segment];
    } else {
      return undefined;
    }
  }
  return current;
}

function projectOne(item: unknown, paths: readonly string[]): unknown {
  if (!isRecord(item)) return item;
  const out: Record<string, unknown> = {};
  for (const p of paths) {
    const v = getAtPath(item, p);
    if (v !== undefined) out[p] = v;
  }
  return out;
}

/**
 * --select semantics (PRD 6.1): applied per item for arrays and for the `items` of a list
 * envelope (envelope metadata kept); applied once for a bare object. Output keys are the
 * full dot path; unmatched paths are omitted; scalars pass through.
 */
export function selectFields(value: unknown, paths: readonly string[]): unknown {
  if (Array.isArray(value)) return value.map((item) => projectOne(item, paths));
  if (isRecord(value) && Array.isArray(value.items)) {
    return { ...value, items: value.items.map((item) => projectOne(item, paths)) };
  }
  return projectOne(value, paths);
}

// ---------------------------------------------------------------------------------------------
// TSV (--plain)
// ---------------------------------------------------------------------------------------------

export type Row = Record<string, unknown>;

export interface Column {
  header: string;
  /** Row key to read; ignored when `value` is given. */
  key?: string;
  value?: (row: Row) => unknown;
}

/** Cells escape \t, \n, \r and backslash so one row is always one line (PRD 6.1). */
export function tsvEscape(cell: string): string {
  return cell
    .replace(/\\/g, '\\\\')
    .replace(/\t/g, '\\t')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r');
}

export function stringifyCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value);
  }
  return JSON.stringify(value);
}

function normalizeColumns(columns: readonly (string | Column)[]): Column[] {
  return columns.map((c) => (typeof c === 'string' ? { header: c, key: c } : c));
}

/** Header row always emitted; columns are ordered by construction. */
export function renderTsv(rows: readonly Row[], columns: readonly (string | Column)[]): string {
  const cols = normalizeColumns(columns);
  const lines = [cols.map((c) => tsvEscape(c.header)).join('\t')];
  for (const row of rows) {
    lines.push(
      cols
        .map((c) => tsvEscape(stringifyCell(c.value ? c.value(row) : row[c.key ?? c.header])))
        .join('\t'),
    );
  }
  return `${lines.join('\n')}\n`;
}

export function writeTsv(
  sink: Sink,
  rows: readonly Row[],
  columns: readonly (string | Column)[],
): void {
  sink.write(renderTsv(rows, columns));
}

// ---------------------------------------------------------------------------------------------
// Untrusted content wrapping (PRD 10.3, gogcli 5)
// ---------------------------------------------------------------------------------------------

export const UNTRUSTED_SOURCE = 'brightspace';
export const MARKER_START = '<<<EXTERNAL_UNTRUSTED_CONTENT';
export const MARKER_END = '<<<END_EXTERNAL_UNTRUSTED_CONTENT';

/** Fresh 16-hex id; generated once per invocation by the CLI context. */
export function newMarkerId(): string {
  return randomBytes(8).toString('hex');
}

const MARKER_LOOKALIKE =
  /<<<\s*(?:END[\s_]+)?EXTERNAL[\s_]+UNTRUSTED[\s_]+CONTENT(?:\s+[^>]*)?\s*>>>/gis;

const SPECIAL_TOKENS = [
  '<|im_start|>',
  '<|im_end|>',
  '<|endoftext|>',
  '<|begin_of_text|>',
  '<|end_of_text|>',
  '<|start_header_id|>',
  '<|end_header_id|>',
  '<|eot_id|>',
  '<|python_tag|>',
  '<|eom_id|>',
  '[INST]',
  '[/INST]',
  '<<SYS>>',
  '<</SYS>>',
  '<|channel|>',
  '<|message|>',
  '<|return|>',
  '<|call|>',
  '<start_of_turn>',
  '<end_of_turn>',
];
const SPECIAL_TOKEN_PATTERN = new RegExp(
  `${SPECIAL_TOKENS.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')}|<\\|reserved_special_token_\\d+\\|>`,
  'g',
);

export function sanitizeUntrustedText(text: string): string {
  return text
    .replace(MARKER_LOOKALIKE, (match) =>
      /^<<<\s*END/i.test(match) ? '[[END_MARKER_SANITIZED]]' : '[[MARKER_SANITIZED]]',
    )
    .replace(SPECIAL_TOKEN_PATTERN, '[REMOVED_SPECIAL_TOKEN]');
}

export function wrapUntrustedText(text: string, options: UntrustedOptions): string {
  const source = options.source ?? UNTRUSTED_SOURCE;
  return `${MARKER_START} id="${options.id}">>>\nSource: ${source}\n---\n${sanitizeUntrustedText(text)}\n${MARKER_END} id="${options.id}">>>`;
}

/** Keys whose string values are free text from the tenant (PRD 10.3 plus gogcli's general set). */
const CONTENT_KEYS = new Set([
  'title',
  'name',
  'description',
  'instructions',
  'bodytext',
  'bodyhtml',
  'descriptionhtml',
  'html',
  'body',
  'subject',
  'comments',
  'comment',
  'feedback',
  'displayname',
  'author',
  'content',
  'message',
  'note',
  'notes',
  'question',
  'answer',
  'snippet',
  'summary',
  'text',
  'value',
  'raw',
  'renderedtext',
  'firstname',
  'lastname',
  'pronouns',
  'shortname',
]);

/** Any string under these array keys is content (spreadsheet-like payloads from `bs api`). */
const CONTENT_ARRAY_KEYS = new Set(['cells', 'row', 'rows', 'values']);

/** Never wrapped: identifiers, links, dates, enums. Deny wins over allow. */
const METADATA_KEYS = new Set([
  'id',
  'url',
  'uri',
  'link',
  'href',
  'path',
  'kind',
  'type',
  'status',
  'state',
  'role',
  'code',
  'coursecode',
  'email',
  'uniquename',
  'filename',
  'mimetype',
  'etag',
  'bookmark',
  'next',
  'activitytype',
  'associatedtool',
  'scoringtype',
  'source',
  'version',
  'commit',
  'date',
  'build',
  'fetchedat',
  'capturedat',
  'mintedat',
  'lastmodified',
  'lastattemptat',
  'lastsuccessat',
  'jwtexpiresat',
]);
const METADATA_SUFFIXES = ['id', 'ids', 'url', 'link', 'date', 'time', 'at'];

/**
 * Any key spelled `<something>Html` or `<something>Text` is a rendering of tenant free text
 * (`instructionsHtml`, `feedbackHtml`, `bodyText`, ...), so it is content unless it is an
 * explicit metadata key. Deny still wins: `mimeType` is not text.
 */
const CONTENT_SUFFIXES = ['html', 'text'];

/**
 * Keys that are content only on rows of a given `kind`. A content Topic's `path` is the
 * instructor-authored module titles joined with " / "; the `path` of a download summary is a
 * filesystem path and stays a plain string.
 */
const CONTENT_KEYS_BY_KIND: Readonly<Record<string, ReadonlySet<string>>> = {
  content: new Set(['path']),
};
const NO_KEYS: ReadonlySet<string> = new Set();

function normalizeKey(key: string): string {
  return key.replace(/[_-]/g, '').toLowerCase();
}

function shouldWrap(
  key: string,
  ancestors: readonly string[],
  siblingContent: ReadonlySet<string>,
): boolean {
  const k = normalizeKey(key);
  if (siblingContent.has(k)) return true;
  if (METADATA_KEYS.has(k)) return false;
  if (METADATA_SUFFIXES.some((s) => k.length > s.length && k.endsWith(s))) return false;
  if (CONTENT_KEYS.has(k)) return true;
  if (CONTENT_SUFFIXES.some((s) => k.endsWith(s))) return true;
  // Strings inside arrays keep their array's key, so include the key itself here.
  return [...ancestors, key].some((a) => CONTENT_ARRAY_KEYS.has(normalizeKey(a)));
}

/** The keys a record's `kind` promotes to content for its direct children. */
function contentKeysForKind(record: Record<string, unknown>): ReadonlySet<string> {
  const kind = record.kind;
  return typeof kind === 'string' ? (CONTENT_KEYS_BY_KIND[kind] ?? NO_KEYS) : NO_KEYS;
}

function walk(
  value: unknown,
  options: UntrustedOptions,
  key: string,
  ancestors: readonly string[],
  siblingContent: ReadonlySet<string>,
): { value: unknown; wrapped: boolean } {
  if (typeof value === 'string') {
    if (value === '') return { value, wrapped: false };
    const top = key === '' && ancestors.length === 0;
    if (top || shouldWrap(key, ancestors, siblingContent)) {
      return { value: wrapUntrustedText(value, options), wrapped: true };
    }
    return { value, wrapped: false };
  }
  if (Array.isArray(value)) {
    let wrapped = false;
    const out = value.map((item) => {
      const r = walk(item, options, key, ancestors, siblingContent);
      wrapped = wrapped || r.wrapped;
      return r.value;
    });
    return { value: out, wrapped };
  }
  if (isRecord(value)) {
    let wrapped = false;
    const out: Record<string, unknown> = {};
    const nextAncestors = key === '' ? ancestors : [...ancestors, key];
    const byKind = contentKeysForKind(value);
    for (const [k, v] of Object.entries(value)) {
      const r = walk(v, options, k, nextAncestors, byKind);
      out[k] = r.value;
      wrapped = wrapped || r.wrapped;
    }
    return { value: out, wrapped };
  }
  return { value, wrapped: false };
}

/**
 * Wraps free-text strings throughout a JSON value. Ids, URLs, dates, numbers, booleans and
 * nulls are untouched. A top-level object gains the `externalContent` sentinel.
 */
export function wrapUntrusted(value: unknown, options: UntrustedOptions): unknown {
  const source = options.source ?? UNTRUSTED_SOURCE;
  const result = walk(value, { ...options, source }, '', [], NO_KEYS);
  if (isRecord(result.value)) {
    return {
      ...result.value,
      externalContent: { untrusted: true, source, wrapped: result.wrapped },
    };
  }
  return result.value;
}

// ---------------------------------------------------------------------------------------------
// Human table
// ---------------------------------------------------------------------------------------------

/** Space-padded columns for human output (stdout in human mode). */
export class Table {
  private readonly rows: string[][] = [];

  constructor(private readonly headers: readonly string[]) {}

  row(cells: readonly unknown[]): this {
    this.rows.push(cells.map((c) => stringifyCell(c).replace(/\s+/g, ' ')));
    return this;
  }

  render(): string {
    const all = [this.headers.map(String), ...this.rows];
    const widths = this.headers.map((_, i) => Math.max(...all.map((r) => (r[i] ?? '').length)));
    return `${all
      .map((r) =>
        r
          .map((cell, i) => (i === r.length - 1 ? cell : cell.padEnd(widths[i] ?? 0)))
          .join('  ')
          .trimEnd(),
      )
      .join('\n')}\n`;
  }
}

// ---------------------------------------------------------------------------------------------
// Color (gogcli 18)
// ---------------------------------------------------------------------------------------------

export type ColorMode = 'auto' | 'always' | 'never';
export const COLOR_MODES: readonly ColorMode[] = ['auto', 'always', 'never'];

export interface ColorInput {
  env?: NodeJS.ProcessEnv;
  isTTY: boolean;
  outputMode: OutputMode;
}

/** `always` beats NO_COLOR; json/plain force color off; `auto` = TTY and not NO_COLOR/dumb. */
export function resolveColor(mode: ColorMode, input: ColorInput): boolean {
  if (input.outputMode !== 'human') return false;
  if (mode === 'never') return false;
  if (mode === 'always') return true;
  const env = input.env ?? process.env;
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== '') return false;
  if (env.TERM === 'dumb') return false;
  return input.isTTY;
}

const ANSI = {
  red: ['\x1b[31m', '\x1b[39m'],
  green: ['\x1b[32m', '\x1b[39m'],
  yellow: ['\x1b[33m', '\x1b[39m'],
  bold: ['\x1b[1m', '\x1b[22m'],
  dim: ['\x1b[2m', '\x1b[22m'],
} as const;

export type ColorName = keyof typeof ANSI;

export function colorize(text: string, color: ColorName, enabled: boolean): string {
  if (!enabled) return text;
  const [open, close] = ANSI[color];
  return `${open}${text}${close}`;
}
