/**
 * `bs quizzes list|get|attempts` (PRD 6.2, 6.3). All three go through `withData` (ladder, one
 * re-mint) and the `src/d2l/quizzes.ts` routes; the shapes are the PRD Item (`kind: 'quiz'`),
 * QuizDetail and QuizAttempt. `attempts` first resolves the caller's id via `whoami` because
 * the route needs `?userId=`; learner access is unverified, so a 403 gets a clear hint.
 */
import { type Command, InvalidArgumentError, Option } from 'commander';
import { BsError, NotFoundError, PermissionDeniedError } from '../../core/errors.js';
import { collect } from '../../core/http/index.js';
import { Table } from '../../core/output.js';
import { quizUrl } from '../../d2l/links.js';
import {
  ATTEMPT_COLUMNS,
  attempts,
  getQuiz,
  listAttempts,
  listQuizzes,
  QUIZ_COLUMNS,
  type Quiz,
  type QuizAttempt,
  type QuizDetail,
  quizDetailOf,
  quizzes,
} from '../../d2l/quizzes.js';
import { userOf, whoami } from '../../d2l/users.js';
import { type CliContext, emit } from '../context.js';
import { emitList, emitRaw, listEnvelope, withData } from '../data.js';
import { parsePositiveInt, typed } from '../options.js';
import { parseOrgUnit } from './courses.js';

interface ListOptions {
  limit?: number;
  raw?: boolean;
}

export function parseQuizId(value: string): number {
  if (!/^\d+$/.test(value) || Number(value) <= 0) {
    throw new InvalidArgumentError('expected a positive integer quiz id.');
  }
  return Number(value);
}

function attemptsText(q: Quiz): string {
  if (q.unlimitedAttempts) return 'unlimited';
  return q.attemptsAllowed === null ? '' : String(q.attemptsAllowed);
}

function timeLimitText(q: Quiz): string {
  if (q.timeLimit === null) return '';
  return `${q.timeLimit} min${q.timeLimitEnforced ? '' : ' (not enforced)'}`;
}

function quizTable(rows: readonly Quiz[]): string {
  const table = new Table(['ID', 'TITLE', 'DUE', 'ATTEMPTS', 'TIME LIMIT', 'ACTIVE']);
  for (const q of rows) {
    table.row([
      q.id,
      q.title,
      q.dueDate ?? '',
      attemptsText(q),
      timeLimitText(q),
      q.isActive ? 'yes' : 'no',
    ]);
  }
  return table.render();
}

function attemptTable(rows: readonly QuizAttempt[]): string {
  const table = new Table(['ID', 'ATTEMPT', 'SCORE', 'STARTED', 'COMPLETED', 'PUBLISHED']);
  for (const a of rows) {
    table.row([
      a.id,
      a.attemptNumber ?? '',
      a.score ?? '',
      a.started ?? '',
      a.completed ?? '',
      a.isPublished ? 'yes' : 'no',
    ]);
  }
  return table.render();
}

function detailText(d: QuizDetail): string {
  const lines = [
    `${d.title}  id ${d.id}  course ${d.courseId}`,
    `active: ${d.isActive ? 'yes' : 'no'}  attempts: ${attemptsText(d) || '-'}  time limit: ${timeLimitText(d) || '-'}`,
    `due: ${d.dueDate ?? '-'}  available: ${d.startDate ?? '-'} → ${d.endDate ?? '-'}`,
    `grade item: ${d.gradeItemId ?? '-'}  late submission option: ${d.lateSubmissionOption ?? '-'}  late limit: ${d.lateLimitMinutes === null ? '-' : `${d.lateLimitMinutes} min`}`,
    `url: ${d.url}`,
  ];
  if (d.description) lines.push('', d.description);
  if (d.instructions) lines.push('', d.instructions);
  return `${lines.join('\n')}\n`;
}

/** Collects decoded rows while counting what was seen and skipped, for the warnings below. */
async function decodeAll<T>(
  raw: AsyncIterable<unknown>,
  decode: (
    counted: AsyncIterable<unknown>,
    onSkip: () => void,
  ) => AsyncGenerator<T, void, undefined>,
  limit: number | undefined,
): Promise<{ items: T[]; seen: number; skipped: number }> {
  const stats = { seen: 0, skipped: 0 };
  const counted = (async function* count(): AsyncGenerator<unknown> {
    for await (const item of raw) {
      stats.seen += 1;
      yield item;
    }
  })();
  const items = await collect(
    decode(counted, () => {
      stats.skipped += 1;
    }),
    limit,
  );
  return { items, ...stats };
}

function reportSkips(
  ctx: CliContext,
  what: string,
  result: { items: unknown[]; seen: number; skipped: number },
  rawHint: string,
): void {
  if (result.skipped > 0 && result.items.length === 0) {
    throw new BsError('error', `none of ${result.seen} ${what}(s) was decodable`, {
      hint: `Run: ${rawHint}  to inspect the payload, or bs auth doctor`,
    });
  }
  if (result.skipped > 0) {
    ctx.warn(`skipped ${result.skipped} undecodable ${what}(s) of ${result.seen}`);
  }
}

