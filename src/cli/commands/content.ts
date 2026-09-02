/**
 * `bs content toc|get|module|download` (PRD 6.2, 6.3, 6.4). All four go through `withData`
 * (ladder, one re-mint) and the `src/d2l/content.ts` routes.
 *
 * - `toc` is one GET; the tree (`TocModule[]`) by default, one Topic row per topic with its
 *   module `path` under `--flat`. `--plain` is always the flat rows (TSV cannot nest).
 * - `get` adds `dueDate`/`description` (absent from the TOC); a 400 there is a module id.
 * - `module` lists the children of one module (`modules/(id)/structure/`).
 * - `download` streams `topics/(id)/file` through the shared `src/cli/download.ts` plumbing to
 *   a directory, an exact path or stdout (`.part` + rename, `--force` to overwrite). The name
 *   comes from `Content-Disposition`, else the topic's file `Url`, else its title, else
 *   `topic-<id>`; a 400 "not a file" is exit 2 with the topic type and `url` in the message.
 */
import { type Command, InvalidArgumentError, Option } from 'commander';
import {
  AuthRequiredError,
  BsError,
  CancelledError,
  NotFoundError,
  UsageError,
} from '../../core/errors.js';
import { classify, type HttpClient, type HttpStream, toError } from '../../core/http/index.js';
import { type Row, Table } from '../../core/output.js';
import type { LeTenant } from '../../d2l/common.js';
import {
  fileNameFromTopicUrl,
  flattenTree,
  getModuleStructure,
  getToc,
  getTopic,
  MODULE_CHILD_COLUMNS,
  type ModuleChild,
  moduleChildren,
  streamTopicFile,
  TOPIC_COLUMNS,
  type TocModule,
  type Topic,
  type TopicDetail,
  tocTree,
  topicDetailOf,
} from '../../d2l/content.js';
import { type CliContext, emit } from '../context.js';
import { emitList, emitRaw, listEnvelope, withData } from '../data.js';
import {
  downloadTo,
  filenameFromContentDisposition,
  isStdoutTarget,
  resolveOutTarget,
  STDOUT_TARGET,
  safeFileName,
} from '../download.js';
import { parsePositiveInt, typed } from '../options.js';
import { parseOrgUnit } from './courses.js';

export function parseTopicId(value: string): number {
  if (!/^\d+$/.test(value) || Number(value) <= 0) {
    throw new InvalidArgumentError('expected a positive integer topic id.');
  }
  return Number(value);
}

export function parseModuleId(value: string): number {
  if (!/^\d+$/.test(value) || Number(value) <= 0) {
    throw new InvalidArgumentError('expected a positive integer module id.');
  }
  return Number(value);
}

function notFoundHint(ou: number): string {
  return `Nothing with that id visible in org unit ${ou}? Run: bs content toc ${ou} --flat  (or: bs courses list)`;
}

/** 404 on a content route: the org unit or the id. Everything else passes through. */
function withNotFoundHint<T>(ou: number, fn: () => Promise<T>): Promise<T> {
  return fn().catch((err: unknown) => {
    if (err instanceof NotFoundError) {
      throw new NotFoundError(err.message, { hint: notFoundHint(ou) });
    }
    throw err;
  });
}

// ---------------------------------------------------------------------------------------------
// Human renderings
// ---------------------------------------------------------------------------------------------

function topicTable(rows: readonly Topic[]): string {
  const table = new Table(['ID', 'TYPE', 'TITLE', 'PATH', 'HIDDEN', 'URL']);
  for (const t of rows) {
    table.row([t.id, t.activityType, t.title, t.path, t.isHidden ? 'yes' : 'no', t.url ?? '']);
  }
  return table.render();
}

