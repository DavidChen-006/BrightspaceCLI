/**
 * `bs grades list|final` (PRD 6.2, 6.3). Both go through `withData` (ladder, one re-mint) and
 * the `src/d2l/grades.ts` routes.
 *
 * `list` fetches `grades/` and `grades/values/myGradeValues/` concurrently and joins them on
 * the grade object id: a 404 on the values means "no grades yet" (every `myValue` null); the
 * objects route failing while values answer costs only the object fields (warning); both
 * failing reports the objects' error (403 → exit 6, 404 → exit 5).
 *
 * `final` emits the released final grade, or the `released: false` shape with exit 0 on 404
 * (exit 3 under --fail-empty).
 */
import type { Command } from 'commander';
import {
  AuthRequiredError,
  BsError,
  CancelledError,
  EmptyResultsError,
} from '../../core/errors.js';
import { type Column, type Row, Table } from '../../core/output.js';
import {
  type FinalGrade,
  finalGradeOf,
  type Grade,
  getMyFinalGrade,
  joinGrades,
  listGradeObjects,
  listMyGradeValues,
} from '../../d2l/grades.js';
import { type CliContext, emit } from '../context.js';
import { emitList, emitRaw, listEnvelope, withData } from '../data.js';
import { parseOrgUnit } from './courses.js';

/** `--plain` flattens `associatedTool` and `myValue` into one row per grade item. */
export const GRADE_COLUMNS: readonly (
  | keyof Grade
  | keyof NonNullable<Grade['myValue']>
  | 'toolId'
  | 'toolItemId'
)[] = [
  'id',
  'name',
  'shortName',
  'type',
  'maxPoints',
  'weight',
  'isBonus',
  'toolId',
  'toolItemId',
  'displayed',
  'numerator',
  'denominator',
  'weightedNumerator',
  'weightedDenominator',
  'lastModified',
  'released',
  'releasedDate',
  'comments',
  'url',
];

export const FINAL_COLUMNS: readonly (keyof FinalGrade)[] = [
  'courseId',
  'released',
  'id',
  'name',
  'type',
  'displayed',
  'numerator',
  'denominator',
  'weightedNumerator',
  'weightedDenominator',
  'lastModified',
  'releasedDate',
  'comments',
  'url',
];

function gradeRow(g: Grade): Row {
  const v = g.myValue;
  return {
    id: g.id,
    name: g.name,
    shortName: g.shortName,
    type: g.type,
    maxPoints: g.maxPoints,
    weight: g.weight,
    isBonus: g.isBonus,
    toolId: g.associatedTool?.toolId ?? null,
    toolItemId: g.associatedTool?.toolItemId ?? null,
    displayed: v?.displayed ?? null,
    numerator: v?.numerator ?? null,
    denominator: v?.denominator ?? null,
    weightedNumerator: v?.weightedNumerator ?? null,
    weightedDenominator: v?.weightedDenominator ?? null,
    lastModified: v?.lastModified ?? null,
    released: v === null ? null : v.released,
    releasedDate: v?.releasedDate ?? null,
    comments: v?.comments ?? null,
    url: g.url,
  };
}

function points(numerator: number | null, denominator: number | null): string {
  if (numerator === null && denominator === null) return '';
  return `${numerator ?? '-'}/${denominator ?? '-'}`;
}

function gradeTable(rows: readonly Grade[]): string {
  const table = new Table(['ID', 'NAME', 'TYPE', 'GRADE', 'POINTS', 'WEIGHT', 'RELEASED']);
  for (const g of rows) {
    const v = g.myValue;
    table.row([
      g.id,
      g.name,
      g.type ?? '',
      v?.displayed ?? '',
      v ? points(v.numerator, v.denominator) : g.maxPoints === null ? '' : `-/${g.maxPoints}`,
      g.weight ?? '',
      v === null ? '' : v.released ? 'yes' : 'no',
    ]);
  }
  return table.render();
}

