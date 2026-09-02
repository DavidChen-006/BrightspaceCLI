/**
 * `bs courses list|get` (PRD 6.2, 6.3). Both go through `withData` (ladder, one re-mint) and
 * the `src/d2l/courses.ts` routes; the shapes are the PRD Course / CourseDetail.
 */
import { type Command, InvalidArgumentError, Option } from 'commander';
import { AuthRequiredError, BsError, CancelledError, NotFoundError } from '../../core/errors.js';
import { collect } from '../../core/http/index.js';
import { Table } from '../../core/output.js';
import {
  COURSE_COLUMNS,
  type Course,
  type CourseDetail,
  type CourseOffering,
  courseDetailOf,
  courses,
  ENROLLMENT_SORTS,
  type EnrollmentSort,
  getCourse,
  getEnrollment,
  listEnrollments,
  type MyOrgUnitInfo,
} from '../../d2l/courses.js';
import { type CliContext, emit } from '../context.js';
import { emitList, emitRaw, listEnvelope, withData } from '../data.js';
import { parsePositiveInt, typed } from '../options.js';

interface ListOptions {
  all?: boolean;
  inactive?: boolean;
  ended?: boolean;
  sort?: EnrollmentSort;
  limit?: number;
  raw?: boolean;
}

export function parseOrgUnit(value: string): number {
  if (!/^\d+$/.test(value) || Number(value) <= 0) {
    throw new InvalidArgumentError('expected a positive integer org unit id.');
  }
  return Number(value);
}

function courseTable(rows: readonly Course[]): string {
  const table = new Table(['ID', 'NAME', 'CODE', 'ROLE', 'START', 'END', 'ACCESS']);
  for (const c of rows) {
    table.row([
      c.id,
      c.name,
      c.code ?? '',
      c.role ?? '',
      c.startDate ?? '',
      c.endDate ?? '',
      c.canAccess ? 'yes' : 'no',
    ]);
  }
  return table.render();
}

function detailText(d: CourseDetail): string {
  const lines = [
    `${d.name}  (${d.code ?? 'no code'})  id ${d.id}`,
    `role: ${d.role ?? '-'}  active: ${d.isActive ? 'yes' : 'no'}  access: ${d.canAccess ? 'yes' : 'no'}`,
    `dates: ${d.startDate ?? '-'} → ${d.endDate ?? '-'}`,
    `semester: ${d.semester?.name ?? '-'}  department: ${d.department?.name ?? '-'}`,
    `url: ${d.url}`,
  ];
  if (d.description) lines.push('', d.description);
  return `${lines.join('\n')}\n`;
}

export function register(program: Command, ctx: CliContext): void {
  const cmd = program.command('courses').description('Enrolled courses');

  cmd
    .command('list')
    .description(
      'List enrollments. Default: course offerings only, active, not yet ended. Follows bookmark paging.',
    )
    .option('--all', 'every org unit type, not only course offerings (BS_COURSE_TYPE_ID)')
    .option('--inactive', 'include inactive enrollments')
    .option('--ended', 'include courses whose end date has passed')
    .addOption(
      typed(
        new Option('--sort <key>', 'server-side order').choices([...ENROLLMENT_SORTS]),
        'string',
      ),
    )
    .addOption(
      typed(
        new Option('--limit <n>', 'stop after n courses (no further pages fetched)').argParser(
          parsePositiveInt,
        ),
        'number',
      ),
    )
    .option('--raw', 'emit the MyOrgUnitInfo items as D2L sent them')
    .action(async (opts: ListOptions) => {
      const query = { all: opts.all, inactive: opts.inactive, ended: opts.ended, sort: opts.sort };
      const page = { warn: (m: string) => ctx.warn(m) };
      const startedAt = Date.now();

      if (opts.raw) {
        const items = await withData(ctx, (http, cfg) =>
          collect(listEnrollments(http, cfg, query, page), opts.limit),
        );
        emitList(ctx, listEnvelope(items, startedAt), { raw: true });
        return;
      }

      let skipped = 0;
      let seen = 0;
      const items = await withData(ctx, (http, cfg) => {
        skipped = 0;
        seen = 0;
        const raw = listEnrollments(http, cfg, query, page);
        const counted = (async function* count(): AsyncGenerator<MyOrgUnitInfo> {
          for await (const item of raw) {
            seen += 1;
            yield item;
          }
        })();
        return collect(
          courses(counted, cfg.baseUrl, () => {
            skipped += 1;
          }),
          opts.limit,
        );
      });
      if (skipped > 0 && items.length === 0) {
        throw new BsError('error', `none of ${seen} enrollments was decodable`, {
          hint: 'Run: bs courses list --raw  to inspect the payload, or bs auth doctor',
        });
      }
      if (skipped > 0) ctx.warn(`skipped ${skipped} undecodable enrollment(s) of ${seen}`);
      emitList(ctx, listEnvelope(items, startedAt), {
        tsv: { columns: COURSE_COLUMNS },
        human: () => courseTable(items),
      });
    });

  cmd
    .command('get')
    .description(
      'One course: the enrollment (role, access window) merged with the offering (description, semester, department)',
    )
    .argument('<ou>', 'org unit id', parseOrgUnit)
    .option('--raw', 'emit both payloads as D2L sent them: {enrollment, offering}')
    .action(async (ou: number, opts: { raw?: boolean }) => {
      const { enrollment, offering, baseUrl } = await withData(ctx, async (http, cfg) => {
        let enrollment: MyOrgUnitInfo;
        try {
          enrollment = await getEnrollment(http, cfg, ou);
        } catch (err) {
          if (err instanceof NotFoundError) {
            throw new NotFoundError(err.message, {
              hint: `Not enrolled in org unit ${ou}? Run: bs courses list --inactive --ended  (add --all for non-course org units)`,
            });
          }
          throw err;
        }
        let offering: CourseOffering | null = null;
        try {
          offering = await getCourse(http, cfg, ou);
        } catch (err) {
          if (!(err instanceof BsError)) throw err;
          if (err instanceof AuthRequiredError || err instanceof CancelledError) throw err;
          ctx.warn(`${err.message}; description, path, semester and department omitted`);
        }
        return { enrollment, offering, baseUrl: cfg.baseUrl };
      });
      if (opts.raw) {
        emitRaw(ctx, { enrollment, offering });
        return;
      }
      const detail = courseDetailOf(enrollment, offering, baseUrl);
      if (detail === null) {
        throw new BsError('error', `GET myenrollments/${ou}: unexpected response shape`, {
          hint: 'Run: bs courses get <ou> --raw  to inspect the payload, or bs auth doctor',
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
}
