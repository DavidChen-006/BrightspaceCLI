/**
 * Per-invocation context handed to every command: streams, environment, resolved global
 * flags, lazily resolved paths/config, and the one output seam (`emit`).
 */
import type { DoctorDeps } from '../auth/doctor.js';
import type { Rung } from '../auth/ladder.js';
import type { FullRungFactory } from '../auth/rungs/full.js';
import { silentRung } from '../auth/rungs/silent.js';
import { loadConfig, type TenantConfig } from '../core/config.js';
import { createHttp, type HttpClient, type Transport } from '../core/http/index.js';
import {
  type ColorMode,
  type Column,
  colorize,
  newMarkerId,
  type OutputMode,
  type Row,
  type Sink,
  unwrapResults,
  writeJson,
  writeTsv,
} from '../core/output.js';
import { type BsPaths, resolvePaths } from '../core/paths.js';

export interface GlobalOptions {
  json: boolean;
  plain: boolean;
  outputMode: OutputMode;
  resultsOnly: boolean;
  select: string[] | undefined;
  wrapUntrusted: boolean;
  /** --no-input, or stdin is not a TTY. */
  noInput: boolean;
  /** Always true in v1 (PRD 3). */
  readonly: true;
  colorMode: ColorMode;
  /** Effective: mode resolved against TTY/NO_COLOR and forced off under json/plain. */
  color: boolean;
  baseUrl: string | undefined;
  root: string | undefined;
  /** Seconds to first response byte. */
  timeout: number;
  verbose: boolean;
  failEmpty: boolean;
}

export function defaultGlobals(): GlobalOptions {
  return {
    json: false,
    plain: false,
    outputMode: 'human',
    resultsOnly: false,
    select: undefined,
    wrapUntrusted: false,
    noInput: true,
    readonly: true,
    colorMode: 'auto',
    color: false,
    baseUrl: undefined,
    root: undefined,
    timeout: 30,
    verbose: false,
    failEmpty: false,
  };
}

export interface RunIO {
  stdout: Sink;
  stderr: Sink;
  env: NodeJS.ProcessEnv;
  stdinIsTTY: boolean;
  stdoutIsTTY: boolean;
  stderrIsTTY: boolean;
  cwd: string;
  /** Where prompts read their answer; defaults to process.stdin. */
  stdin?: NodeJS.ReadableStream;
  /** Test injection only; defaults to global fetch. */
  transport?: Transport;
  /** Test injection only; defaults to the silent rung (`ctx.rungs`). */
  rungs?: Rung[];
  /**
   * Test injection only: how `bs auth login` builds its full rung (defaults to `fullRung()` in
   * `src/auth/rungs/full.ts`). Never a rung in `rungs`: no other command may climb it.
   */
  fullRung?: FullRungFactory;
  /** Test injection only: the probes `bs auth doctor` runs (defaults to the real environment). */
  doctor?: Partial<DoctorDeps>;
}

export interface CliContext extends RunIO {
  /** Populated by the root preAction hook before any command action runs. */
  globals: GlobalOptions;
  /** Random 16-hex id for this invocation's untrusted markers. */
  markerId: string;
  /** Pure path resolution (no filesystem access); memoized. */
  paths(): BsPaths;
  /** Effective tenant config (flags > env > config.json > defaults); memoized. */
  config(): TenantConfig;
  /** The HTTP client for this invocation (timeout, verbose log, injected transport); memoized. */
  http(): HttpClient;
  stdin: NodeJS.ReadableStream;
  /**
   * Ladder rungs above rung 0, in climb order: the silent rung by default, so data commands go
   * rung 0 → silent → exit 4. The full rung is only ever passed explicitly by `bs auth login`.
   */
  rungs: Rung[];
  /** Human line to stderr. */
  log(message: string): void;
  warn(message: string): void;
  /** Only under --verbose. Never pass secrets; log lengths and labels. */
  debug(message: string): void;
}

