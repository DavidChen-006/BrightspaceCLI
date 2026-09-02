/**
 * Where the full login's credentials come from (PRD 7 rung 2, PRD 8.1 `credentials.json`).
 *
 * One lookup, one fixed order:
 *
 *   1. `BS_EMAIL` + `BS_PASSWORD` (both or neither: half a credential is a config error)
 *   2. `--email` + `--password-stdin` (the whole stdin, one trailing newline trimmed)
 *   3. `credentials.json` in the root (0600; only ever written by `--save-credentials`)
 *   4. a TTY prompt on stderr: readline for the email, CLOSED before a raw-mode masked password
 *      read (left open, readline echoes the "hidden" password: Brightspace-Bar live bug 2026-08-24)
 *   5. nothing and no terminal (non-TTY or --no-input) → AuthRequiredError, exit 4, at once
 *
 * Secrets discipline (PRD 8.2): the password is never logged, echoed, or put in an error.
 * Ported from Brightspace-Bar `session-capture/src/credentials.mjs` (evidence: sweep Extra 3).
 */
import { createInterface } from 'node:readline';
import { readJsonFile, SECRET_FILE_MODE, writeJsonAtomic } from '../core/atomic.js';
import { AuthRequiredError, CancelledError, ConfigError, UsageError } from '../core/errors.js';
import type { Sink } from '../core/output.js';
import { type BsPaths, ensureDirs } from '../core/paths.js';

export interface Credentials {
  email: string;
  password: string;
}

export type CredentialSource = 'env' | 'flags' | 'file' | 'prompt';

export interface ResolvedCredentials extends Credentials {
  source: CredentialSource;
}

export const HINT_CREDENTIALS =
  'Set BS_EMAIL and BS_PASSWORD, or run: bs auth login --email <email> --password-stdin  (password on stdin), or run it in a terminal to be prompted.';

export const EMAIL_PROMPT = 'Brightspace email: ';
export const PASSWORD_PROMPT = 'Brightspace password (input hidden): ';

export interface ResolveCredentialsInput {
  env: NodeJS.ProcessEnv;
  paths: BsPaths;
  /** `--email`. */
  email?: string | undefined;
  /** `--password-stdin`. */
  passwordStdin?: boolean | undefined;
  /** Where `--password-stdin` and the prompts read. */
  stdin: NodeJS.ReadableStream;
  /** Where the prompts are written. */
  stderr: Sink;
  /** stdin is a TTY and `--no-input` was not given. */
  canPrompt: boolean;
  /** A line the user sees; never a secret. */
  warn?: (line: string) => void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value !== '';
}

/** `{email, password}` from credentials.json, or null when missing, corrupt or incomplete. */
export function readCredentialsFile(paths: BsPaths): Credentials | null {
  const raw = readJsonFile(paths.credentialsFile);
  if (!isRecord(raw) || !nonEmpty(raw.email) || !nonEmpty(raw.password)) return null;
  return { email: raw.email, password: raw.password };
}

/** The ONLY writer of credentials.json: atomic, 0600, inside the 0700 root. Throws on I/O failure. */
export function writeCredentialsFile(paths: BsPaths, credentials: Credentials): void {
  ensureDirs(paths);
  writeJsonAtomic(
    paths.credentialsFile,
    { email: credentials.email, password: credentials.password },
    { mode: SECRET_FILE_MODE },
  );
}

/** The whole of stdin as UTF-8 with exactly one trailing newline (`\n` or `\r\n`) removed. */
export async function readPasswordStdin(stdin: NodeJS.ReadableStream): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stdin) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : Buffer.from(chunk));
  }
  const text = Buffer.concat(chunks).toString('utf8');
  if (text.endsWith('\r\n')) return text.slice(0, -2);
  if (text.endsWith('\n')) return text.slice(0, -1);
  return text;
}

/** One line through readline, closed before it returns; null when stdin ends first. */
async function readEmailLine(stdin: NodeJS.ReadableStream, stderr: Sink): Promise<string | null> {
  stderr.write(EMAIL_PROMPT);
  const rl = createInterface({ input: stdin, terminal: false });
  try {
    return await new Promise<string | null>((resolve) => {
      rl.once('line', (line) => resolve(line));
      rl.once('close', () => resolve(null));
    });
  } finally {
    rl.close();
  }
}

interface RawModeStream extends NodeJS.ReadableStream {
  isTTY?: boolean;
  setRawMode?: (mode: boolean) => unknown;
}

