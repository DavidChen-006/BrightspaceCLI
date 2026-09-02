/**
 * The download plumbing every `download` verb shares (assignments, announcements, content):
 * the file name from `Content-Disposition`, one sanitiser, `--out` resolution (a directory, a
 * file path, or `-` for raw bytes on stdout), streaming to a same-directory `.part` file that
 * is renamed only once complete, and one overwrite rule: an existing file is never replaced
 * without `--force` (UsageError, exit 2).
 */
import { mkdir, open, rename, stat, unlink } from 'node:fs/promises';
import path from 'node:path';
import { BsError, RetryableError, UsageError } from '../core/errors.js';
import type { Sink } from '../core/output.js';
import type { CliContext } from './context.js';

// ---------------------------------------------------------------------------------------------
// Names
// ---------------------------------------------------------------------------------------------

/**
 * The file name a `Content-Disposition` header carries: the RFC 6266/5987 `filename*` form
 * (percent-decoded, charset and language ignored) wins over a quoted `filename`, which wins
 * over a bare one. Anything missing, empty or undecodable is null.
 */
export function filenameFromContentDisposition(header: string | undefined): string | null {
  if (header === undefined || header === '') return null;
  const extended = /filename\*\s*=\s*(?:[\w-]+)?'[^']*'([^;]+)/i.exec(header);
  if (extended?.[1] !== undefined) {
    try {
      const decoded = decodeURIComponent(extended[1].trim().replace(/^"|"$/g, ''));
      if (decoded.trim() !== '') return decoded;
    } catch {
      // Malformed percent-encoding: fall through to the plain parameter, then null.
    }
  }
  const quoted = /filename\s*=\s*"((?:[^"\\]|\\.)*)"/i.exec(header);
  if (quoted?.[1] !== undefined) {
    const name = quoted[1].replace(/\\(.)/g, '$1').trim();
    return name === '' ? null : name;
  }
  const bare = /filename\s*=\s*([^;]+)/i.exec(header);
  if (bare?.[1] !== undefined) {
    const name = bare[1].trim();
    return name === '' ? null : name;
  }
  return null;
}

/** NAME_MAX on every filesystem we care about. */
const MAX_FILE_NAME_BYTES = 255;
/** Extensions longer than this are treated as part of the stem when capping. */
const MAX_EXTENSION_CHARS = 16;

function capFileName(name: string): string {
  if (Buffer.byteLength(name, 'utf8') <= MAX_FILE_NAME_BYTES) return name;
  const dot = name.lastIndexOf('.');
  const ext = dot > 0 && name.length - dot <= MAX_EXTENSION_CHARS ? name.slice(dot) : '';
  const stem = [...name.slice(0, name.length - ext.length)];
  while (stem.length > 0 && Buffer.byteLength(stem.join('') + ext, 'utf8') > MAX_FILE_NAME_BYTES) {
    stem.pop();
  }
  return `${stem.join('')}${ext}`;
}

/**
 * A tenant-supplied name reduced to one path component that is safe to create under `--out`
 * on every platform: the last segment only (both separators), control and reserved
 * characters (`<>:"|?*`) removed, leading dots and spaces dropped (no hidden or `..` names),
 * trailing dots and spaces dropped, length capped at 255 bytes with the extension kept.
 * `fallback` when nothing usable remains.
 */
