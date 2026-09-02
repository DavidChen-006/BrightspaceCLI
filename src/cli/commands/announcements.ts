/**
 * `bs announcements list|get|download` (PRD 6.2, 6.3). All three go through `withData`
 * (ladder, one re-mint) and the `src/d2l/announcements.ts` routes. `get` is a filter of the
 * list (D2L exposes no single-item news route); `download` streams attachments to disk through
 * the shared `src/cli/download.ts` plumbing (`.part` + rename, `--force` to overwrite).
 */
import path from 'node:path';
import { type Command, InvalidArgumentError, Option } from 'commander';
import { BsError, NotFoundError } from '../../core/errors.js';
import { displayPath } from '../../core/http/index.js';
import { Table } from '../../core/output.js';
import {
  ANNOUNCEMENT_COLUMNS,
  type Announcement,
  type Attachment,
  announcements,
  listNews,
  streamAttachment,
} from '../../d2l/announcements.js';
import { type CliContext, emit } from '../context.js';
import { emitList, emitRaw, listEnvelope, withData } from '../data.js';
import { resolveOutDir, safeFileName, writeStreamToFile } from '../download.js';
import { parsePositiveInt, typed } from '../options.js';
import { parseOrgUnit } from './courses.js';

const DEFAULT_LIMIT = 20;

// ---------------------------------------------------------------------------------------------
// Flag parsers (pure; exported for tests)
// ---------------------------------------------------------------------------------------------

const DURATION = /^(\d+)([mhdw])$/;
const DURATION_MS: Readonly<Record<string, number>> = {
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
  w: 604_800_000,
};
const CALENDAR_DATE = /^\d{4}-\d{2}-\d{2}$/;
const ISO_DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/;

/**
 * `--since`: an ISO-8601 timestamp, a calendar date (UTC midnight) or a relative duration
 * such as `7d`, `36h`, `90m`, `2w` counted back from `now`.
 */
export function parseSince(value: string, now: Date = new Date()): Date {
  const text = value.trim();
  const relative = DURATION.exec(text);
  if (relative?.[1] !== undefined && relative[2] !== undefined) {
    return new Date(now.getTime() - Number(relative[1]) * (DURATION_MS[relative[2]] ?? 0));
  }
  const iso = CALENDAR_DATE.test(text)
    ? `${text}T00:00:00Z`
    : ISO_DATETIME.test(text)
      ? text
      : null;
  const at = iso === null ? Number.NaN : Date.parse(iso);
  if (
    Number.isNaN(at) ||
    (CALENDAR_DATE.test(text) && !new Date(at).toISOString().startsWith(text))
  ) {
    throw new InvalidArgumentError(
      'expected an ISO-8601 timestamp (2026-09-02T00:00:00Z), a date (2026-09-02) or a duration (7d, 36h, 90m, 2w).',
    );
  }
  return new Date(at);
}

export function parseNewsId(value: string): number {
  if (!/^\d+$/.test(value) || Number(value) <= 0) {
    throw new InvalidArgumentError('expected a positive integer announcement id.');
  }
  return Number(value);
}

export function parseFileId(value: string): number {
  if (!/^\d+$/.test(value) || Number(value) <= 0) {
    throw new InvalidArgumentError('expected a positive integer attachment file id.');
  }
  return Number(value);
}

// ---------------------------------------------------------------------------------------------
// Download helpers
// ---------------------------------------------------------------------------------------------

/** Keeps names unique within one run: a repeat becomes `<stem>-<fileId><ext>`. */
function uniqueName(name: string, fileId: number, used: Set<string>): string {
  let candidate = name;
  if (used.has(candidate)) {
    const ext = path.extname(name);
    candidate = `${name.slice(0, name.length - ext.length)}-${fileId}${ext}`;
  }
  let n = 2;
  while (used.has(candidate)) {
    const ext = path.extname(name);
    candidate = `${name.slice(0, name.length - ext.length)}-${fileId}-${n}${ext}`;
    n += 1;
  }
  used.add(candidate);
  return candidate;
}

export interface DownloadRow {
  fileId: number;
  /** The name D2L sent (data); `path` is the file actually written. */
  fileName: string;
  path: string;
  bytes: number;
}