function treeLines(modules: readonly TocModule[], out: string[]): void {
  for (const m of modules) {
    const indent = '  '.repeat(m.depth);
    const flags = [m.isHidden ? 'hidden' : '', m.isLocked ? 'locked' : ''].filter(Boolean);
    out.push(
      `${indent}[module ${m.id}] ${m.title}${flags.length ? `  (${flags.join(', ')})` : ''}`,
    );
    for (const t of m.topics) {
      const marks = [t.isHidden ? 'hidden' : '', t.isBroken ? 'broken' : ''].filter(Boolean);
      out.push(
        `${indent}  - ${t.id}  ${t.title}  [${t.activityType}]${marks.length ? ` (${marks.join(', ')})` : ''}${t.url ? `  ${t.url}` : ''}`,
      );
    }
    treeLines(m.modules, out);
  }
}

function treeText(modules: readonly TocModule[]): string {
  const lines: string[] = [];
  treeLines(modules, lines);
  return lines.length === 0 ? 'no modules\n' : `${lines.join('\n')}\n`;
}

function topicText(d: TopicDetail): string {
  const lines = [
    `${d.title}  id ${d.id}  course ${d.courseId}  module ${d.moduleId ?? '-'}`,
    `type: ${d.topicType} (${d.activityType})  tool: ${d.toolId ?? '-'}/${d.toolItemId ?? '-'}  grade item: ${d.gradeItemId ?? '-'}`,
    `due: ${d.dueDate ?? '-'}  available: ${d.startDate ?? '-'} → ${d.endDate ?? '-'}`,
    `hidden: ${d.isHidden ? 'yes' : 'no'}  locked: ${d.isLocked ? 'yes' : 'no'}  exempt: ${d.isExempt ? 'yes' : 'no'}  broken: ${d.isBroken ? 'yes' : 'no'}`,
    `url: ${d.url ?? '-'}`,
  ];
  if (d.description) lines.push('', d.description);
  return `${lines.join('\n')}\n`;
}

function childTable(rows: readonly ModuleChild[]): string {
  const table = new Table(['ID', 'KIND', 'TYPE', 'TITLE', 'DUE', 'HIDDEN']);
  for (const c of rows) {
    table.row([
      c.id,
      c.kind,
      c.kind === 'content' ? c.activityType : '',
      c.title,
      c.dueDate ?? '',
      c.isHidden ? 'yes' : 'no',
    ]);
  }
  return table.render();
}

// ---------------------------------------------------------------------------------------------
// Download plumbing
// ---------------------------------------------------------------------------------------------

interface DownloadOptions {
  out?: string;
  stdout?: boolean;
  force?: boolean;
}

interface DownloadResult {
  topicId: number;
  courseId: number;
  fileName: string;
  path: string;
  bytes: number;
  contentType: string | null;
}

/** The topic, or null with a warning when its lookup fails for anything but auth/cancel. */
async function topicOrNull(
  ctx: CliContext,
  http: HttpClient,
  cfg: LeTenant,
  ou: number,
  topicId: number,
  why: string,
): Promise<TopicDetail | null> {
  try {
    return topicDetailOf(await getTopic(http, cfg, ou, topicId), ou, cfg.baseUrl);
  } catch (err) {
    if (err instanceof AuthRequiredError || err instanceof CancelledError) throw err;
    if (!(err instanceof BsError)) throw err;
    ctx.warn(`${err.message}; ${why}`);
    return null;
  }
}

function notAFile(
  ou: number,
  topicId: number,
  topic: TopicDetail | null,
  message: string,
): UsageError {
  if (topic === null) {
    return new UsageError(`topic ${topicId} is not a file topic (${message})`, {
      hint: `Only File topics have bytes to download. Run: bs content get ${ou} ${topicId}  for its type and url`,
    });
  }
  const what = `${topic.topicType === 'Unknown' ? topic.activityType : topic.topicType} topic`;
  return new UsageError(
    `topic ${topicId} "${topic.title}" is a ${what} (activity ${topic.activityType}), not a file: nothing to download`,
    {
      hint: topic.url
        ? `Open it instead: ${topic.url}`
        : `Run: bs content get ${ou} ${topicId}  for its details`,
    },
  );
}

