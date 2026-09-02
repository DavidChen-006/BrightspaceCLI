import { readFileSync } from 'node:fs';
import { type Command, Option } from 'commander';
import { getBuildInfo } from '../../buildinfo.js';
import { BsError } from '../../core/errors.js';
import { buildSchema } from '../../schema/schema.js';
import { firstDifference, packagedSkillFile, renderSkill } from '../../skill/render.js';
import { type CliContext, emit } from '../context.js';
import { typed } from '../options.js';

const HINT = 'Run: npm run skill';

function readSkillFile(file: string): string | null {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

export function register(program: Command, ctx: CliContext): void {
  program
    .command('skill')
    .description(
      'Print the agent SKILL.md rendered from the live command schema. --check compares it with the committed skills/bs/SKILL.md and exits 1 when it is stale.',
    )
    .addOption(
      typed(
        new Option(
          '--check [file]',
          'compare the rendered skill with a file (default: skills/bs/SKILL.md) instead of printing it; exit 1 when it is stale',
        ),
        'string',
      ),
    )
    .action((opts: { check?: string | boolean }) => {
      // The skill text is local, trusted metadata: no state directory, no browser, no network.
      const { version } = getBuildInfo();
      const doc = buildSchema(program, {
        build: version,
        safety: { readonly: true, no_input: true, wrap_untrusted: false },
      });
      const markdown = renderSkill(doc, { version });

      if (opts.check !== undefined) {
        const file = typeof opts.check === 'string' ? opts.check : packagedSkillFile();
        const actual = readSkillFile(file);
        if (actual === null) {
          throw new BsError('error', `${file} is missing`, { hint: HINT });
        }
        const diff = firstDifference(markdown, actual);
        if (diff) {
          throw new BsError(
            'error',
            `${file} is out of date (generated ${diff.expectedLines} lines, file has ` +
              `${diff.actualLines}; first difference at line ${diff.line})\n` +
              `  generated: ${JSON.stringify(diff.expected ?? null)}\n` +
              `  file:      ${JSON.stringify(diff.actual ?? null)}`,
            { hint: HINT },
          );
        }
        ctx.log(`${file} is up to date`);
        return;
      }

      if (ctx.globals.outputMode === 'json') {
        emit(ctx, { value: { markdown }, wrap: false });
        return;
      }
      ctx.stdout.write(markdown.endsWith('\n') ? markdown : `${markdown}\n`);
    });
}
