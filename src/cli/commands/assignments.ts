/**
 * `bs assignments list|get|submissions|download` (PRD 6.2, 6.3). Every verb goes through
 * `withData` (ladder, one re-mint) and the `src/d2l/assignments.ts` routes; the shapes are the
 * PRD Item (`kind: 'assignment'`) and Submission. `download` streams one file through
 * `requestStream` and the shared `src/cli/download.ts` plumbing into `--out` (a directory, a
 * file path, or `-` for raw bytes on stdout).
 */
import { type Command, InvalidArgumentError, Option } from 'commander';
import { BsError, NotFoundError, UsageError } from '../../core/errors.js';
import { classify, toError } from '../../core/http/index.js';
import { type Column, type Row, Table } from '../../core/output.js';
import {
  ASSIGNMENT_COLUMNS,
  type Assignment,
  type AssignmentDetail,
  assignmentDetailOf,
  assignmentOf,
  attachmentUrl,
  getFolder,
  listFolders,
  listMySubmissions,
  type Submission,
  submissionFileUrl,
  submissionOf,
} from '../../d2l/assignments.js';
import { type CliContext, emit } from '../context.js';
import { emitList, emitRaw, listEnvelope, withData } from '../data.js';
import {
  downloadTo,
  filenameFromContentDisposition,
  isStdoutTarget,
  resolveOutTarget,
  safeFileName,
} from '../download.js';
import { parsePositiveInt, typed } from '../options.js';
import { parseOrgUnit } from './courses.js';

function parseId(label: string): (value: string) => number {
  return (value) => {
    if (!/^\d+$/.test(value) || Number(value) <= 0) {
      throw new InvalidArgumentError(`expected a positive integer ${label}.`);
    }
    return Number(value);
  };
}

const parseFolderId = parseId('folder id');
const parseFileId = parseId('file id');

// ---------------------------------------------------------------------------------------------
// Renderings
// ---------------------------------------------------------------------------------------------

function assignmentTable(rows: readonly Assignment[]): string {
  const table = new Table(['ID', 'TITLE', 'DUE', 'START', 'END', 'GRADE ITEM']);
  for (const a of rows) {
    table.row([
      a.id,
      a.title,
      a.dueDate ?? '',
      a.startDate ?? '',
      a.endDate ?? '',
      a.gradeItemId ?? '',
    ]);
  }
  return table.render();
}

function detailText(d: AssignmentDetail): string {
  const lines = [
    `${d.title}  id ${d.id}  course ${d.courseId}${d.isHidden ? '  (hidden)' : ''}`,
    `due: ${d.dueDate ?? '-'}  available: ${d.startDate ?? '-'} → ${d.endDate ?? '-'}`,
    `type: ${d.dropboxType ?? '-'}  submission: ${d.submissionType ?? '-'}  completion: ${d.completionType ?? '-'}  out of: ${d.scoreDenominator ?? '-'}  grade item: ${d.gradeItemId ?? '-'}`,
    `url: ${d.url}`,
  ];
  if (d.attachments.length > 0) {
    lines.push('', 'attachments (bs assignments download <ou> <folderId> <fileId>):');
    for (const a of d.attachments) {
      lines.push(`  ${a.fileId ?? '?'}  ${a.fileName ?? ''}  ${a.size ?? ''}`);
    }
  }
  if (d.linkAttachments.length > 0) {
    lines.push('', 'links (external resources, not the assignment page):');
    for (const l of d.linkAttachments) lines.push(`  ${l.name ?? ''}  ${l.href ?? ''}`);
  }
  if (d.instructions.text) lines.push('', d.instructions.text);
  return `${lines.join('\n')}\n`;
}

function submissionCounts(s: Submission): {
  submissionCount: number;
  fileCount: number;
  lastSubmittedAt: string | null;
} {
  let fileCount = 0;
  let last: string | null = null;
  for (const entry of s.submissions) {
    fileCount += entry.files.length;
    if (entry.date !== null && (last === null || entry.date > last)) last = entry.date;
  }
  return { submissionCount: s.submissions.length, fileCount, lastSubmittedAt: last };
}

const SUBMISSION_COLUMNS: readonly Column[] = [
  { header: 'entityId' },
  { header: 'entityType' },
  { header: 'name' },
  { header: 'status' },
  { header: 'completionDate' },
  { header: 'score', value: (r) => (r as unknown as Submission).feedback?.score ?? null },
  { header: 'isGraded', value: (r) => (r as unknown as Submission).feedback?.isGraded ?? null },
  {
    header: 'submissionCount',
    value: (r) => submissionCounts(r as unknown as Submission).submissionCount,
  },
  { header: 'fileCount', value: (r) => submissionCounts(r as unknown as Submission).fileCount },
  {
    header: 'lastSubmittedAt',
    value: (r) => submissionCounts(r as unknown as Submission).lastSubmittedAt,
  },
  { header: 'url' },
];

