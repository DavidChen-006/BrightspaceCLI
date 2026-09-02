import { type RunIO, run } from '../../src/cli/program.js';

/** Collects everything written to it; a minimal stand-in for process.stdout/stderr. */
export class Sink {
  text = '';
  write(chunk: string | Uint8Array): boolean {
    this.text += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
    return true;
  }
}

export interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * Runs the CLI in-process with captured streams and a fully injected environment.
 * Nothing from the developer's shell leaks in unless the test passes it explicitly, and no
 * ladder rung above rung 0 is registered unless the test passes `rungs` (never a real browser).
 */
export async function runCli(argv: string[], io: Partial<RunIO> = {}): Promise<CliResult> {
  const stdout = new Sink();
  const stderr = new Sink();
  const code = await run(argv, {
    stdout,
    stderr,
    env: {},
    stdinIsTTY: false,
    stdoutIsTTY: false,
    stderrIsTTY: false,
    rungs: [],
    ...io,
  });
  return { code, stdout: stdout.text, stderr: stderr.text };
}

export function parseJson<T = unknown>(text: string): T {
  return JSON.parse(text) as T;
}
