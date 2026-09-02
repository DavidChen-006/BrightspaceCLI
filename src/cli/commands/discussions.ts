/**
 * `bs discussions forums|topics|posts` (PRD 6.2, 6.3). All three go through `withData` (ladder,
 * one re-mint) and the `src/d2l/discussions.ts` routes.
 *
 * `topics <ou>` without a forum walks `forums/` then every forum's `topics/` through a bounded
 * pool (`BS_CONCURRENCY`, PRD 8.3) with per-forum isolation: one forum failing costs only its
 * topics (warning); every forum failing reports the first error (403 → 6, 404 → 5).
 * `posts` pages with `pageSize`/`pageNumber` (stop on a short page); `--limit` stops fetching.
 */
import { type Command, InvalidArgumentError, Option } from 'commander';
import { AuthRequiredError, BsError, CancelledError, NotFoundError } from '../../core/errors.js';
import { boundedPool, collect } from '../../core/http/index.js';
import { Table } from '../../core/output.js';
import {
  DEFAULT_POST_PAGE_SIZE,
  type DiscussionForum,
  type DiscussionPost,
  type DiscussionTopic,
  FORUM_COLUMNS,
  forumOf,
  listForums,
  listPosts,
  listTopics,
  MAX_POST_PAGE_SIZE,
  POST_COLUMNS,
  postOf,
  TOPIC_COLUMNS,
  topicOf,
} from '../../d2l/discussions.js';
import type { CliContext } from '../context.js';
import { emitList, listEnvelope, withData } from '../data.js';
import { parsePositiveInt, typed } from '../options.js';
import { parseOrgUnit } from './courses.js';

export function parseForumId(value: string): number {
  if (!/^\d+$/.test(value) || Number(value) <= 0) {
    throw new InvalidArgumentError('expected a positive integer forum id.');
  }
  return Number(value);
}

export function parseTopicId(value: string): number {
  if (!/^\d+$/.test(value) || Number(value) <= 0) {
    throw new InvalidArgumentError('expected a positive integer topic id.');
  }
  return Number(value);
}

export function parsePageSize(value: string): number {
  if (!/^\d+$/.test(value.trim()) || Number(value) <= 0 || Number(value) > MAX_POST_PAGE_SIZE) {
    throw new InvalidArgumentError(`expected an integer between 1 and ${MAX_POST_PAGE_SIZE}.`);
  }
  return Number(value);
}

function forumTable(rows: readonly DiscussionForum[]): string {
  const table = new Table(['ID', 'NAME', 'START', 'END', 'LOCKED', 'HIDDEN']);
  for (const f of rows) {
    table.row([
      f.id,
      f.name,
      f.startDate ?? '',
      f.endDate ?? '',
      f.isLocked ? 'yes' : 'no',
      f.isHidden ? 'yes' : 'no',
    ]);
  }
  return table.render();
}

function topicTable(rows: readonly DiscussionTopic[]): string {
  const table = new Table(['ID', 'FORUM', 'NAME', 'DUE', 'SCORE', 'SCORING', 'LOCKED']);
  for (const t of rows) {
    table.row([
      t.id,
      t.forumId ?? '',
      t.name,
      t.dueDate ?? '',
      t.scoreOutOf ?? '',
      t.scoringType ?? '',
      t.isLocked ? 'yes' : 'no',
    ]);
  }
  return table.render();
}

function postTable(rows: readonly DiscussionPost[]): string {
  const table = new Table(['ID', 'THREAD', 'PARENT', 'DATE', 'AUTHOR', 'SUBJECT']);
  for (const p of rows) {
    table.row([p.id, p.threadId ?? '', p.parentId ?? '', p.date ?? '', p.author ?? '', p.subject]);
  }
  return table.render();
}

interface Decoded<T> {
  items: T[];
  seen: number;
  skipped: number;
}

/** Decodes an array of raw objects, counting what was seen and skipped for the warnings below. */
function decodeArray<T>(raw: readonly unknown[], decode: (item: unknown) => T | null): Decoded<T> {
  const items: T[] = [];
  let skipped = 0;
  for (const item of raw) {
    const decoded = decode(item);
    if (decoded === null) skipped += 1;
    else items.push(decoded);
  }
  return { items, seen: raw.length, skipped };
}

