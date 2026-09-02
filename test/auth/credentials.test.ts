import assert from 'node:assert/strict';
import { existsSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { Readable } from 'node:stream';
import { test } from 'node:test';
import {
  HINT_CREDENTIALS,
  type ResolveCredentialsInput,
  readCredentialsFile,
  readPasswordStdin,
  resolveCredentials,
  writeCredentialsFile,
} from '../../src/auth/credentials.js';
import { BsError, EXIT_CODES } from '../../src/core/errors.js';
import { ensureDirs } from '../../src/core/paths.js';
import { promptStdin, tempRoot } from '../helpers/auth.js';
import { Sink } from '../helpers/cli.js';

const EMAIL = 'student@purdue.edu';
const PASSWORD = 'PASSWORD-SECRET-9f8e7d';
const FILE_EMAIL = 'file@purdue.edu';
const FILE_PASSWORD = 'FILE-PASSWORD-SECRET-1a2b';
const CR = String.fromCharCode(13);
const CTRL_C = String.fromCharCode(3);
const BACKSPACE = String.fromCharCode(127);

/** A stdin that records whether anyone ever tried to read it. */
function untouchedStdin(): { stdin: NodeJS.ReadableStream; touched: () => boolean } {
  const stream = Readable.from([`${PASSWORD}\n`]);
  let touched = false;
  stream.on('newListener', (event: string) => {
    if (event === 'data' || event === 'readable' || event === 'end') touched = true;
  });
  const original = stream.resume.bind(stream);
  stream.resume = () => {
    touched = true;
    return original();
  };
  return { stdin: stream, touched: () => touched };
}

function input(
  root: ReturnType<typeof tempRoot>,
  overrides: Partial<ResolveCredentialsInput> = {},
): ResolveCredentialsInput {
  return {
    env: {},
    paths: root.paths,
    stdin: Readable.from([]),
    stderr: new Sink(),
    canPrompt: false,
    ...overrides,
  };
}

async function rejectsWith(
  promise: Promise<unknown>,
  code: number,
  check: (err: BsError) => void = () => {},
): Promise<BsError> {
  let caught: unknown;
  try {
    await promise;
  } catch (err) {
    caught = err;
  }
  assert.ok(caught instanceof BsError, `expected a BsError, got ${String(caught)}`);
  assert.equal(caught.exitCode, code, caught.message);
  check(caught);
  return caught;
}

test('env: BS_EMAIL + BS_PASSWORD win, nothing else is consulted', async () => {
  const root = tempRoot();
  try {
    ensureDirs(root.paths);
    writeCredentialsFile(root.paths, { email: FILE_EMAIL, password: FILE_PASSWORD });
    const { stdin, touched } = untouchedStdin();
    const warns: string[] = [];
    const creds = await resolveCredentials(
      input(root, {
        env: { BS_EMAIL: EMAIL, BS_PASSWORD: PASSWORD },
        stdin,
        canPrompt: true,
        email: 'flag@purdue.edu',
        passwordStdin: true,
        warn: (l) => warns.push(l),
      }),
    );
    assert.deepEqual(creds, { email: EMAIL, password: PASSWORD, source: 'env' });
    assert.equal(touched(), false, 'stdin untouched');
    assert.equal(warns.length, 1, 'the ignored flags are called out');
    assert.match(warns[0] ?? '', /BS_EMAIL/);
    assert.match(warns[0] ?? '', /--email/);
    assert.equal(warns.join('\n').includes(PASSWORD), false);
  } finally {
    rmSync(root.root, { recursive: true, force: true });
  }
});

test('env: one of BS_EMAIL / BS_PASSWORD alone is a config error (exit 10) naming the missing one', async () => {
  const root = tempRoot();
  try {
    const onlyEmail = await rejectsWith(
      resolveCredentials(input(root, { env: { BS_EMAIL: EMAIL }, canPrompt: true })),
      EXIT_CODES.config,
    );
    assert.match(onlyEmail.message, /BS_PASSWORD/);
    assert.match(onlyEmail.message, /missing|not set/);
    const onlyPassword = await rejectsWith(
      resolveCredentials(input(root, { env: { BS_PASSWORD: PASSWORD }, canPrompt: true })),
      EXIT_CODES.config,
    );
    assert.match(onlyPassword.message, /BS_EMAIL/);
    assert.equal(onlyPassword.message.includes(PASSWORD), false);
    assert.equal((onlyPassword.hint ?? '').includes(PASSWORD), false);
    // Empty strings count as unset.
    const empty = await resolveCredentials(
      input(root, {
        env: { BS_EMAIL: '', BS_PASSWORD: '' },
        email: EMAIL,
        passwordStdin: true,
        stdin: Readable.from([`${PASSWORD}\n`]),
      }),
    );
    assert.equal(empty.source, 'flags');
  } finally {
    rmSync(root.root, { recursive: true, force: true });
  }
});

test('flags: --email + --password-stdin read the whole stdin and trim one trailing newline', async () => {
  const root = tempRoot();
  try {
    const cases: [string, string][] = [
      [`${PASSWORD}\n`, PASSWORD],
      [`${PASSWORD}${CR}\n`, PASSWORD],
      [PASSWORD, PASSWORD],
      [`${PASSWORD}\n\n`, `${PASSWORD}\n`],
      [`  ${PASSWORD} \n`, `  ${PASSWORD} `],
    ];
    for (const [fed, expected] of cases) {
      const creds = await resolveCredentials(
        input(root, {
          email: EMAIL,
          passwordStdin: true,
          stdin: Readable.from([fed.slice(0, 4), fed.slice(4)]),
        }),
      );
      assert.deepEqual(creds, { email: EMAIL, password: expected, source: 'flags' });
    }
    assert.equal(await readPasswordStdin(Readable.from(['a\n', 'b\n'])), 'a\nb');
  } finally {
    rmSync(root.root, { recursive: true, force: true });
  }
});

test('flags: --password-stdin without --email is a usage error; an empty stdin too', async () => {
  const root = tempRoot();
  try {
    await rejectsWith(
      resolveCredentials(
        input(root, { passwordStdin: true, stdin: Readable.from([`${PASSWORD}\n`]) }),
      ),
      EXIT_CODES.usage,
      (err) => assert.match(err.message, /--email/),
    );
    await rejectsWith(
      resolveCredentials(
        input(root, { email: EMAIL, passwordStdin: true, stdin: Readable.from(['\n']) }),
      ),
      EXIT_CODES.usage,
      (err) => assert.match(err.message, /empty/),
    );
  } finally {
    rmSync(root.root, { recursive: true, force: true });
  }
});

test('file: credentials.json is the third source; corrupt or partial files are "absent"', async () => {
  const root = tempRoot();
  try {
    ensureDirs(root.paths);
    writeCredentialsFile(root.paths, { email: FILE_EMAIL, password: FILE_PASSWORD });
    const { stdin, touched } = untouchedStdin();
    const creds = await resolveCredentials(input(root, { stdin, canPrompt: true }));
    assert.deepEqual(creds, { email: FILE_EMAIL, password: FILE_PASSWORD, source: 'file' });
    assert.equal(touched(), false);

    writeFileSync(root.paths.credentialsFile, '{not json');
    assert.equal(readCredentialsFile(root.paths), null);
    writeFileSync(root.paths.credentialsFile, JSON.stringify({ email: FILE_EMAIL }));
    assert.equal(readCredentialsFile(root.paths), null);
    writeFileSync(root.paths.credentialsFile, JSON.stringify({ email: '', password: 'x' }));
    assert.equal(readCredentialsFile(root.paths), null);
    await rejectsWith(resolveCredentials(input(root)), EXIT_CODES.auth_required);
  } finally {
    rmSync(root.root, { recursive: true, force: true });
  }
});

test('file: writeCredentialsFile is atomic, 0600, and the only writer', async () => {
  const root = tempRoot();
  try {
    writeCredentialsFile(root.paths, { email: FILE_EMAIL, password: FILE_PASSWORD });
    assert.equal(statSync(root.paths.credentialsFile).mode & 0o777, 0o600);
    assert.deepEqual(JSON.parse(readFileSync(root.paths.credentialsFile, 'utf8')), {
      email: FILE_EMAIL,
      password: FILE_PASSWORD,
    });
    assert.deepEqual(readCredentialsFile(root.paths), {
      email: FILE_EMAIL,
      password: FILE_PASSWORD,
    });
    // Resolving from env or a prompt never writes the file on its own.
    rmSync(root.paths.credentialsFile);
    await resolveCredentials(input(root, { env: { BS_EMAIL: EMAIL, BS_PASSWORD: PASSWORD } }));
    assert.equal(existsSync(root.paths.credentialsFile), false);
    await resolveCredentials(
      input(root, { canPrompt: true, stdin: promptStdin([`${EMAIL}\n`, `${PASSWORD}\n`]) }),
    );
    assert.equal(existsSync(root.paths.credentialsFile), false);
  } finally {
    rmSync(root.root, { recursive: true, force: true });
  }
});

test('prompt: a TTY is asked on stderr, email then a masked password; the password is never echoed', async () => {
  const root = tempRoot();
  try {
    const stderr = new Sink();
    const creds = await resolveCredentials(
      input(root, {
        canPrompt: true,
        stdin: promptStdin([`  ${EMAIL} \n`, `${PASSWORD}${CR}`]),
        stderr,
      }),
    );
    assert.deepEqual(creds, { email: EMAIL, password: PASSWORD, source: 'prompt' });
    assert.match(stderr.text, /email/i);
    assert.match(stderr.text, /password/i);
    assert.equal(stderr.text.includes(PASSWORD), false, 'never echoed');
    assert.equal(stderr.text.includes(EMAIL), false, 'the fake stdin does not echo either');
  } finally {
    rmSync(root.root, { recursive: true, force: true });
  }
});

test('prompt: backspace edits the masked password; ctrl-c cancels (exit 130)', async () => {
  const root = tempRoot();
  try {
    const creds = await resolveCredentials(
      input(root, {
        canPrompt: true,
        stdin: promptStdin([`${EMAIL}\n`, `abcd${BACKSPACE}${BACKSPACE}xy\n`]),
      }),
    );
    assert.equal(creds.password, 'abxy');
    await rejectsWith(
      resolveCredentials(
        input(root, { canPrompt: true, stdin: promptStdin([`${EMAIL}\n`, `ab${CTRL_C}`]) }),
      ),
      EXIT_CODES.cancelled,
    );
  } finally {
    rmSync(root.root, { recursive: true, force: true });
  }
});

test('prompt: --email alone skips credentials.json and asks only for the password', async () => {
  const root = tempRoot();
  try {
    ensureDirs(root.paths);
    writeCredentialsFile(root.paths, { email: FILE_EMAIL, password: FILE_PASSWORD });
    const stderr = new Sink();
    const creds = await resolveCredentials(
      input(root, {
        email: EMAIL,
        canPrompt: true,
        stdin: promptStdin([`${PASSWORD}\n`]),
        stderr,
      }),
    );
    assert.deepEqual(creds, { email: EMAIL, password: PASSWORD, source: 'prompt' });
    assert.doesNotMatch(stderr.text, /email:/i);
    assert.match(stderr.text, /password/i);
  } finally {
    rmSync(root.root, { recursive: true, force: true });
  }
});

test('prompt: an empty email or password is exit 4; stdin ending early is a cancellation', async () => {
  const root = tempRoot();
  try {
    await rejectsWith(
      resolveCredentials(input(root, { canPrompt: true, stdin: promptStdin(['\n', 'x\n']) })),
      EXIT_CODES.auth_required,
    );
    await rejectsWith(
      resolveCredentials(
        input(root, { canPrompt: true, stdin: promptStdin([`${EMAIL}\n`, '\n']) }),
      ),
      EXIT_CODES.auth_required,
    );
    await rejectsWith(
      resolveCredentials(input(root, { canPrompt: true, stdin: promptStdin([]) })),
      EXIT_CODES.cancelled,
    );
    await rejectsWith(
      resolveCredentials(input(root, { canPrompt: true, stdin: promptStdin([`${EMAIL}\n`]) })),
      EXIT_CODES.cancelled,
    );
  } finally {
    rmSync(root.root, { recursive: true, force: true });
  }
});

test('non-interactive with no credentials: exit 4 at once, stdin untouched, hint names the sources', async () => {
  const root = tempRoot();
  try {
    const { stdin, touched } = untouchedStdin();
    const stderr = new Sink();
    const err = await rejectsWith(
      resolveCredentials(input(root, { stdin, stderr, canPrompt: false })),
      EXIT_CODES.auth_required,
    );
    assert.equal(err.hint, HINT_CREDENTIALS);
    assert.match(err.hint ?? '', /BS_EMAIL/);
    assert.match(err.hint ?? '', /BS_PASSWORD/);
    assert.match(err.hint ?? '', /--password-stdin/);
    assert.equal(touched(), false);
    assert.equal(stderr.text, '', 'no prompt was written');
    // --email without a password source is the same story.
    await rejectsWith(
      resolveCredentials(input(root, { email: EMAIL, canPrompt: false })),
      EXIT_CODES.auth_required,
    );
  } finally {
    rmSync(root.root, { recursive: true, force: true });
  }
});