export function createContext(io: Partial<RunIO> = {}): CliContext {
  const base: RunIO = {
    stdout: io.stdout ?? process.stdout,
    stderr: io.stderr ?? process.stderr,
    env: io.env ?? process.env,
    stdinIsTTY: io.stdinIsTTY ?? Boolean(process.stdin.isTTY),
    stdoutIsTTY: io.stdoutIsTTY ?? Boolean(process.stdout.isTTY),
    stderrIsTTY: io.stderrIsTTY ?? Boolean(process.stderr.isTTY),
    cwd: io.cwd ?? process.cwd(),
    stdin: io.stdin ?? process.stdin,
    transport: io.transport,
    fullRung: io.fullRung,
    doctor: io.doctor,
  };
  let paths: BsPaths | undefined;
  let config: TenantConfig | undefined;
  let http: HttpClient | undefined;
  const ctx: CliContext = {
    ...base,
    stdin: base.stdin ?? process.stdin,
    globals: defaultGlobals(),
    markerId: newMarkerId(),
    rungs: io.rungs ?? [silentRung()],
    paths() {
      paths ??= resolvePaths({ root: ctx.globals.root, env: ctx.env, cwd: ctx.cwd });
      return paths;
    },
    config() {
      config ??= loadConfig({
        env: ctx.env,
        configFile: ctx.paths().configFile,
        overrides: ctx.globals.baseUrl === undefined ? {} : { baseUrl: ctx.globals.baseUrl },
        warn: (m) => ctx.warn(m),
      });
      return config;
    },
    http() {
      http ??= createHttp({
        transport: ctx.transport,
        timeoutMs: ctx.globals.timeout * 1000,
        verbose: ctx.globals.verbose,
        log: (line) => ctx.debug(line),
      });
      return http;
    },
    log(message) {
      ctx.stderr.write(`${message}\n`);
    },
    warn(message) {
      const useColor = ctx.globals.color && ctx.stderrIsTTY;
      ctx.stderr.write(`${colorize(`warning: ${message}`, 'yellow', useColor)}\n`);
    },
    debug(message) {
      if (ctx.globals.verbose) ctx.stderr.write(`${message}\n`);
    },
  };
  return ctx;
}

export interface EmitResult {
  /** The JSON value (a list envelope {items, count, fetchedAt} or a bare object). */
  value: unknown;
  /** TSV columns/rows for --plain; derived from `value` when omitted. */
  tsv?: { columns: readonly (string | Column)[]; rows: readonly Row[] };
  /** Human rendering; defaults to the JSON text. */
  human?: string | (() => string);
  /** Set false for trusted local metadata (version, schema) that must never be wrapped. */
  wrap?: boolean;
}

function deriveTsv(value: unknown): { columns: string[]; rows: Row[] } {
  const unwrapped = unwrapResults(value);
  const items = Array.isArray(unwrapped) ? unwrapped : [unwrapped];
  const rows = items.map((item) =>
    typeof item === 'object' && item !== null && !Array.isArray(item)
      ? (item as Row)
      : { value: item },
  );
  const columns: string[] = [];
  for (const row of rows) {
    for (const key of Object.keys(row)) if (!columns.includes(key)) columns.push(key);
  }
  return { columns, rows };
}

/** Writes a command result on stdout in the mode chosen by the global flags. */
export function emit(ctx: CliContext, result: EmitResult): void {
  const g = ctx.globals;
  switch (g.outputMode) {
    case 'json': {
      const wrap = result.wrap !== false && g.wrapUntrusted ? { id: ctx.markerId } : false;
      writeJson(ctx.stdout, result.value, { resultsOnly: g.resultsOnly, select: g.select, wrap });
      return;
    }
    case 'plain': {
      const tsv = result.tsv ?? deriveTsv(result.value);
      writeTsv(ctx.stdout, tsv.rows, tsv.columns);
      return;
    }
    default: {
      if (result.human === undefined) {
        writeJson(ctx.stdout, result.value);
      } else {
        const text = typeof result.human === 'function' ? result.human() : result.human;
        ctx.stdout.write(text.endsWith('\n') ? text : `${text}\n`);
      }
    }
  }
}