async function pickFileName(
  ctx: CliContext,
  http: HttpClient,
  cfg: LeTenant,
  ou: number,
  topicId: number,
  stream: HttpStream,
  wantName: boolean,
): Promise<string> {
  const fallback = `topic-${topicId}`;
  const fromHeader = filenameFromContentDisposition(stream.headers['content-disposition']);
  if (fromHeader !== null) return safeFileName(fromHeader, fallback);
  if (!wantName) return fallback;
  const topic = await topicOrNull(ctx, http, cfg, ou, topicId, `naming the file ${fallback}`);
  if (topic === null) return fallback;
  // A title is not a path: separators are dropped rather than treated as directories.
  return safeFileName(fileNameFromTopicUrl(topic) ?? topic.title.replace(/[\\/]+/g, ''), fallback);
}

// ---------------------------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------------------------

export function register(program: Command, ctx: CliContext): void {
  const cmd = program.command('content').description('Course content: modules, topics, files');

  cmd
    .command('toc')
    .description(
      'The table of contents of a course: a tree of modules and topics (one GET). TOC topics have no due date; use `content get`.',
    )
    .argument('<ou>', 'org unit id', parseOrgUnit)
    .option('--flat', 'one row per topic with its module path instead of the tree')
    .addOption(
      typed(
        new Option(
          '--limit <n>',
          'stop after n rows (topics with --flat, top-level modules otherwise)',
        ).argParser(parsePositiveInt),
        'number',
      ),
    )
    .option('--raw', 'emit the {Modules} payload as D2L sent it')
    .action(async (ou: number, opts: { flat?: boolean; limit?: number; raw?: boolean }) => {
      const startedAt = Date.now();
      const { raw, baseUrl } = await withData(ctx, (http, cfg) =>
        withNotFoundHint(ou, async () => ({
          raw: await getToc(http, cfg, ou),
          baseUrl: cfg.baseUrl,
        })),
      );
      if (opts.raw) {
        emitRaw(ctx, raw);
        return;
      }
      const tree = tocTree(raw, ou, baseUrl);
      if (opts.flat || ctx.globals.outputMode === 'plain') {
        const rows = flattenTree(tree).slice(0, opts.limit);
        emitList(ctx, listEnvelope(rows, startedAt), {
          tsv: { columns: TOPIC_COLUMNS },
          human: () => topicTable(rows),
        });
        return;
      }
      const modules = tree.slice(0, opts.limit);
      emitList(ctx, listEnvelope(modules, startedAt), {
        tsv: { columns: TOPIC_COLUMNS, rows: flattenTree(modules) as unknown as Row[] },
        human: () => treeText(modules),
      });
    });

  cmd
    .command('get')
    .description('One topic: due date, availability, description, type and url')
    .argument('<ou>', 'org unit id', parseOrgUnit)
    .argument('<topicId>', 'topic id (from `content toc --flat`)', parseTopicId)
    .option('--raw', 'emit the ContentObject Topic as D2L sent it')
    .action(async (ou: number, topicId: number, opts: { raw?: boolean }) => {
      const { raw, baseUrl } = await withData(ctx, (http, cfg) =>
        withNotFoundHint(ou, async () => ({
          raw: await getTopic(http, cfg, ou, topicId),
          baseUrl: cfg.baseUrl,
        })),
      );
      if (opts.raw) {
        emitRaw(ctx, raw);
        return;
      }
      const detail = topicDetailOf(raw, ou, baseUrl);
      if (detail === null) {
        throw new BsError(
          'error',
          `GET ${ou}/content/topics/${topicId}: unexpected response shape`,
          {
            hint: `Run: bs content get ${ou} ${topicId} --raw  to inspect the payload, or bs auth doctor`,
          },
        );
      }
      emit(ctx, {
        value: detail,
        tsv: {
          columns: ['key', 'value'],
          rows: Object.entries(detail).map(([key, value]) => ({ key, value })),
        },
        human: () => topicText(detail),
      });
    });

  cmd
    .command('module')
    .description('The children of one module: sub-modules and topics (with due dates)')
    .argument('<ou>', 'org unit id', parseOrgUnit)
    .argument('<moduleId>', 'module id (from `content toc`)', parseModuleId)
    .option('--raw', 'emit the ContentObject array as D2L sent it')
    .action(async (ou: number, moduleId: number, opts: { raw?: boolean }) => {
      const startedAt = Date.now();
      const { raw, baseUrl } = await withData(ctx, (http, cfg) =>
        withNotFoundHint(ou, async () => ({
          raw: await getModuleStructure(http, cfg, ou, moduleId),
          baseUrl: cfg.baseUrl,
        })),
      );
      if (opts.raw) {
        emitList(ctx, listEnvelope(Array.isArray(raw) ? raw : [raw], startedAt), { raw: true });
        return;
      }
      let skipped = 0;
      const items = moduleChildren(raw, ou, baseUrl, () => {
        skipped += 1;
      });
      if (items === null) {
        throw new BsError(
          'error',
          `GET ${ou}/content/modules/${moduleId}/structure/: expected an array`,
          {
            hint: `Run: bs content module ${ou} ${moduleId} --raw  to inspect the payload, or bs auth doctor`,
          },
        );
      }
      if (skipped > 0)
        ctx.warn(`skipped ${skipped} undecodable entr${skipped === 1 ? 'y' : 'ies'}`);
      emitList(ctx, listEnvelope(items, startedAt), {
        tsv: { columns: MODULE_CHILD_COLUMNS },
        human: () => childTable(items),
      });
    });

  cmd
    .command('download')
    .description(
      'Save the bytes of a File topic. --out is an existing directory (file named from Content-Disposition, else the topic) or an exact path; "-" or --stdout streams to stdout. Non-file topics are exit 2 with their url.',
    )
    .argument('<ou>', 'org unit id', parseOrgUnit)
    .argument('<topicId>', 'topic id of a File topic', parseTopicId)
    .addOption(
      typed(
        new Option('--out <path>', 'directory or file path to write; "-" for stdout'),
        'string',
      ),
    )
    .option('--stdout', 'write the bytes to stdout (same as --out -)')
    .option('--force', 'overwrite an existing file')
    .action(async (ou: number, topicId: number, opts: DownloadOptions) => {
      const toStdout = opts.stdout === true || isStdoutTarget(opts.out);
      if (opts.stdout === true && opts.out !== undefined && !isStdoutTarget(opts.out)) {
        throw new UsageError('--stdout and --out <path> are mutually exclusive');
      }
      const result = await withData(ctx, async (http, cfg): Promise<DownloadResult | null> => {
        const outcome = await streamTopicFile(http, cfg, ou, topicId);
        if (!outcome.ok) {
          const c = classify(outcome.response);
          if (c.kind === 'Failed' && c.status === 400) {
            const topic = await topicOrNull(
              ctx,
              http,
              cfg,
              ou,
              topicId,
              'topic details unavailable',
            );
            throw notAFile(ou, topicId, topic, c.message);
          }
          if (c.kind === 'NotFound') throw new NotFoundError(c.message, { hint: notFoundHint(ou) });
          throw toError(c);
        }
        const { stream } = outcome;
        try {
          const contentType = stream.headers['content-type'] ?? null;
          if (toStdout) {
            const bytes = await downloadTo(ctx, STDOUT_TARGET, stream.body);
            ctx.debug(`content: streamed ${bytes} bytes of topic ${topicId} to stdout`);
            return null;
          }
          const fileName = await pickFileName(ctx, http, cfg, ou, topicId, stream, true);
          const target = await resolveOutTarget(ctx, opts.out, fileName);
          const bytes = await downloadTo(ctx, target, stream.body, {
            force: opts.force === true,
          });
          return {
            topicId,
            courseId: ou,
            fileName,
            path: target.kind === 'stdout' ? '-' : target.path,
            bytes,
            contentType,
          };
        } catch (err) {
          await stream.body.cancel().catch(() => {});
          throw err;
        }
      });
      if (result === null) return;
      emit(ctx, {
        value: result,
        tsv: {
          columns: ['key', 'value'],
          rows: Object.entries(result).map(([key, value]) => ({ key, value })),
        },
        human: () => `wrote ${result.bytes} bytes to ${result.path}\n`,
      });
    });
}