function submissionsText(rows: readonly Submission[], ou: number, folderId: number): string {
  if (rows.length === 0) return `no submissions yet for folder ${folderId} in course ${ou}\n`;
  const lines: string[] = [];
  for (const s of rows) {
    const c = submissionCounts(s);
    lines.push(
      `${s.entityType ?? 'entity'} ${s.name ?? s.entityId ?? '?'}: ${s.status ?? '-'}  completed: ${s.completionDate ?? '-'}  submissions: ${c.submissionCount}`,
    );
    if (s.feedback) {
      lines.push(
        `  feedback: score ${s.feedback.score ?? '-'}  graded: ${s.feedback.isGraded ? 'yes' : 'no'}${s.feedback.text ? `  ${s.feedback.text}` : ''}`,
      );
      for (const f of s.feedback.files) {
        lines.push(`    feedback file ${f.fileId ?? '?'}  ${f.fileName ?? ''}  ${f.size ?? ''}`);
      }
    }
    for (const entry of s.submissions) {
      lines.push(`  submission ${entry.id ?? '?'}  ${entry.date ?? '-'}`);
      for (const f of entry.files) {
        lines.push(
          `    file ${f.fileId ?? '?'}  ${f.fileName ?? ''}  ${f.size ?? ''}  (bs assignments download ${ou} ${folderId} ${f.fileId ?? '?'} --submission ${entry.id ?? '?'})`,
        );
      }
    }
    lines.push(`  url: ${s.url}`);
  }
  return `${lines.join('\n')}\n`;
}

function notFoundHint(err: unknown, hint: string): never {
  if (err instanceof NotFoundError) throw new NotFoundError(err.message, { hint });
  throw err;
}

// ---------------------------------------------------------------------------------------------
// download
// ---------------------------------------------------------------------------------------------

interface DownloadOptions {
  submission?: number;
  out?: string;
  force?: boolean;
}

interface DownloadResult {
  fileId: number;
  submissionId: number | null;
  fileName: string;
  /** `-` when the bytes went to stdout. */
  path: string;
  bytes: number;
  contentType: string | null;
}

// ---------------------------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------------------------