export function safeFileName(raw: string | null | undefined, fallback: string): string {
  if (typeof raw !== 'string') return fallback;
  const last = raw.split(/[\\/]/).pop() ?? '';
  const cleaned = last
    // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what we strip
    .replace(/[\x00-\x1f\x7f<>:"|?*]/g, '')
    .replace(/^[.\s]+/, '')
    .replace(/[.\s]+$/, '');
  if (cleaned === '') return fallback;
  const capped = capFileName(cleaned).replace(/^[.\s]+/, '');
  return capped === '' ? fallback : capped;
}

// ---------------------------------------------------------------------------------------------
// --out resolution
// ---------------------------------------------------------------------------------------------

/** Where a download goes: raw bytes on stdout, or one file path. */
export type OutTarget = { kind: 'stdout' } | { kind: 'file'; path: string };

export const STDOUT_TARGET: OutTarget = { kind: 'stdout' };

/** `out` names raw bytes on stdout. */
export function isStdoutTarget(out: string | undefined): boolean {
  return out === '-';
}

async function isDirectory(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isDirectory();
  } catch {
    return false;
  }
}

function fsError(action: string, target: string, err: unknown): BsError {
  const reason = err instanceof Error ? err.message : String(err);
  return new BsError('error', `${action} ${target}: ${reason}`, {
    hint: 'Check that the --out path is writable and that no file stands where a directory is needed.',
    cause: err,
  });
}

/**
 * `--out` as a directory to write into: the current directory when omitted, otherwise the
 * path resolved against `ctx.cwd` and created on demand. Returns the absolute directory.
 */
export async function resolveOutDir(
  ctx: Pick<CliContext, 'cwd'>,
  out: string | undefined,
): Promise<string> {
  const dir = out === undefined ? ctx.cwd : path.resolve(ctx.cwd, out);
  try {
    await mkdir(dir, { recursive: true });
  } catch (err) {
    throw fsError('cannot create directory', dir, err);
  }
  return dir;
}

/**
 * Where one file lands. `-` is stdout. An omitted `--out` is `<cwd>/<defaultName>`. A path
 * with a trailing separator, or one that names an existing directory, takes the file inside it
 * (the directory is created on demand). Anything else is the exact file path, its parent
 * created on demand. The result is absolute.
 */
export async function resolveOutTarget(
  ctx: Pick<CliContext, 'cwd'>,
  out: string | undefined,
  defaultName: string,
): Promise<OutTarget> {
  if (isStdoutTarget(out)) return STDOUT_TARGET;
  if (out === undefined) return { kind: 'file', path: path.join(ctx.cwd, defaultName) };
  const resolved = path.resolve(ctx.cwd, out);
  if (/[\\/]$/.test(out) || (await isDirectory(resolved))) {
    return { kind: 'file', path: path.join(await resolveOutDir(ctx, resolved), defaultName) };
  }
  await resolveOutDir(ctx, path.dirname(resolved));
  return { kind: 'file', path: resolved };
}

// ---------------------------------------------------------------------------------------------
// Streaming
// ---------------------------------------------------------------------------------------------

export interface WriteStreamOptions {
  /** Replace an existing file instead of refusing (exit 2). */
  force?: boolean;
  /** Names the request in an interruption error (`GET .../attachments/1`); default "download". */
  label?: string;
}

/** Bytes reach stdout through the context's sink; a `false` from `write` waits for `drain`. */
export async function writeStreamToSink(
  body: ReadableStream<Uint8Array>,
  sink: Sink,
): Promise<number> {
  const reader = body.getReader();
  let bytes = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return bytes;
    bytes += value.byteLength;
    const ok = sink.write(value);
    if (ok === false && typeof sink.once === 'function') {
      await new Promise<void>((resolve) => sink.once?.('drain', resolve));
    }
  }
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Streams `body` into `file` through a same-directory `<file>.part` and a final rename, so an
 * interrupted download never leaves a truncated file under the final name. An existing file is
 * refused without `force` (UsageError naming `--force`). A body that fails mid-stream is a
 * RetryableError; a filesystem failure is a plain error. The body is cancelled on any failure.
 * Returns the bytes written.
 */
export async function writeStreamToFile(
  body: ReadableStream<Uint8Array>,
  file: string,
  options: WriteStreamOptions = {},
): Promise<number> {
  const partial = `${file}.part`;
  try {
    if (options.force !== true && (await fileExists(file))) {
      throw new UsageError(`refusing to overwrite ${file}`, {
        hint: 'Pass --force to overwrite, or --out <path> to write somewhere else.',
      });
    }
    let handle: Awaited<ReturnType<typeof open>>;
    try {
      handle = await open(partial, 'w');
    } catch (err) {
      throw fsError('cannot write', partial, err);
    }
    let bytes = 0;
    try {
      const reader = body.getReader();
      for (;;) {
        let chunk: Awaited<ReturnType<typeof reader.read>>;
        try {
          chunk = await reader.read();
        } catch (err) {
          const reason = err instanceof Error ? err.message : String(err);
          throw new RetryableError(`${options.label ?? 'download'}: interrupted: ${reason}`, {
            cause: err,
          });
        }
        if (chunk.done) break;
        try {
          await handle.write(chunk.value);
        } catch (err) {
          throw fsError('cannot write', partial, err);
        }
        bytes += chunk.value.byteLength;
      }
      await handle.close();
      try {
        await rename(partial, file);
      } catch (err) {
        throw fsError('cannot write', file, err);
      }
    } catch (err) {
      await handle.close().catch(() => {});
      await unlink(partial).catch(() => {});
      throw err;
    }
    return bytes;
  } catch (err) {
    await body.cancel().catch(() => {});
    throw err;
  }
}

/** Sends the body where `target` points: the context's stdout sink, or a file on disk. */
export function downloadTo(
  ctx: Pick<CliContext, 'stdout'>,
  target: OutTarget,
  body: ReadableStream<Uint8Array>,
  options: WriteStreamOptions = {},
): Promise<number> {
  return target.kind === 'stdout'
    ? writeStreamToSink(body, ctx.stdout)
    : writeStreamToFile(body, target.path, options);
}