export const DOWNLOAD_COLUMNS: readonly (keyof DownloadRow)[] = [
  'fileId',
  'fileName',
  'path',
  'bytes',
];

// ---------------------------------------------------------------------------------------------
// Renderings
// ---------------------------------------------------------------------------------------------

function announcementTable(rows: readonly Announcement[]): string {
  const table = new Table(['ID', 'DATE', 'PINNED', 'FILES', 'TITLE']);
  for (const a of rows) {
    table.row([a.id, a.date ?? '', a.pinned ? 'yes' : '', a.attachments.length || '', a.title]);
  }
  return table.render();
}

function detailText(a: Announcement): string {
  const lines = [
    `${a.title}  id ${a.id}`,
    `date: ${a.date ?? '-'}  pinned: ${a.pinned ? 'yes' : 'no'}  course: ${a.courseId}`,
    `url: ${a.url}`,
  ];
  if (a.attachments.length > 0) {
    lines.push('attachments:');
    for (const f of a.attachments) {
      lines.push(`  ${f.fileId}  ${f.fileName}${f.size === null ? '' : `  (${f.size} bytes)`}`);
    }
  }
  if (a.bodyText) lines.push('', a.bodyText);
  return `${lines.join('\n')}\n`;
}

function downloadText(rows: readonly DownloadRow[]): string {
  if (rows.length === 0) return 'no attachments\n';
  return `${rows.map((r) => `wrote ${r.path} (${r.bytes} bytes)`).join('\n')}\n`;
}

// ---------------------------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------------------------

interface ListOptions {
  since?: Date;
  limit: number;
  raw?: boolean;
}

interface DownloadOptions {
  out: string;
  force?: boolean;
}

function notFound(ou: number, newsId: number): NotFoundError {
  return new NotFoundError(`announcement ${newsId} not found in org unit ${ou}`, {
    hint: `Run: bs announcements list ${ou} --json  to see the ids this course exposes`,
  });
}

/** Decodes the list and picks one id; drafts are not announcements, so they are not found. */
function pickAnnouncement(
  ctx: CliContext,
  items: readonly unknown[],
  ou: number,
  baseUrl: string,
  newsId: number,
): { announcement: Announcement; raw: unknown } {
  let skipped = 0;
  const decoded = announcements(items, ou, baseUrl, () => {
    skipped += 1;
  });
  const announcement = decoded.find((a) => a.id === newsId);
  if (announcement === undefined) {
    if (skipped > 0) ctx.warn(`skipped ${skipped} undecodable announcement(s) of ${items.length}`);
    throw notFound(ou, newsId);
  }
  const raw = items.find(
    (item) => typeof item === 'object' && item !== null && (item as { Id?: unknown }).Id === newsId,
  );
  return { announcement, raw };
}

