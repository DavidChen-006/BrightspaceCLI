import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  downloadTo,
  filenameFromContentDisposition,
  isStdoutTarget,
  resolveOutDir,
  resolveOutTarget,
  STDOUT_TARGET,
  safeFileName,
  writeStreamToFile,
  writeStreamToSink,
} from '../../src/cli/download.js';
import { BsError, EXIT_CODES, exitCodeFor, UsageError } from '../../src/core/errors.js';
import { streamOf } from '../helpers/http.js';

function tmp(): string {
  return mkdtempSync(path.join(os.tmpdir(), 'bs-download-'));
}

/** A body that yields `chunks` in order, then optionally errors instead of closing. */
function bodyOf(chunks: (string | Uint8Array)[], failWith?: Error): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) {
        controller.enqueue(typeof c === 'string' ? new TextEncoder().encode(c) : c);
      }
      if (failWith) controller.error(failWith);
      else controller.close();
    },
  });
}

// ---------------------------------------------------------------------------------------------
// names
// ---------------------------------------------------------------------------------------------

test('filenameFromContentDisposition: RFC 5987 filename* wins, then quoted, then bare; junk is null', () => {
  assert.equal(
    filenameFromContentDisposition(
      'attachment; filename="x.pdf"; filename*=UTF-8\'\'r%C3%A9sum%C3%A9.pdf',
    ),
    'résumé.pdf',
  );
  assert.equal(
    filenameFromContentDisposition("attachment; filename*=utf-8'en'hello%20world.txt"),
    'hello world.txt',
  );
  assert.equal(filenameFromContentDisposition('attachment; filename="hw3.pdf"'), 'hw3.pdf');
  assert.equal(
    filenameFromContentDisposition('attachment; filename="lecture 01.pdf"'),
    'lecture 01.pdf',
  );
  assert.equal(filenameFromContentDisposition('attachment; filename="a \\"b\\".txt"'), 'a "b".txt');
  assert.equal(filenameFromContentDisposition('attachment; filename=hw3.pdf'), 'hw3.pdf');
  assert.equal(filenameFromContentDisposition('inline; filename=notes.txt'), 'notes.txt');
  assert.equal(filenameFromContentDisposition('inline; filename=notes.txt; size=3'), 'notes.txt');
  assert.equal(filenameFromContentDisposition("attachment; filename*=utf-8''%ZZbad"), null);
  assert.equal(filenameFromContentDisposition('attachment; filename=""'), null);
  assert.equal(filenameFromContentDisposition('attachment'), null);
  assert.equal(filenameFromContentDisposition('inline'), null);
  assert.equal(filenameFromContentDisposition(''), null);
  assert.equal(filenameFromContentDisposition(undefined), null);
});

test('safeFileName: one path component, no control or reserved characters, no hidden names, capped', () => {
  assert.equal(safeFileName('hw3.pdf', 'fallback'), 'hw3.pdf');
  assert.equal(safeFileName('../../etc/passwd', 'fallback'), 'passwd');
  assert.equal(safeFileName('C:\\Users\\me\\notes.txt', 'fallback'), 'notes.txt');
  assert.equal(safeFileName('..\\..\\evil.exe', 'fallback'), 'evil.exe');
  assert.equal(safeFileName('..', 'fallback'), 'fallback');
  assert.equal(safeFileName('...', 'fallback'), 'fallback');
  assert.equal(safeFileName('.hidden', 'fallback'), 'hidden');
  assert.equal(safeFileName('  .hidden  ', 'fallback'), 'hidden');
  assert.equal(safeFileName('a\u0000b\nc.txt', 'fallback'), 'abc.txt');
  assert.equal(safeFileName('a<b>c:d"e|f?g*h\u0000.pdf', 'fallback'), 'abcdefgh.pdf');
  assert.equal(safeFileName('Lecture 1: slides / notes', 'fallback'), 'notes');
  assert.equal(safeFileName('trailing. ', 'fallback'), 'trailing');
  assert.equal(safeFileName('résumé v2.pdf', 'fallback'), 'résumé v2.pdf');
  assert.equal(safeFileName('', 'fallback'), 'fallback');
  assert.equal(safeFileName('   ', 'fallback'), 'fallback');
  assert.equal(safeFileName(null, 'file-90001'), 'file-90001');
  assert.equal(safeFileName(undefined, 'file-90001'), 'file-90001');

  const long = safeFileName(`${'x'.repeat(300)}.pdf`, 'fallback');
  assert.equal(long.length, 255);
  assert.ok(long.endsWith('.pdf'), 'extension kept when capping');
  const wide = safeFileName(`${'é'.repeat(300)}.txt`, 'fallback');
  assert.ok(Buffer.byteLength(wide, 'utf8') <= 255, 'capped by bytes, not characters');
  assert.ok(wide.endsWith('.txt'));
  assert.ok(!wide.includes('\uFFFD'), 'never splits a code point');
  const noExt = safeFileName('y'.repeat(400), 'fallback');
  assert.equal(noExt.length, 255);
});

