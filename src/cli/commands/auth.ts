/**
 * `bs auth` (PRD 6.2): `status` (rung 0 only), `refresh` (the silent rung, then rung 0),
 * `login` (the ONLY command that climbs the full rung: it types a password and waits for a
 * human's number-match approval) and `logout` (the ONLY command that deletes credentials:
 * RepoBar anti-trapdoor) and `doctor` (a read-only diagnosis of the environment: never a window,
 * never a mint; the Chromium download only behind `--install-browser` and a `y`).
 */
import { existsSync, rmSync } from 'node:fs';
import { createInterface } from 'node:readline';
import type { Command } from 'commander';
import { resolveCredentials, writeCredentialsFile } from '../../auth/credentials.js';
import {
  CHROMIUM_INSTALL_SIZE,
  checkBrowser,
  DEFAULT_CHANNEL,
  type DoctorCheck,
  type DoctorReport,
  defaultDoctorDeps,
  installHint,
  loadPlaywright,
  reportOf,
  runDoctor,
} from '../../auth/doctor.js';
import { type ClimbResult, climb, HINT_LOGIN, profileExists } from '../../auth/ladder.js';
import { type FullFailure, fullRung } from '../../auth/rungs/full.js';
import { HINT_DOCTOR } from '../../auth/rungs/silent.js';
import { deleteSession, type Session, writeSession } from '../../auth/session.js';
import {
  AuthRequiredError,
  type BsError,
  CancelledError,
  ConfigError,
  RetryableError,
  UsageError,
} from '../../core/errors.js';
import { colorize } from '../../core/output.js';
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

const MARKS: Record<DoctorCheck['status'], [string, 'green' | 'yellow' | 'red']> = {
  ok: ['\u2713', 'green'],
  warn: ['!', 'yellow'],
  fail: ['\u2717', 'red'],
};

function doctorHuman(ctx: CliContext, report: DoctorReport): string {
  const width = Math.max(...report.checks.map((c) => c.name.length));
  const lines: string[] = [];
  for (const check of report.checks) {
    const [mark, color] = MARKS[check.status];
    lines.push(
      `${colorize(mark, color, ctx.globals.color)} ${check.name.padEnd(width)}  ${check.detail}`,
    );
    if (check.hint !== undefined) lines.push(`${' '.repeat(width + 4)}${check.hint}`);
  }
  const failed = report.checks.filter((c) => !c.ok).length;
  const warned = report.checks.filter((c) => c.status === 'warn').length;
  const summary =
    failed === 0
      ? `all checks passed${warned === 0 ? '' : ` (${warned} warning${warned === 1 ? '' : 's'})`}`
      : `${failed} check${failed === 1 ? '' : 's'} failed`;
  lines.push('', summary);
  return lines.join('\n');
}

function emitDoctor(ctx: CliContext, report: DoctorReport): void {
  emit(ctx, {
    value: report,
    tsv: {
      columns: ['name', 'status', 'ok', 'detail', 'hint'],
      rows: report.checks.map((c) => ({
        name: c.name,
        status: c.status,
        ok: c.ok,
        detail: c.detail,
        hint: c.hint ?? '',
      })),
    },
    human: () => doctorHuman(ctx, report),
    wrap: false,
  });
}

/** The error a failed report becomes: only an unreachable tenant retries (8); the rest is config (10). */
function doctorError(report: DoctorReport, tenantUnreachable: boolean): BsError {
  const failed = report.checks.filter((c) => !c.ok);
  const names = failed.map((c) => c.name).join(', ');
  const message = `${failed.length} check${failed.length === 1 ? '' : 's'} failed: ${names}`;
  const hint = failed.find((c) => c.hint !== undefined)?.hint;
  const options = hint === undefined ? {} : { hint };
  const onlyTenant = failed.every((c) => c.name === 'tenant');
  return tenantUnreachable && onlyTenant
    ? new RetryableError(message, options)
    : new ConfigError(message, options);
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

  auth
    .command('doctor')
    .description(
      "Diagnose the environment without logging in: Node >= 22.12, the state root and its modes, session.json (cached facts only, no mint), profile/, playwright-core, the browser executable for BS_BROWSER_CHANNEL, and the tenant's anonymous GET /d2l/api/versions/ against BS_LP_VERSION / BS_LE_VERSION. Never opens a window. Exit 0 when nothing failed (warnings allowed), 10 on a failed check, 8 when only the tenant was unreachable.",
    )
    .option(
      '--install-browser',
      `when Chromium is missing, download it (${CHROMIUM_INSTALL_SIZE}) into playwright's cache after a y/N prompt on stderr (non-interactive or --no-input: exit 2 with the command to run)`,
    )
    .action(async (opts: { installBrowser?: boolean }) => {
      const paths = ctx.paths();
      const config = ctx.config();
      const log = (line: string) => ctx.debug(line);
      const deps = { ...defaultDoctorDeps(), ...ctx.doctor };
      const run = await runDoctor({ paths, config, http: ctx.http(), env: ctx.env, log }, deps);
      let report = run.report;
      let usage: UsageError | null = null;
      const browser = report.checks.find((c) => c.name === 'browser');
      const channel = report.browserChannel;
      if (opts.installBrowser && browser !== undefined && !browser.ok) {
        const cliPath = deps.cliPath();
        if (channel !== DEFAULT_CHANNEL) {
          ctx.warn(
            `--install-browser downloads playwright's Chromium, but BS_BROWSER_CHANNEL is "${channel}": install that browser instead`,
          );
        } else if (cliPath === null) {
          ctx.warn(
            'playwright-core/cli.js could not be found, so the download cannot be started from here',
          );
        } else if (ctx.globals.noInput) {
          usage = new UsageError(
            `the Chromium download (${CHROMIUM_INSTALL_SIZE}) needs a confirmation and cannot prompt (non-interactive or --no-input)`,
            { hint: installHint(cliPath) },
          );
        } else if (
          await confirm(
            ctx,
            `Download Chromium (${CHROMIUM_INSTALL_SIZE}) into playwright's cache? [y/N] `,
          )
        ) {
          ctx.log(`running: node ${cliPath} install chromium`);
          let code: number;
          try {
            code = await deps.install({
              cliPath,
              browser: 'chromium',
              env: ctx.env,
              stderr: ctx.stderr,
            });
          } catch (err) {
            code = 1;
            ctx.warn(`the installer could not be started: ${describe(err)}`);
          }
          if (code !== 0) ctx.warn(`the installer exited with code ${code}`);
          // Re-check with a fresh import: playwright caches nothing about the executable, but the
          // load may have been what failed before.
          const load = await loadPlaywright(deps);
          const again = checkBrowser({ config, env: ctx.env, load, deps });
          report = reportOf(
            { paths, config },
            report.checks.map((c) => (c.name === 'browser' ? again : c)),
          );
        } else {
          ctx.warn('install declined; the browser check stays failed');
        }
      }
      emitDoctor(ctx, report);
      if (usage !== null) throw usage;
      if (!report.ok) throw doctorError(report, run.tenantUnreachable);
    });
}
