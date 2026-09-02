import type { Command } from 'commander';
import { getBuildInfo } from '../../buildinfo.js';
import { type CliContext, emit } from '../context.js';

export function register(program: Command, ctx: CliContext): void {
  program
    .command('version')
    .description('Print version, commit and build date')
    .action(() => {
      const info = getBuildInfo();
      emit(ctx, {
        value: info,
        tsv: { columns: ['version', 'commit', 'date'], rows: [{ ...info }] },
        human: `bs ${info.version} (${info.commit} ${info.date})`,
        wrap: false,
      });
    });
}
