/**
 * `bs whoami` (PRD 6.2): `GET /d2l/api/lp/{lp}/users/whoami` → `{id, firstName, lastName,
 * uniqueName, pronouns}`; `--raw` for the WhoAmIUser payload as sent.
 */
import type { Command } from 'commander';
import { type User, userOf, whoami } from '../../d2l/users.js';
import { type CliContext, emit } from '../context.js';
import { emitRaw, withData } from '../data.js';

const COLUMNS: readonly (keyof User)[] = ['id', 'firstName', 'lastName', 'uniqueName', 'pronouns'];

function humanLine(u: User): string {
  const name = [u.firstName, u.lastName].filter((s) => s).join(' ') || '(no name)';
  const parts = [name, u.uniqueName ? `(${u.uniqueName})` : '', u.id === null ? '' : `id ${u.id}`];
  if (u.pronouns) parts.push(u.pronouns);
  return parts.filter((p) => p !== '').join('  ');
}

export function register(program: Command, ctx: CliContext): void {
  program
    .command('whoami')
    .description('Show the signed-in user (id, names, username, pronouns)')
    .option('--raw', 'emit the WhoAmIUser payload as D2L sent it')
    .action(async (opts: { raw?: boolean }) => {
      const raw = await withData(ctx, (http, cfg) => whoami(http, cfg));
      if (opts.raw) {
        emitRaw(ctx, raw);
        return;
      }
      const user = userOf(raw);
      emit(ctx, {
        value: user,
        tsv: { columns: COLUMNS, rows: [{ ...user }] },
        human: humanLine(user),
      });
    });
}
