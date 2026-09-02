import type { Command } from 'commander';
import { buildString } from '../../buildinfo.js';
import { UsageError } from '../../core/errors.js';
import { writeJson } from '../../core/output.js';
import { buildSchema } from '../../schema/schema.js';
import type { CliContext } from '../context.js';

export function register(program: Command, ctx: CliContext): void {
  program
    .command('schema')
    .description('Print the machine-readable command contract (always JSON)')
    .argument('[cmd...]', 'command path to narrow to, e.g. "courses list"')
    .option('--include-hidden', 'include hidden commands and flags')
    .action((cmdPath: string[], opts: { includeHidden?: boolean }) => {
      if (ctx.globals.plain) {
        throw new UsageError('schema output is JSON only; --plain is not supported', {
          hint: 'Run: bs schema --json',
        });
      }
      const doc = buildSchema(program, {
        path: cmdPath,
        includeHidden: Boolean(opts.includeHidden),
        build: buildString(),
        safety: {
          readonly: ctx.globals.readonly,
          no_input: ctx.globals.noInput,
          wrap_untrusted: ctx.globals.wrapUntrusted,
        },
      });
      // Trusted local metadata: --select, --results-only and --wrap-untrusted are ignored.
      writeJson(ctx.stdout, doc);
    });
}