function finalText(f: FinalGrade): string {
  if (!f.released) return `No final grade released for course ${f.courseId}.\nurl: ${f.url}\n`;
  const lines = [
    `${f.name ?? 'Final grade'}${f.type ? ` (${f.type})` : ''}: ${f.displayed ?? '-'}`,
    `points: ${points(f.numerator, f.denominator) || '-'}  weighted: ${points(f.weightedNumerator, f.weightedDenominator) || '-'}`,
    `released: ${f.releasedDate ?? 'yes'}  modified: ${f.lastModified ?? '-'}`,
    `url: ${f.url}`,
  ];
  if (f.comments) lines.push('', f.comments);
  return `${lines.join('\n')}\n`;
}

function isFatal(err: unknown): boolean {
  return (
    err instanceof AuthRequiredError || err instanceof CancelledError || !(err instanceof BsError)
  );
}

export function register(program: Command, ctx: CliContext): void {
  const cmd = program
    .command('grades')
    .description('Gradebook: grade items with your values, and the final grade');

  cmd
    .command('list')
    .description(
      'Grade items joined with your values. A 404 on the values means no grades yet (myValue null), not an error.',
    )
    .argument('<ou>', 'org unit id', parseOrgUnit)
    .option('--raw', 'emit both payloads as D2L sent them: {objects, values}')
    .action(async (ou: number, opts: { raw?: boolean }) => {
      const startedAt = Date.now();
      const { objects, values, baseUrl } = await withData(ctx, async (http, cfg) => {
        const [o, v] = await Promise.allSettled([
          listGradeObjects(http, cfg, ou),
          listMyGradeValues(http, cfg, ou),
        ]);
        for (const r of [o, v]) if (r.status === 'rejected' && isFatal(r.reason)) throw r.reason;
        if (v.status === 'rejected') throw o.status === 'rejected' ? o.reason : v.reason;
        if (o.status === 'rejected') {
          if (v.value.length === 0) throw o.reason;
          const reason = o.reason as BsError;
          ctx.warn(`${reason.message}; maxPoints, weight, isBonus and associatedTool omitted`);
          return { objects: null, values: v.value, baseUrl: cfg.baseUrl };
        }
        return { objects: o.value, values: v.value, baseUrl: cfg.baseUrl };
      });

      if (opts.raw) {
        emitRaw(ctx, { objects: objects ?? [], values });
        if (ctx.globals.failEmpty && (objects?.length ?? 0) === 0 && values.length === 0) {
          throw new EmptyResultsError();
        }
        return;
      }

      let skipped = 0;
      const seen = (objects?.length ?? 0) + values.length;
      const items = joinGrades(objects, values, baseUrl, ou, () => {
        skipped += 1;
      });
      if (skipped > 0 && items.length === 0) {
        throw new BsError('error', `none of ${seen} grade records was decodable`, {
          hint: 'Run: bs grades list <ou> --raw  to inspect the payload, or bs auth doctor',
        });
      }
      if (skipped > 0) ctx.warn(`skipped ${skipped} undecodable grade record(s) of ${seen}`);
      emitList(ctx, listEnvelope(items, startedAt), {
        tsv: { columns: GRADE_COLUMNS as readonly (string | Column)[], rows: items.map(gradeRow) },
        human: () => gradeTable(items),
      });
    });

  cmd
    .command('final')
    .description(
      'Your final calculated or adjusted grade. Nothing released yet: released false, exit 0 (exit 3 with --fail-empty).',
    )
    .argument('<ou>', 'org unit id', parseOrgUnit)
    .option('--raw', 'emit the GradeValue as D2L sent it (null when none is released)')
    .action(async (ou: number, opts: { raw?: boolean }) => {
      const { raw, baseUrl } = await withData(ctx, async (http, cfg) => ({
        raw: await getMyFinalGrade(http, cfg, ou),
        baseUrl: cfg.baseUrl,
      }));
      const final = finalGradeOf(raw, baseUrl, ou);
      if (opts.raw) {
        emitRaw(ctx, raw);
      } else {
        emit(ctx, {
          value: final,
          tsv: { columns: FINAL_COLUMNS, rows: [{ ...final }] },
          human: () => finalText(final),
        });
      }
      if (ctx.globals.failEmpty && !final.released) throw new EmptyResultsError('no final grade');
    });
}