export function register(program: Command, ctx: CliContext): void {
  const cmd = program.command('announcements').description('Course announcements (news items)');

  cmd
    .command('list')
    .description(
      'List announcements for a course, newest first. Drafts (IsPublished false) are excluded.',
    )
    .argument('<ou>', 'org unit id', parseOrgUnit)
    .addOption(
      typed(
        new Option(
          '--since <when>',
          'only items since: ISO timestamp, date (UTC), or duration such as 7d, 36h, 2w',
        ).argParser((value: string) => parseSince(value)),
        'string',
      ),
    )
    .addOption(
      typed(
        new Option('--limit <n>', 'keep the n newest')
          .argParser(parsePositiveInt)
          .default(DEFAULT_LIMIT),
        'number',
      ),
    )
    .option('--raw', 'emit the NewsItems as D2L sent them (drafts included, server order)')
    .action(async (ou: number, opts: ListOptions) => {
      const startedAt = Date.now();
      const query = { since: opts.since };

      if (opts.raw) {
        const items = await withData(ctx, (http, cfg) => listNews(http, cfg, ou, query));
        emitList(ctx, listEnvelope(items.slice(0, opts.limit), startedAt), { raw: true });
        return;
      }

      let skipped = 0;
      let seen = 0;
      const items = await withData(ctx, async (http, cfg) => {
        skipped = 0;
        const raw = await listNews(http, cfg, ou, query);
        seen = raw.length;
        return announcements(raw, ou, cfg.baseUrl, () => {
          skipped += 1;
        }).slice(0, opts.limit);
      });
      if (skipped > 0 && items.length === 0) {
        throw new BsError('error', `none of ${seen} news items was decodable`, {
          hint: `Run: bs announcements list ${ou} --raw  to inspect the payload, or bs auth doctor`,
        });
      }
      if (skipped > 0) ctx.warn(`skipped ${skipped} undecodable announcement(s) of ${seen}`);
      emitList(ctx, listEnvelope(items, startedAt), {
        tsv: { columns: ANNOUNCEMENT_COLUMNS },
        human: () => announcementTable(items),
      });
    });

  cmd
    .command('get')
    .description('One announcement with its full body and attachment list (a filter of the list)')
    .argument('<ou>', 'org unit id', parseOrgUnit)
    .argument('<newsId>', 'announcement id', parseNewsId)
    .option('--raw', 'emit the NewsItem as D2L sent it')
    .action(async (ou: number, newsId: number, opts: { raw?: boolean }) => {
      const { announcement, raw } = await withData(ctx, async (http, cfg) =>
        pickAnnouncement(ctx, await listNews(http, cfg, ou), ou, cfg.baseUrl, newsId),
      );
      if (opts.raw) {
        emitRaw(ctx, raw);
        return;
      }
      emit(ctx, {
        value: announcement,
        tsv: {
          columns: ['key', 'value'],
          rows: Object.entries(announcement).map(([key, value]) => ({ key, value })),
        },
        human: () => detailText(announcement),
      });
    });

  cmd
    .command('download')
    .description(
      'Save attachments of one announcement to a directory: every file, or only <fileId>',
    )
    .argument('<ou>', 'org unit id', parseOrgUnit)
    .argument('<newsId>', 'announcement id', parseNewsId)
    .argument('[fileId]', 'one attachment file id (default: all attachments)', parseFileId)
    .addOption(
      typed(
        new Option('--out <dir>', 'directory to write into (created if missing)').default('.'),
        'string',
      ),
    )
    .option('--force', 'overwrite existing files')
    .action(
      async (ou: number, newsId: number, fileId: number | undefined, opts: DownloadOptions) => {
        const startedAt = Date.now();
        const rows = await withData(ctx, async (http, cfg) => {
          const { announcement } = pickAnnouncement(
            ctx,
            await listNews(http, cfg, ou),
            ou,
            cfg.baseUrl,
            newsId,
          );
          const targets: Attachment[] =
            fileId === undefined
              ? announcement.attachments
              : announcement.attachments.filter((a) => a.fileId === fileId);
          if (fileId !== undefined && targets.length === 0) {
            throw new NotFoundError(`attachment ${fileId} is not on announcement ${newsId}`, {
              hint: `Run: bs announcements get ${ou} ${newsId} --json --select attachments`,
            });
          }
          if (targets.length === 0) {
            ctx.warn(`announcement ${newsId} has no attachments`);
            return [] as DownloadRow[];
          }
          const outDir = await resolveOutDir(ctx, opts.out);
          const used = new Set<string>();
          const written: DownloadRow[] = [];
          for (const target of targets) {
            const name = uniqueName(
              safeFileName(target.fileName, `attachment-${target.fileId}`),
              target.fileId,
              used,
            );
            const file = path.join(outDir, name);
            const stream = await streamAttachment(http, cfg, ou, newsId, target.fileId);
            ctx.debug(`download: ${displayPath(stream.url)} -> ${file}`);
            const bytes = await writeStreamToFile(stream.body, file, {
              force: opts.force === true,
              label: `GET ${displayPath(stream.url)}`,
            });
            written.push({ fileId: target.fileId, fileName: target.fileName, path: file, bytes });
          }
          return written;
        });
        emitList(ctx, listEnvelope(rows, startedAt), {
          tsv: { columns: DOWNLOAD_COLUMNS },
          human: () => downloadText(rows),
        });
      },
    );
}