function reportSkips(
  ctx: CliContext,
  what: string,
  result: Decoded<unknown>,
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

function isFatal(err: unknown): boolean {
  return (
    err instanceof AuthRequiredError || err instanceof CancelledError || !(err instanceof BsError)
  );
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
  const cmd = program.command('discussions').description('Discussion forums, topics and posts');

  cmd
    .command('forums')
    .description('The discussion forums of a course')
    .argument('<ou>', 'org unit id', parseOrgUnit)
    .addOption(limitOption('forums'))
    .option('--raw', 'emit the Forum objects as D2L sent them')
    .action(async (ou: number, opts: { limit?: number; raw?: boolean }) => {
      const startedAt = Date.now();
      const { raw, baseUrl } = await withData(ctx, async (http, cfg) => ({
        raw: (await listForums(http, cfg, ou)).slice(0, opts.limit),
        baseUrl: cfg.baseUrl,
      }));
      if (opts.raw) {
        emitList(ctx, listEnvelope(raw, startedAt), { raw: true });
        return;
      }
      const result = decodeArray(raw, (item) => forumOf(item, ou, baseUrl));
      reportSkips(ctx, 'forum', result, `bs discussions forums ${ou} --raw`);
      emitList(ctx, listEnvelope(result.items, startedAt), {
        tsv: { columns: FORUM_COLUMNS },
        human: () => forumTable(result.items),
      });
    });

  cmd
    .command('topics')
    .description(
      'The topics of one forum, or of every forum in the course when the forum is omitted (dueDate, scoreOutOf)',
    )
    .argument('<ou>', 'org unit id', parseOrgUnit)
    .argument('[forumId]', 'forum id (default: every forum, fetched concurrently)', parseForumId)
    .addOption(limitOption('topics'))
    .option('--raw', 'emit the Topic objects as D2L sent them')
    .action(
      async (ou: number, forumId: number | undefined, opts: { limit?: number; raw?: boolean }) => {
        const startedAt = Date.now();
        const { raw, baseUrl } = await withData(ctx, async (http, cfg) => {
          if (forumId !== undefined) {
            try {
              const items = await listTopics(http, cfg, ou, forumId);
              return { raw: items.map((item) => ({ forumId, item })), baseUrl: cfg.baseUrl };
            } catch (err) {
              if (err instanceof NotFoundError) {
                throw new NotFoundError(err.message, {
                  hint: `No forum ${forumId} visible in org unit ${ou}? Run: bs discussions forums ${ou}`,
                });
              }
              throw err;
            }
          }
          const forums = decodeArray(await listForums(http, cfg, ou), (f) =>
            forumOf(f, ou, cfg.baseUrl),
          );
          reportSkips(ctx, 'forum', forums, `bs discussions forums ${ou} --raw`);
          const ids = forums.items.map((f) => f.id);
          const results = await boundedPool(ids, cfg.concurrency, (f) =>
            listTopics(http, cfg, ou, f),
          );
          const failures: { forumId: number; error: BsError }[] = [];
          const raw: { forumId: number; item: unknown }[] = [];
          results.forEach((r, i) => {
            const id = ids[i] as number;
            if (r.ok) {
              for (const item of r.value) raw.push({ forumId: id, item });
            } else {
              if (isFatal(r.error)) throw r.error;
              failures.push({ forumId: id, error: r.error as BsError });
            }
          });
          if (ids.length > 0 && failures.length === ids.length)
            throw (failures[0] as { error: BsError }).error;
          for (const f of failures)
            ctx.warn(`forum ${f.forumId}: ${f.error.message}; its topics omitted`);
          return { raw, baseUrl: cfg.baseUrl };
        });

        const limited = raw.slice(0, opts.limit);
        if (opts.raw) {
          emitList(
            ctx,
            listEnvelope(
              limited.map((r) => r.item),
              startedAt,
            ),
            { raw: true },
          );
          return;
        }
        const result = decodeArray(limited, (r) => {
          const { forumId: f, item } = r as { forumId: number; item: unknown };
          return topicOf(item, ou, baseUrl, f);
        });
        reportSkips(
          ctx,
          'topic',
          result,
          `bs discussions topics ${ou}${forumId === undefined ? '' : ` ${forumId}`} --raw`,
        );
        emitList(ctx, listEnvelope(result.items, startedAt), {
          tsv: { columns: TOPIC_COLUMNS },
          human: () => topicTable(result.items),
        });
      },
    );

  cmd
    .command('posts')
    .description(
      'The posts of one topic, newest first (pageSize/pageNumber paging; stops on a short page)',
    )
    .argument('<ou>', 'org unit id', parseOrgUnit)
    .argument('<forumId>', 'forum id', parseForumId)
    .argument('<topicId>', 'topic id', parseTopicId)
    .option('--threads-only', 'top-level posts only (threadsOnly=true)')
    .addOption(limitOption('posts'))
    .addOption(
      typed(
        new Option(
          '--page-size <n>',
          `posts per request, 1..${MAX_POST_PAGE_SIZE} (default ${DEFAULT_POST_PAGE_SIZE})`,
        ).argParser(parsePageSize),
        'number',
      ),
    )
    .option('--raw', 'emit the Post objects as D2L sent them')
    .action(
      async (
        ou: number,
        forumId: number,
        topicId: number,
        opts: { threadsOnly?: boolean; limit?: number; pageSize?: number; raw?: boolean },
      ) => {
        const page = { warn: (m: string) => ctx.warn(m) };
        const startedAt = Date.now();
        const { raw, baseUrl } = await withData(ctx, async (http, cfg) => {
          try {
            const items = await collect(
              listPosts(
                http,
                cfg,
                ou,
                forumId,
                topicId,
                { pageSize: opts.pageSize, threadsOnly: opts.threadsOnly },
                page,
              ),
              opts.limit,
            );
            return { raw: items, baseUrl: cfg.baseUrl };
          } catch (err) {
            if (err instanceof NotFoundError) {
              throw new NotFoundError(err.message, {
                hint: `No topic ${topicId} in forum ${forumId} of org unit ${ou}? Run: bs discussions topics ${ou} ${forumId}`,
              });
            }
            throw err;
          }
        });
        if (opts.raw) {
          emitList(ctx, listEnvelope(raw, startedAt), { raw: true });
          return;
        }
        const result = decodeArray(raw, (item) => postOf(item, ou, baseUrl));
        reportSkips(ctx, 'post', result, `bs discussions posts ${ou} ${forumId} ${topicId} --raw`);
        emitList(ctx, listEnvelope(result.items, startedAt), {
          tsv: { columns: POST_COLUMNS },
          human: () => postTable(result.items),
        });
      },
    );
}