// ---------------------------------------------------------------------------------------------
// --out resolution
// ---------------------------------------------------------------------------------------------

test('resolveOutTarget: omitted → cwd/name; "-" → stdout; existing dir or trailing slash → inside', async () => {
  const cwd = tmp();
  try {
    assert.deepEqual(await resolveOutTarget({ cwd }, undefined, 'a.pdf'), {
      kind: 'file',
      path: path.join(cwd, 'a.pdf'),
    });
    assert.deepEqual(await resolveOutTarget({ cwd }, '-', 'a.pdf'), STDOUT_TARGET);
    assert.ok(isStdoutTarget('-'));
    assert.ok(!isStdoutTarget('./-'));
    assert.ok(!isStdoutTarget(undefined));

    const existing = path.join(cwd, 'downloads');
    mkdirSync(existing);
    assert.deepEqual(await resolveOutTarget({ cwd }, 'downloads', 'a.pdf'), {
      kind: 'file',
      path: path.join(existing, 'a.pdf'),
    });
    assert.deepEqual(await resolveOutTarget({ cwd }, existing, 'a.pdf'), {
      kind: 'file',
      path: path.join(existing, 'a.pdf'),
    });

    const created = await resolveOutTarget({ cwd }, 'new/dir/', 'a.pdf');
    assert.deepEqual(created, { kind: 'file', path: path.join(cwd, 'new', 'dir', 'a.pdf') });
    assert.ok(existsSync(path.join(cwd, 'new', 'dir')), 'a trailing slash creates the directory');
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('resolveOutTarget: anything else is an exact file path whose parent is created on demand', async () => {
  const cwd = tmp();
  try {
    const exact = await resolveOutTarget({ cwd }, 'nested/dir/renamed.pdf', 'ignored.pdf');
    assert.deepEqual(exact, { kind: 'file', path: path.join(cwd, 'nested', 'dir', 'renamed.pdf') });
    assert.ok(existsSync(path.join(cwd, 'nested', 'dir')));
    assert.ok(!existsSync(path.join(cwd, 'nested', 'dir', 'renamed.pdf')), 'nothing written yet');

    const abs = path.join(cwd, 'abs.bin');
    assert.deepEqual(await resolveOutTarget({ cwd }, abs, 'ignored'), { kind: 'file', path: abs });

    writeFileSync(path.join(cwd, 'blocker'), 'a file, not a directory');
    await assert.rejects(
      resolveOutTarget({ cwd }, 'blocker/inside.pdf', 'x'),
      (err: unknown) => err instanceof BsError && exitCodeFor(err) === EXIT_CODES.error,
    );
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('resolveOutDir: cwd by default, resolved against cwd and created on demand', async () => {
  const cwd = tmp();
  try {
    assert.equal(await resolveOutDir({ cwd }, undefined), cwd);
    const dir = await resolveOutDir({ cwd }, 'deep/er');
    assert.equal(dir, path.join(cwd, 'deep', 'er'));
    assert.ok(existsSync(dir));
    assert.equal(await resolveOutDir({ cwd }, dir), dir);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------------------------
// streaming
// ---------------------------------------------------------------------------------------------

test('writeStreamToFile: streams through .part and renames; no temp file survives', async () => {
  const dir = tmp();
  try {
    const file = path.join(dir, 'out.bin');
    const bytes = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x00, 0xff, 0xfe, 0x80, 0x0a, 0x0d]);
    const n = await writeStreamToFile(
      bodyOf([new Uint8Array(bytes.subarray(0, 4)), new Uint8Array(bytes.subarray(4))]),
      file,
    );
    assert.equal(n, bytes.length);
    assert.deepEqual(readFileSync(file), bytes);
    assert.deepEqual(readdirSync(dir), ['out.bin']);

    const empty = await writeStreamToFile(bodyOf([]), path.join(dir, 'empty'));
    assert.equal(empty, 0);
    assert.equal(readFileSync(path.join(dir, 'empty')).length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('writeStreamToFile: refuses to overwrite without force (exit 2 naming --force); force replaces', async () => {
  const dir = tmp();
  try {
    const file = path.join(dir, 'keep.txt');
    writeFileSync(file, 'old contents');
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('new'));
      },
      cancel() {
        cancelled = true;
      },
    });
    await assert.rejects(writeStreamToFile(body, file), (err: unknown) => {
      assert.ok(err instanceof UsageError);
      assert.equal(exitCodeFor(err), EXIT_CODES.usage);
      assert.match(err.message, /refusing to overwrite/);
      assert.match(err.hint ?? '', /--force/);
      return true;
    });
    assert.equal(readFileSync(file, 'utf8'), 'old contents');
    assert.deepEqual(readdirSync(dir), ['keep.txt'], 'no .part left behind');
    assert.ok(cancelled, 'the body is cancelled when refused');

    const n = await writeStreamToFile(streamOf('replaced'), file, { force: true });
    assert.equal(n, 8);
    assert.equal(readFileSync(file, 'utf8'), 'replaced');
    assert.deepEqual(readdirSync(dir), ['keep.txt']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('writeStreamToFile: a body that fails mid-stream is retryable and leaves nothing behind', async () => {
  const dir = tmp();
  try {
    const file = path.join(dir, 'cut.bin');
    await assert.rejects(
      writeStreamToFile(bodyOf(['partial'], new Error('socket hang up')), file, {
        label: 'GET /d2l/api/le/1.96/1/news/2/attachments/3',
      }),
      (err: unknown) => {
        assert.ok(err instanceof BsError);
        assert.equal(exitCodeFor(err), EXIT_CODES.retryable);
        assert.match(
          err.message,
          /^GET \/d2l\/api\/le\/1\.96\/1\/news\/2\/attachments\/3: interrupted: socket hang up$/,
        );
        return true;
      },
    );
    assert.deepEqual(readdirSync(dir), [], 'neither the file nor its .part survives');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('writeStreamToFile: an unwritable target is a plain error (exit 1) and the body is cancelled', async () => {
  const dir = tmp();
  try {
    writeFileSync(path.join(dir, 'blocker'), 'a file');
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('x'));
        controller.close();
      },
      cancel() {
        cancelled = true;
      },
    });
    await assert.rejects(
      writeStreamToFile(body, path.join(dir, 'blocker', 'inside.bin')),
      (err: unknown) => {
        assert.ok(err instanceof BsError);
        assert.equal(exitCodeFor(err), EXIT_CODES.error);
        assert.match(err.message, /cannot write .*inside\.bin\.part/);
        return true;
      },
    );
    assert.ok(cancelled);
    assert.deepEqual(readdirSync(dir), ['blocker']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('writeStreamToSink: bytes reach the sink in order; a false write waits for drain', async () => {
  const chunks: Buffer[] = [];
  let drains = 0;
  const sink = {
    write(chunk: string | Uint8Array) {
      chunks.push(Buffer.from(chunk));
      return chunks.length !== 1;
    },
    once(event: 'drain', listener: () => void) {
      assert.equal(event, 'drain');
      drains += 1;
      setImmediate(listener);
    },
  };
  const n = await writeStreamToSink(bodyOf(['ab', 'cd', 'e']), sink);
  assert.equal(n, 5);
  assert.equal(Buffer.concat(chunks).toString(), 'abcde');
  assert.equal(drains, 1);

  const plain: Buffer[] = [];
  const unbounded = {
    write(chunk: string | Uint8Array) {
      plain.push(Buffer.from(chunk));
      return false;
    },
  };
  assert.equal(await writeStreamToSink(bodyOf(['x', 'y']), unbounded), 2);
  assert.equal(Buffer.concat(plain).toString(), 'xy');
});

test('downloadTo dispatches on the target kind', async () => {
  const dir = tmp();
  try {
    const out: Buffer[] = [];
    const ctx = {
      stdout: {
        write(chunk: string | Uint8Array) {
          out.push(Buffer.from(chunk));
          return true;
        },
      },
    };
    assert.equal(await downloadTo(ctx, STDOUT_TARGET, bodyOf(['to stdout'])), 9);
    assert.equal(Buffer.concat(out).toString(), 'to stdout');
    assert.deepEqual(readdirSync(dir), []);

    const file = path.join(dir, 'f.txt');
    assert.equal(await downloadTo(ctx, { kind: 'file', path: file }, bodyOf(['to disk'])), 7);
    assert.equal(readFileSync(file, 'utf8'), 'to disk');
    assert.equal(Buffer.concat(out).toString(), 'to stdout', 'nothing more on stdout');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
