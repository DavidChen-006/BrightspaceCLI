/**
 * `bs auth` (PRD 6.2). This ticket ships `status`; `login`, `refresh`, `logout` and `doctor`
 * come with the browser rungs (bs-30m, bs-68x).
 */
import type { Command } from 'commander';
import { climb, profileExists } from '../../auth/ladder.js';
import { AuthRequiredError } from '../../core/errors.js';
import { type CliContext, emit } from '../context.js';

export interface AuthStatus {
  state: 'fresh' | 'expired' | 'none';
  baseUrl: string;
  capturedAt: string | null;
  jwtExpiresAt: string | null;
  profileExists: boolean;
  sessionFile: string;
  root: string;
}

function humanLine(s: AuthStatus): string {
  return [
    s.state,
    s.baseUrl,
    `captured ${s.capturedAt ?? '-'}`,
    `jwt until ${s.jwtExpiresAt ?? '-'}`,
    `profile ${s.profileExists ? 'yes' : 'no'}`,
  ].join('  ');
}

export function register(program: Command, ctx: CliContext): void {
  const auth = program.command('auth').description('Session state and login');

  auth
    .command('status')
    .description(
      'Report the session state (exit 0 fresh, 4 otherwise). Never opens a browser; mints once through rung 0 only when a session exists and its cached JWT is stale.',
    )
    .action(async () => {
      const paths = ctx.paths();
      const config = ctx.config();
      // Rung 0 only: no browser rungs, so a stale JWT costs at most one mint to report the truth.
      const result = await climb({
        paths,
        config,
        http: ctx.http(),
        rungs: [],
        allowFull: false,
        log: (line) => ctx.debug(line),
      });
      const session = result.session;
      const value: AuthStatus = {
        state: result.state,
        baseUrl: session?.baseUrl ?? config.baseUrl,
        capturedAt: session?.capturedAt ?? null,
        jwtExpiresAt: session?.jwtExpiresAt ?? null,
        profileExists: profileExists(paths),
        sessionFile: paths.sessionFile,
        root: paths.root,
      };
      emit(ctx, {
        value,
        tsv: {
          columns: ['key', 'value'],
          rows: Object.entries(value).map(([key, v]) => ({ key, value: v })),
        },
        human: humanLine(value),
        wrap: false,
      });
      if (result.state !== 'fresh') {
        throw new AuthRequiredError(result.reason, { hint: result.hint });
      }
    });
}