function limitOption(what: string): Option {
  return typed(
    new Option('--limit <n>', `stop after n ${what} (no further pages fetched)`).argParser(
      parsePositiveInt,
    ),
    'number',
  );
}

export function register(program: Command, ctx: CliContext): void {
  const cmd = program.command('quizzes').description('Quizzes in a course');

  cmd
    .command('list')
    .description('List the quizzes the caller may see in a course. Follows Next paging.')
    .argument('<ou>', 'org unit id', parseOrgUnit)
    .addOption(limitOption('quizzes'))
    .option('--raw', 'emit the QuizReadData objects as D2L sent them')
    .action(async (ou: number, opts: ListOptions) => {
      const page = { warn: (m: string) => ctx.warn(m) };
      const startedAt = Date.now();

      if (opts.raw) {
        const items = await withData(ctx, (http, cfg) =>
          collect(listQuizzes(http, cfg, ou, page), opts.limit),
        );
        emitList(ctx, listEnvelope(items, startedAt), { raw: true });
        return;
      }

      const result = await withData(ctx, (http, cfg) =>
        decodeAll(
          listQuizzes(http, cfg, ou, page),
          (counted, onSkip) => quizzes(counted, ou, cfg.baseUrl, onSkip),
          opts.limit,
        ),
      );
      reportSkips(ctx, 'quiz', result, `bs quizzes list ${ou} --raw`);
      emitList(ctx, listEnvelope(result.items, startedAt), {
        tsv: { columns: QUIZ_COLUMNS },
        human: () => quizTable(result.items),
      });
    });

  cmd
    .command('get')
    .description('One quiz: dates, attempts allowed, time limit, description and instructions')
    .argument('<ou>', 'org unit id', parseOrgUnit)
    .argument('<quizId>', 'quiz id', parseQuizId)
    .option('--raw', 'emit the QuizReadData payload as D2L sent it')
    .action(async (ou: number, quizId: number, opts: { raw?: boolean }) => {
      const { raw, baseUrl } = await withData(ctx, async (http, cfg) => {
        try {
          return { raw: await getQuiz(http, cfg, ou, quizId), baseUrl: cfg.baseUrl };
        } catch (err) {
          if (err instanceof NotFoundError) {
            throw new NotFoundError(err.message, {
              hint: `No quiz ${quizId} visible in org unit ${ou}? Run: bs quizzes list ${ou}`,
            });
          }
          throw err;
        }
      });
      if (opts.raw) {
        emitRaw(ctx, raw);
        return;
      }
      const detail = quizDetailOf(raw, ou, baseUrl);
      if (detail === null) {
        throw new BsError('error', `GET ${ou}/quizzes/${quizId}: unexpected response shape`, {
          hint: `Run: bs quizzes get ${ou} ${quizId} --raw  to inspect the payload, or bs auth doctor`,
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
    .command('attempts')
    .description(
      'Your attempts at one quiz (whoami then attempts/?userId=me). Learner access is unverified: a 403 is reported as such.',
    )
    .argument('<ou>', 'org unit id', parseOrgUnit)
    .argument('<quizId>', 'quiz id', parseQuizId)
    .addOption(limitOption('attempts'))
    .option('--raw', 'emit the QuizAttemptData objects as D2L sent them')
    .action(async (ou: number, quizId: number, opts: ListOptions) => {
      const page = { warn: (m: string) => ctx.warn(m) };
      const startedAt = Date.now();

      const result = await withData(ctx, async (http, cfg) => {
        const me = userOf(await whoami(http, cfg)).id;
        if (me === null) {
          throw new BsError('error', 'whoami returned no user id; cannot filter attempts', {
            hint: 'Run: bs whoami --raw  to inspect the payload',
          });
        }
        try {
          const raw = listAttempts(http, cfg, ou, quizId, me, page);
          if (opts.raw) return { raw: await collect(raw, opts.limit) };
          return await decodeAll(
            raw,
            (counted, onSkip) => attempts(counted, ou, cfg.baseUrl, onSkip),
            opts.limit,
          );
        } catch (err) {
          if (err instanceof PermissionDeniedError) {
            throw new PermissionDeniedError(err.message, {
              hint: `Learner access to quiz attempts is unverified on this tenant (the route may need an instructor role, or the course is past-term). Open the quiz instead: ${quizUrl(cfg.baseUrl, ou, quizId)}`,
            });
          }
          throw err;
        }
      });
      if ('raw' in result) {
        emitList(ctx, listEnvelope(result.raw, startedAt), { raw: true });
        return;
      }
      reportSkips(ctx, 'attempt', result, `bs quizzes attempts ${ou} ${quizId} --raw`);
      emitList(ctx, listEnvelope(result.items, startedAt), {
        tsv: { columns: ATTEMPT_COLUMNS },
        human: () => attemptTable(result.items),
      });
    });
}
