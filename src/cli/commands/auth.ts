/**
 * `bs auth` (PRD 6.2): `status` (rung 0 only), `refresh` (the silent rung, then rung 0),
 * `login` (the ONLY command that climbs the full rung: it types a password and waits for a
 * human's number-match approval) and `logout` (the ONLY command that deletes credentials:
 * RepoBar anti-trapdoor). `doctor` arrives with bs-6cu.
 */
import { existsSync, rmSync } from 'node:fs';
import { createInterface } from 'node:readline';
import type { Command } from 'commander';
import { resolveCredentials, writeCredentialsFile } from '../../auth/credentials.js';
import { type ClimbResult, climb, HINT_LOGIN, profileExists } from '../../auth/ladder.js';
import { type FullFailure, fullRung } from '../../auth/rungs/full.js';
import { HINT_DOCTOR } from '../../auth/rungs/silent.js';
import { deleteSession, type Session, writeSession } from '../../auth/session.js';
import {
  AuthRequiredError,
  CancelledError,
  ConfigError,
  RetryableError,
  UsageError,
} from '../../core/errors.js';
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

export interface LogoutResult {
  /** Files that existed and were deleted, in the order they were tried. */
  removed: string[];
  profilePurged: boolean;
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
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

function statusOf(ctx: CliContext, result: ClimbResult): AuthStatus {
  const paths = ctx.paths();
  const session = result.session;
  return {
    state: result.state,
    baseUrl: session?.baseUrl ?? ctx.config().baseUrl,
    capturedAt: session?.capturedAt ?? null,
    jwtExpiresAt: session?.jwtExpiresAt ?? null,
    profileExists: profileExists(paths),
    sessionFile: paths.sessionFile,
    root: paths.root,
  };
}

/** The `auth status` shape, shared with `auth refresh`. Secret-free by construction. */
function emitStatus(ctx: CliContext, value: AuthStatus): void {
  emit(ctx, {
    value,
    tsv: {
      columns: ['key', 'value'],
      rows: Object.entries(value).map(([key, v]) => ({ key, value: v })),
    },
    human: humanLine(value),
    wrap: false,
  });
}

/** The next step after a failed full login, by what the rung saw. Never a secret. */
function loginHint(failure: FullFailure | null): string {
  switch (failure?.kind) {
    case 'bad-password':
      return 'Microsoft rejected the password: fix BS_EMAIL/BS_PASSWORD, credentials.json, or what you typed at the prompt, then re-run: bs auth login  (--save-credentials is not the fix for a wrong password)';
    case 'unknown-account':
      return 'Microsoft does not know that email: check --email / BS_EMAIL / credentials.json, then re-run: bs auth login';
    case 'mfa-timeout':
      return 'Approve the number-match prompt in Authenticator on your phone within 5 minutes, then re-run: bs auth login';
    case 'mfa-denied':
      return 'The number-match request was denied or expired on your phone: re-run: bs auth login  and approve the prompt';
    case 'browser':
      return HINT_DOCTOR;
    case 'no-field':
      return 'The Microsoft sign-in page did not show the expected field: re-run: bs auth login --headed  to watch it, or run: bs auth doctor';
    default:
      return 'Re-run: bs auth login --headed  to watch the sign-in, or run: bs auth doctor';
  }
}

/** Asks on stderr and reads one line from the invocation's stdin; only `y`/`yes` is a yes. */
async function confirm(ctx: CliContext, question: string): Promise<boolean> {
  ctx.stderr.write(question);
  const rl = createInterface({ input: ctx.stdin, terminal: false });
  try {
    for await (const line of rl) return /^y(es)?$/i.test(line.trim());
    return false;
  } finally {
    rl.close();
  }
}

export function register(program: Command, ctx: CliContext): void {
  const auth = program.command('auth').description('Session state and login');

  auth
    .command('status')
    .description(
      'Report the session state (exit 0 fresh, 4 otherwise). Never opens a browser; mints once through rung 0 only when a session exists and its cached JWT is stale.',
    )
    .action(async () => {
      // Rung 0 only: no browser rungs, so a stale JWT costs at most one mint to report the truth.
      const result = await climb({
        paths: ctx.paths(),
        config: ctx.config(),
        http: ctx.http(),
        rungs: [],
        allowFull: false,
        log: (line) => ctx.debug(line),
      });
      emitStatus(ctx, statusOf(ctx, result));
      if (result.state !== 'fresh') {
        throw new AuthRequiredError(result.reason, { hint: result.hint });
      }
    });

  auth
    .command('refresh')
    .description(
      'Re-run the silent SSO rung (headless; never a window, never a prompt), save the harvested session and mint a JWT through rung 0. Prints the auth status shape; exit 0 fresh, 4 otherwise.',
    )
    .action(async () => {
      const paths = ctx.paths();
      const config = ctx.config();
      const log = (line: string) => ctx.debug(line);
      // The silent rung only, driven directly so it always runs: an Entra sign-in that is never
      // exercised can expire while everything looks green (Brightspace-Bar Extra 6, quirk 10).
      const silent = ctx.rungs.filter((rung) => rung.kind === 'silent');
      if (silent.length === 0) log('auth refresh: no silent rung is registered');
      let restored: Session | null = null;
      for (const rung of silent) {
        try {
          restored = await rung.attempt({ paths, config, log, warn: (line) => ctx.warn(line) });
        } catch (err) {
          if (err instanceof CancelledError) throw err;
          log(`auth refresh: the silent rung threw: ${describe(err)}`);
        }
        if (restored !== null) break;
      }
      if (restored !== null) {
        try {
          writeSession(paths, restored);
        } catch (err) {
          throw new ConfigError(`could not write ${paths.sessionFile}: ${describe(err)}`, {
            hint: 'Check the state directory (--root / BS_ROOT) is writable.',
          });
        }
        log('auth refresh: session.json written');
      }
      const result = await climb({
        paths,
        config,
        http: ctx.http(),
        rungs: [],
        allowFull: false,
        forceMint: restored !== null,
        log,
      });
      emitStatus(ctx, statusOf(ctx, result));
      if (result.state !== 'fresh') {
        if (result.retryable) throw new RetryableError(result.reason, { hint: result.hint });
        throw new AuthRequiredError(result.reason, { hint: HINT_LOGIN });
      }
      if (restored === null) {
        ctx.warn('the silent rung could not restore the session; the saved one is still fresh');
      }
    });

  auth
    .command('login')
    .description(
      'Sign in through the browser: the silent SSO path first, then the Microsoft credential login with the Authenticator number-match relayed to stderr ("Type NN into Authenticator on your phone") and cache/mfa.json. Credentials: BS_EMAIL+BS_PASSWORD, else --email with --password-stdin, else credentials.json, else a terminal prompt; none and no terminal (or --no-input) is exit 4 at once. The only command that runs the full login. Prints the auth status shape; exit 0 fresh, 4 otherwise.',
    )
    .option('--headed', 'open a visible browser window instead of running headless')
    .option('--email <email>', 'the Microsoft sign-in email (pair with --password-stdin)')
    .option(
      '--password-stdin',
      'read the password from stdin (the whole input; one trailing newline trimmed)',
    )
    .option(
      '--save-credentials',
      'after a successful login, save {email, password} to credentials.json (mode 0600) in the root',
    )
    .action(
      async (opts: {
        headed?: boolean;
        email?: string;
        passwordStdin?: boolean;
        saveCredentials?: boolean;
      }) => {
        const paths = ctx.paths();
        const log = (line: string) => ctx.debug(line);
        // Credentials first, so a non-interactive run with nothing to type fails before a
        // browser is launched and a human is never prompted mid-flow.
        const credentials = await resolveCredentials({
          env: ctx.env,
          paths,
          email: opts.email,
          passwordStdin: opts.passwordStdin,
          stdin: ctx.stdin,
          stderr: ctx.stderr,
          canPrompt: !ctx.globals.noInput,
          warn: (line) => ctx.warn(line),
        });
        log(`auth login: credentials from ${credentials.source}`);
        // Built here and only here: `ctx.rungs` (the silent rung) stays out, because the full
        // rung already runs the silent path first and nothing may run it twice.
        const rung = (ctx.fullRung ?? fullRung)({
          credentials: { email: credentials.email, password: credentials.password },
          headed: Boolean(opts.headed),
          announce: (line) => ctx.log(line),
        });
        const result = await climb({
          paths,
          config: ctx.config(),
          http: ctx.http(),
          rungs: [rung],
          allowFull: true,
          log,
          warn: (line) => ctx.warn(line),
        });
        emitStatus(ctx, statusOf(ctx, result));
        if (result.state !== 'fresh') {
          if (result.retryable) throw new RetryableError(result.reason, { hint: result.hint });
          const failure = rung.failure;
          throw new AuthRequiredError(failure?.reason ?? result.reason, {
            hint: loginHint(failure),
          });
        }
        if (opts.saveCredentials) {
          try {
            writeCredentialsFile(paths, credentials);
          } catch (err) {
            throw new ConfigError(`could not write ${paths.credentialsFile}: ${describe(err)}`, {
              hint: 'Check the state directory (--root / BS_ROOT) is writable.',
            });
          }
          ctx.log(`saved credentials to ${paths.credentialsFile} (mode 0600)`);
        }
      },
    );

  auth
    .command('logout')
    .description(
      'Delete the saved session (session.json and cache/); with --purge-profile also the browser profile. Asks on a TTY unless --force; non-interactive without --force is exit 2. The only command that deletes credentials.',
    )
    .option(
      '--purge-profile',
      'also remove profile/ (the ~90-day Microsoft sign-in; the next login needs MFA again)',
    )
    .option('--force', 'skip the confirmation prompt')
    .action(async (opts: { purgeProfile?: boolean; force?: boolean }) => {
      const paths = ctx.paths();
      const purge = Boolean(opts.purgeProfile);
      if (!opts.force) {
        if (ctx.globals.noInput) {
          throw new UsageError(
            'logout needs a confirmation and cannot prompt (non-interactive or --no-input)',
            {
              hint: 'Re-run with --force',
            },
          );
        }
        const what = purge
          ? 'session.json, cache/ and profile/ (the next login will need MFA again)'
          : 'session.json and cache/';
        if (!(await confirm(ctx, `Delete ${what} under ${paths.root}? [y/N] `))) {
          throw new CancelledError('logout cancelled; nothing was deleted', { silent: false });
        }
      }
      const removed: string[] = [];
      for (const file of [paths.sessionFile, paths.statusFile, paths.mfaFile]) {
        if (!existsSync(file)) continue;
        if (file === paths.sessionFile) deleteSession(paths);
        else rmSync(file, { force: true });
        removed.push(file);
      }
      let profilePurged = false;
      if (purge && existsSync(paths.profileDir)) {
        rmSync(paths.profileDir, { recursive: true, force: true });
        profilePurged = true;
      }
      const value: LogoutResult = { removed, profilePurged };
      const rows = [
        ...removed.map((path) => ({ kind: 'file', path })),
        ...(profilePurged ? [{ kind: 'profile', path: paths.profileDir }] : []),
      ];
      emit(ctx, {
        value,
        tsv: { columns: ['kind', 'path'], rows },
        human:
          rows.length === 0
            ? 'nothing to remove'
            : rows.map((r) => `removed ${r.kind} ${r.path}`).join('\n'),
        wrap: false,
      });
    });
}