export function register(program: Command, ctx: CliContext): void {
  const cmd = program.command('assignments').description('Assignment (dropbox) folders');

  cmd
    .command('list')
    .description('List the assignment folders of a course (one request; the route is a bare array)')
    .argument('<ou>', 'org unit id', parseOrgUnit)
    .option('--raw', 'emit the DropboxFolder items as D2L sent them')
    .action(async (ou: number, opts: { raw?: boolean }) => {
      const startedAt = Date.now();
      const { items: raw, baseUrl } = await withData(ctx, async (http, cfg) => ({
        items: await listFolders(http, cfg, ou),
        baseUrl: cfg.baseUrl,
      }));
      if (opts.raw) {
        emitList(ctx, listEnvelope(raw, startedAt), { raw: true });
        return;
      }
      const items: Assignment[] = [];
      let skipped = 0;
      for (const item of raw) {
        const a = assignmentOf(item, ou, baseUrl);
        if (a === null) skipped += 1;
        else items.push(a);
      }
      if (skipped > 0 && items.length === 0) {
        throw new BsError('error', `none of ${raw.length} assignment folders was decodable`, {
          hint: `Run: bs assignments list ${ou} --raw  to inspect the payload, or bs auth doctor`,
        });
      }
      if (skipped > 0)
        ctx.warn(`skipped ${skipped} undecodable assignment folder(s) of ${raw.length}`);
      emitList(ctx, listEnvelope(items, startedAt), {
        tsv: { columns: ASSIGNMENT_COLUMNS },
        human: () => assignmentTable(items),
      });
    });

  cmd
    .command('get')
    .description('One assignment folder: instructions, attachments, availability, due date')
    .argument('<ou>', 'org unit id', parseOrgUnit)
    .argument('<folderId>', 'dropbox folder id (from: bs assignments list <ou>)', parseFolderId)
    .option('--raw', 'emit the DropboxFolder as D2L sent it')
    .action(async (ou: number, folderId: number, opts: { raw?: boolean }) => {
      const { folder, baseUrl } = await withData(ctx, async (http, cfg) => {
        try {
          return { folder: await getFolder(http, cfg, ou, folderId), baseUrl: cfg.baseUrl };
        } catch (err) {
          return notFoundHint(err, `Run: bs assignments list ${ou}  to see the folder ids`);
        }
      });
      if (opts.raw) {
        emitRaw(ctx, folder);
        return;
      }
      const detail = assignmentDetailOf(folder, ou, baseUrl);
      if (detail === null) {
        throw new BsError('error', `GET dropbox/folders/${folderId}: unexpected response shape`, {
          hint: `Run: bs assignments get ${ou} ${folderId} --raw  to inspect the payload, or bs auth doctor`,
        });
      }
      emit(ctx, {
        value: detail,
        tsv: {
          columns: ['key', 'value'],
          rows: Object.entries(detail).map(([key, value]) => ({ key, value })),
        },
        human: () => detailText(detail),
      });
    });

  cmd
    .command('submissions')
    .description('My submissions to an assignment folder: status, files, feedback score')
    .argument('<ou>', 'org unit id', parseOrgUnit)
    .argument('<folderId>', 'dropbox folder id', parseFolderId)
    .option('--raw', 'emit the EntityDropbox items as D2L sent them')
    .action(async (ou: number, folderId: number, opts: { raw?: boolean }) => {
      const startedAt = Date.now();
      const { items: raw, baseUrl } = await withData(ctx, async (http, cfg) => {
        try {
          return { items: await listMySubmissions(http, cfg, ou, folderId), baseUrl: cfg.baseUrl };
        } catch (err) {
          return notFoundHint(err, `Run: bs assignments list ${ou}  to see the folder ids`);
        }
      });
      if (opts.raw) {
        emitList(ctx, listEnvelope(raw, startedAt), { raw: true });
        return;
      }
      const items = raw
        .map((item) => submissionOf(item, ou, folderId, baseUrl))
        .filter((s): s is Submission => s !== null);
      if (items.length < raw.length) {
        ctx.warn(`skipped ${raw.length - items.length} undecodable submission entr(y/ies)`);
      }
      emitList(ctx, listEnvelope(items, startedAt), {
        tsv: { columns: SUBMISSION_COLUMNS, rows: items as unknown as Row[] },
        human: () => submissionsText(items, ou, folderId),
      });
    });

  cmd
    .command('download')
    .description(
      'Download one file: an instructor attachment of the folder, or with --submission one of your submitted files',
    )
    .argument('<ou>', 'org unit id', parseOrgUnit)
    .argument('<folderId>', 'dropbox folder id', parseFolderId)
    .argument(
      '<fileId>',
      'file id (attachments: bs assignments get; submitted files: bs assignments submissions)',
      parseFileId,
    )
    .addOption(
      typed(
        new Option(
          '--submission <sid>',
          'the file belongs to this submission of yours (id from: bs assignments submissions)',
        ).argParser(parsePositiveInt),
        'number',
      ),
    )
    .addOption(
      typed(
        new Option(
          '--out <path>',
          'destination: a directory (trailing slash creates it), a file path, or - for raw bytes on stdout; default: the current directory',
        ),
        'string',
      ),
    )
    .option('--force', 'overwrite an existing file')
    .action(async (ou: number, folderId: number, fileId: number, opts: DownloadOptions) => {
      const toStdout = isStdoutTarget(opts.out);
      if (toStdout && ctx.globals.outputMode !== 'human') {
        throw new UsageError(
          '--out - writes the file bytes to stdout and cannot be combined with --json or --plain',
          {
            hint: 'Drop --json/--plain, or pass --out <path> to get a JSON/TSV summary instead.',
          },
        );
      }
      const submissionId = opts.submission ?? null;
      const result = await withData(ctx, async (http, cfg): Promise<DownloadResult> => {
        const url =
          submissionId === null
            ? attachmentUrl(cfg, ou, folderId, fileId)
            : submissionFileUrl(cfg, ou, folderId, submissionId, fileId);
        const outcome = await http.requestStream({ method: 'GET', url });
        if (!outcome.ok) {
          const err = toError(classify(outcome.response));
          return notFoundHint(
            err,
            `Check the file id: bs assignments get ${ou} ${folderId}  lists attachments; bs assignments submissions ${ou} ${folderId}  lists your submitted files (pass --submission <sid> for those).`,
          );
        }
        const { stream } = outcome;
        const fileName = safeFileName(
          filenameFromContentDisposition(stream.headers['content-disposition']),
          `file-${fileId}`,
        );
        const contentType = stream.headers['content-type']?.split(';')[0]?.trim() || null;
        const target = await resolveOutTarget(ctx, opts.out, fileName);
        const bytes = await downloadTo(ctx, target, stream.body, { force: opts.force === true });
        return {
          fileId,
          submissionId,
          fileName,
          path: target.kind === 'stdout' ? '-' : target.path,
          bytes,
          contentType,
        };
      });
      if (toStdout) {
        ctx.debug(`wrote ${result.bytes} bytes (${result.fileName}) to stdout`);
        return;
      }
      emit(ctx, {
        value: result,
        human: () => `wrote ${result.bytes} bytes to ${result.path}\n`,
      });
    });
}