/**
 * A raw-mode line read with every keystroke handled by hand, so nothing is echoed: enter ends
 * it, backspace edits, ctrl-c cancels. A stream without `setRawMode` (a pipe, a test double) is
 * read the same way minus the mode switch. Rejects with CancelledError when stdin ends first.
 */
function readMaskedLine(stdin: RawModeStream, stderr: Sink): Promise<string> {
  stderr.write(PASSWORD_PROMPT);
  return new Promise<string>((resolve, reject) => {
    const raw = typeof stdin.setRawMode === 'function' && stdin.isTTY === true;
    let value = '';
    const cleanup = () => {
      stdin.off('data', onData);
      stdin.off('end', onEnd);
      if (raw) stdin.setRawMode?.(false);
      stdin.pause();
      stderr.write('\n');
    };
    const onEnd = () => {
      cleanup();
      reject(new CancelledError('stdin closed before a password was entered'));
    };
    const onData = (chunk: Buffer | string) => {
      const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      for (const ch of text) {
        if (ch === '\u0003') {
          cleanup();
          reject(new CancelledError('login cancelled'));
          return;
        }
        if (ch === '\r' || ch === '\n') {
          cleanup();
          resolve(value);
          return;
        }
        if (ch === '\u007f' || ch === '\b') {
          value = value.slice(0, -1);
        } else {
          value += ch;
        }
      }
    };
    if (raw) stdin.setRawMode?.(true);
    stdin.on('data', onData);
    stdin.on('end', onEnd);
    // readline leaves the stream explicitly paused; a new listener alone does not restart it.
    stdin.resume();
  });
}

/** Asks on stderr; `email` given means only the password is asked for. */
export async function promptCredentials(input: {
  stdin: NodeJS.ReadableStream;
  stderr: Sink;
  email?: string | undefined;
}): Promise<Credentials> {
  let email = input.email;
  if (email === undefined) {
    const line = await readEmailLine(input.stdin, input.stderr);
    if (line === null) throw new CancelledError('stdin closed before an email was entered');
    email = line.trim();
  }
  const password = await readMaskedLine(input.stdin, input.stderr);
  if (email === '' || password === '') {
    throw new AuthRequiredError('an email and a password are both required', {
      hint: HINT_CREDENTIALS,
    });
  }
  return { email, password };
}

function fromEnv(env: NodeJS.ProcessEnv): Credentials | null {
  const email = env.BS_EMAIL;
  const password = env.BS_PASSWORD;
  const hasEmail = nonEmpty(email);
  const hasPassword = nonEmpty(password);
  if (hasEmail && hasPassword) return { email, password };
  if (hasEmail !== hasPassword) {
    const [set, missing] = hasEmail ? ['BS_EMAIL', 'BS_PASSWORD'] : ['BS_PASSWORD', 'BS_EMAIL'];
    throw new ConfigError(`${set} is set but ${missing} is missing (set both or neither)`, {
      hint: `Export ${missing} as well, or unset ${set}.`,
    });
  }
  return null;
}

/** Resolves the credentials in the fixed order above. Never returns a half credential. */
export async function resolveCredentials(
  input: ResolveCredentialsInput,
): Promise<ResolvedCredentials> {
  const env = fromEnv(input.env);
  if (env !== null) {
    if (input.email !== undefined || input.passwordStdin) {
      input.warn?.('BS_EMAIL and BS_PASSWORD are set; ignoring --email / --password-stdin');
    }
    return { ...env, source: 'env' };
  }
  if (input.passwordStdin) {
    if (input.email === undefined) {
      throw new UsageError('--password-stdin needs --email <email>', {
        hint: 'Run: bs auth login --email <email> --password-stdin < password.txt',
      });
    }
    const password = await readPasswordStdin(input.stdin);
    if (password === '') {
      throw new UsageError('--password-stdin: stdin was empty', {
        hint: 'Pipe the password on stdin: printf %s "$PASSWORD" | bs auth login --email <email> --password-stdin',
      });
    }
    return { email: input.email, password, source: 'flags' };
  }
  if (input.email === undefined) {
    const file = readCredentialsFile(input.paths);
    if (file !== null) return { ...file, source: 'file' };
  }
  if (!input.canPrompt) {
    throw new AuthRequiredError(
      'no credentials were found and there is no terminal to ask (non-interactive or --no-input)',
      { hint: HINT_CREDENTIALS },
    );
  }
  const prompted = await promptCredentials({
    stdin: input.stdin,
    stderr: input.stderr,
    email: input.email,
  });
  return { ...prompted, source: 'prompt' };
}
