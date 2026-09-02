/**
 * Commander root: global flags, env defaults, validation, exit-code mapping.
 *
 * `run(argv, io)` is the single entry point; it returns an exit code and never calls
 * process.exit, so tests drive the real argv path in-process with captured streams.
 */
import { Command } from 'commander';
import { getBuildInfo } from '../buildinfo.js';
import { EXIT_CODES, exitCodeFor, formatError, isSilent, UsageError } from '../core/errors.js';
import { type ColorMode, colorize, type OutputMode, resolveColor } from '../core/output.js';
import { commands } from './commands/index.js';
import { type CliContext, createContext, type GlobalOptions, type RunIO } from './context.js';
import { addGlobalOptions } from './options.js';

export type { CliContext, GlobalOptions, RunIO } from './context.js';

const FALSY_ENV = new Set(['', '0', 'false', 'no', 'off']);

/** BS_X=1/true/yes/on enable a boolean; 0/false/no/off/empty leave it alone. */
export function envIsTruthy(value: string | undefined): boolean {
  return value !== undefined && !FALSY_ENV.has(value.trim().toLowerCase());
}

/**
 * Commander reads option env vars straight from process.env with presence-only semantics.
 * This subclass reads them from the injected environment instead (hermetic tests) and
 * treats BS_X=0/false as unset. Pinned to commander 15.0.0; `_parseOptionsEnv` is private.
 */
class BsCommand extends Command {
  envSource: NodeJS.ProcessEnv = process.env;

  override createCommand(name?: string): Command {
    const cmd = new BsCommand(name);
    cmd.envSource = this.envSource;
    return cmd;
  }

  /** Command is an EventEmitter at runtime; the typings omit `emit`. */
  private emitEnv(name: string, ...args: string[]): void {
    (this as unknown as { emit(event: string, ...a: string[]): boolean }).emit(
      `optionEnv:${name}`,
      ...args,
    );
  }

  _parseOptionsEnv(): void {
    for (const option of this.options) {
      if (!option.envVar || !(option.envVar in this.envSource)) continue;
      const value = this.envSource[option.envVar];
      const key = option.attributeName();
      const source = this.getOptionValueSource(key);
      const overridable =
        this.getOptionValue(key) === undefined ||
        source === undefined ||
        source === 'default' ||
        source === 'config' ||
        source === 'env';
      if (!overridable) continue;
      if (option.required || option.optional) {
        if (value !== undefined && value !== '') this.emitEnv(option.name(), value);
      } else if (envIsTruthy(value)) {
        this.emitEnv(option.name());
      }
    }
  }
}

interface RawGlobals {
  json?: boolean;
  plain?: boolean;
  resultsOnly?: boolean;
  select?: string[];
  wrapUntrusted?: boolean;
  input?: boolean;
  readonly?: boolean;
  color?: string;
  baseUrl?: string;
  root?: string;
  timeout?: number;
  verbose?: boolean;
  failEmpty?: boolean;
}

/** Turns parsed flags into the effective GlobalOptions; throws UsageError on conflicts. */
export function resolveGlobals(raw: RawGlobals, ctx: RunIO): GlobalOptions {
  if (raw.json && raw.plain) {
    throw new UsageError('--json and --plain are mutually exclusive', {
      hint: 'Pass exactly one of --json or --plain (or unset BS_JSON / BS_PLAIN).',
    });
  }
  let json = Boolean(raw.json);
  const plain = Boolean(raw.plain);
  if (!json && !plain && envIsTruthy(ctx.env.BS_AUTO_JSON) && !ctx.stdoutIsTTY) json = true;
  if (raw.resultsOnly && !json) {
    throw new UsageError('--results-only requires --json', {
      hint: 'Run the same command with --json --results-only.',
    });
  }
  if (raw.select && !json) {
    throw new UsageError('--select requires --json', {
      hint: 'Run the same command with --json --select <paths>.',
    });
  }
  const outputMode: OutputMode = json ? 'json' : plain ? 'plain' : 'human';
  const colorMode = (raw.color ?? 'auto') as ColorMode;
  return {
    json,
    plain,
    outputMode,
    resultsOnly: Boolean(raw.resultsOnly),
    select: raw.select,
    wrapUntrusted: Boolean(raw.wrapUntrusted),
    noInput: raw.input === false || !ctx.stdinIsTTY,
    readonly: true,
    colorMode,
    color: resolveColor(colorMode, { env: ctx.env, isTTY: ctx.stdoutIsTTY, outputMode }),
    baseUrl: raw.baseUrl,
    root: raw.root,
    timeout: raw.timeout ?? 30,
    verbose: Boolean(raw.verbose),
    failEmpty: Boolean(raw.failEmpty),
  };
}

export function buildProgram(ctx: CliContext): Command {
  const program = new BsCommand('bs');
  program.envSource = ctx.env;
  program
    .description(
      'Read Brightspace (D2L) data from the shell: courses, assignments, quizzes, grades, announcements, content, discussions and calendar. Built for AI agents and scripts: --json on stdout, everything else on stderr, named exit codes (see `bs schema --json`).',
    )
    .version(getBuildInfo().version, '-V, --version', 'print the version')
    .exitOverride()
    .configureOutput({
      writeOut: (str) => ctx.stdout.write(str),
      writeErr: (str) => ctx.stderr.write(str),
      outputError: (str, write) => write(str),
    })
    .showHelpAfterError("(run 'bs --help' or 'bs <command> --help' for usage)")
    .allowExcessArguments(false);

  addGlobalOptions(program);

  program.hook('preAction', (_root, actionCommand) => {
    ctx.globals = resolveGlobals(actionCommand.optsWithGlobals() as RawGlobals, ctx);
  });

  for (const register of commands) register(program, ctx);
  return program;
}

/** Runs the CLI for `argv` (without node/script) and returns the exit code. */
export async function run(argv: readonly string[], io: Partial<RunIO> = {}): Promise<number> {
  const ctx = createContext(io);
  const program = buildProgram(ctx);
  try {
    await program.parseAsync([...argv], { from: 'user' });
    return EXIT_CODES.ok;
  } catch (err) {
    const code = exitCodeFor(err);
    if (code !== EXIT_CODES.ok && !isSilent(err)) {
      const text = formatError(err);
      if (text) {
        ctx.stderr.write(`${colorize(text, 'red', ctx.globals.color && ctx.stderrIsTTY)}\n`);
      }
    }
    return code;
  }
}
