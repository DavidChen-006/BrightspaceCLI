import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { EXIT_CODES } from '../../src/core/errors.js';
import { parseJson, runCli } from '../helpers/cli.js';

const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as {
  version: string;
};

interface VersionJson {
  version: string;
  commit: string;
  date: string;
}

interface SchemaFlag {
  name: string;
  short: string | null;
  help: string;
  type: string;
  required: boolean;
  default: unknown;
  enum: string[];
  env: string | null;
  hidden: boolean;
  negated: boolean;
}

interface SchemaNode {
  name: string;
  aliases: string[];
  help: string;
  path: string;
  usage: string;
  hidden: boolean;
  flags: SchemaFlag[];
  positionals: {
    name: string;
    help: string;
    required: boolean;
    variadic: boolean;
    enum: string[];
    default: unknown;
  }[];
  subcommands: SchemaNode[];
}

interface SchemaDoc {
  schema_version: number;
  build: string;
  automation: {
    output_formats: string[];
    exit_codes: Record<string, number>;
    safety: { readonly: boolean; no_input: boolean; wrap_untrusted: boolean };
  };
  command: SchemaNode;
}

test('version --json emits {version, commit, date} and nothing on stderr', async () => {
  const r = await runCli(['version', '--json']);
  assert.equal(r.code, 0);
  assert.equal(r.stderr, '');
  const v = parseJson<VersionJson>(r.stdout);
  assert.deepEqual(Object.keys(v).sort(), ['commit', 'date', 'version']);
  assert.equal(v.version, pkg.version);
  assert.equal(typeof v.commit, 'string');
  assert.equal(typeof v.date, 'string');
});

test('global flags work before the subcommand too', async () => {
  const r = await runCli(['--json', 'version']);
  assert.equal(r.code, 0);
  assert.equal(parseJson<VersionJson>(r.stdout).version, pkg.version);
});

test('version (human) prints one line to stdout', async () => {
  const r = await runCli(['version']);
  assert.equal(r.code, 0);
  assert.match(r.stdout, new RegExp(`^bs ${pkg.version.replace(/\./g, '\\.')} \\(`));
  assert.equal(r.stdout.split('\n').filter(Boolean).length, 1);
});

test('version --plain emits TSV with a header row', async () => {
  const r = await runCli(['version', '--plain']);
  assert.equal(r.code, 0);
  const [header, row, rest] = r.stdout.split('\n');
  assert.equal(header, 'version\tcommit\tdate');
  assert.equal(row?.split('\t')[0], pkg.version);
  assert.equal(rest, '');
});

test('--json with --plain is a usage error (exit 2) on stderr only', async () => {
  const r = await runCli(['version', '--json', '--plain']);
  assert.equal(r.code, 2);
  assert.equal(r.stdout, '');
  assert.match(r.stderr, /--json.*--plain|--plain.*--json/);
});

test('commander usage errors map to exit 2 and go to stderr', async () => {
  const unknownOpt = await runCli(['version', '--bogus']);
  assert.equal(unknownOpt.code, 2);
  assert.equal(unknownOpt.stdout, '');
  assert.match(unknownOpt.stderr, /unknown option '--bogus'/);

  const unknownCmd = await runCli(['nope']);
  assert.equal(unknownCmd.code, 2);
  assert.match(unknownCmd.stderr, /unknown command 'nope'/);

  const missingValue = await runCli(['version', '--select']);
  assert.equal(missingValue.code, 2);

  const badTimeout = await runCli(['version', '--timeout', 'soon']);
  assert.equal(badTimeout.code, 2);
  assert.match(badTimeout.stderr, /--timeout/);

  const badColor = await runCli(['version', '--color', 'sometimes']);
  assert.equal(badColor.code, 2);
  assert.match(badColor.stderr, /auto, always, never/);

  const excess = await runCli(['version', 'extra']);
  assert.equal(excess.code, 2);
});

test('--help goes to stdout with exit 0; bare invocation shows help on stderr with exit 2', async () => {
  const help = await runCli(['--help']);
  assert.equal(help.code, 0);
  assert.match(help.stdout, /^Usage: bs/);
  assert.match(help.stdout, /--wrap-untrusted/);
  assert.match(help.stdout, /BS_JSON/);
  assert.equal(help.stderr, '');

  const bare = await runCli([]);
  assert.equal(bare.code, 2);
  assert.equal(bare.stdout, '');
  assert.match(bare.stderr, /Usage: bs/);

  const sub = await runCli(['schema', '--help']);
  assert.equal(sub.code, 0);
  assert.match(sub.stdout, /Usage: bs schema/);
});

test('--version prints the package version', async () => {
  const r = await runCli(['--version']);
  assert.equal(r.code, 0);
  assert.equal(r.stdout.trim(), pkg.version);
});

test('--results-only and --select require --json', async () => {
  const ro = await runCli(['version', '--results-only']);
  assert.equal(ro.code, 2);
  assert.match(ro.stderr, /--results-only/);
  const sel = await runCli(['version', '--select', 'version']);
  assert.equal(sel.code, 2);
  const ok = await runCli(['version', '--json', '--select', 'version,commit']);
  assert.equal(ok.code, 0);
  assert.deepEqual(Object.keys(parseJson<object>(ok.stdout)), ['version', 'commit']);
});

test('BS_* env enables flags; a falsy value (0/false) does not', async () => {
  const on = await runCli(['version'], { env: { BS_JSON: '1' } });
  assert.equal(on.code, 0);
  assert.equal(parseJson<VersionJson>(on.stdout).version, pkg.version);

  const off = await runCli(['version'], { env: { BS_JSON: '0' } });
  assert.equal(off.code, 0);
  assert.match(off.stdout, /^bs /);

  const conflict = await runCli(['version', '--plain'], { env: { BS_JSON: 'true' } });
  assert.equal(conflict.code, 2);

  const timeout = await runCli(['version', '--json'], { env: { BS_TIMEOUT: 'nope' } });
  assert.equal(timeout.code, 2);
});

test('BS_AUTO_JSON switches to JSON only when stdout is not a TTY and no output flag was given', async () => {
  const piped = await runCli(['version'], { env: { BS_AUTO_JSON: '1' }, stdoutIsTTY: false });
  assert.equal(parseJson<VersionJson>(piped.stdout).version, pkg.version);
  const tty = await runCli(['version'], { env: { BS_AUTO_JSON: '1' }, stdoutIsTTY: true });
  assert.match(tty.stdout, /^bs /);
  const plain = await runCli(['version', '--plain'], {
    env: { BS_AUTO_JSON: '1' },
    stdoutIsTTY: false,
  });
  assert.match(plain.stdout, /^version\t/);
});

test('version output is never wrapped even with --wrap-untrusted', async () => {
  const r = await runCli(['version', '--json', '--wrap-untrusted']);
  assert.equal(r.code, 0);
  const v = parseJson<VersionJson & { externalContent?: unknown }>(r.stdout);
  assert.equal(v.externalContent, undefined);
  assert.equal(v.version, pkg.version);
});

test('schema --json has the PRD 10.1 shape', async () => {
  const r = await runCli(['schema', '--json']);
  assert.equal(r.code, 0);
  assert.equal(r.stderr, '');
  const doc = parseJson<SchemaDoc>(r.stdout);
  assert.equal(doc.schema_version, 1);
  assert.match(doc.build, new RegExp(`^${pkg.version.replace(/\./g, '\\.')} \\(.+ .+\\)$`));
  assert.deepEqual(doc.automation.output_formats, ['json', 'plain']);
  assert.deepEqual(doc.automation.exit_codes, EXIT_CODES);
  assert.deepEqual(doc.automation.safety, {
    readonly: true,
    no_input: true,
    wrap_untrusted: false,
  });
  assert.equal(doc.command.name, 'bs');
  assert.equal(doc.command.path, 'bs');
  assert.ok(doc.command.help.length > 0);
});

test('schema safety reflects the effective invocation', async () => {
  const r = await runCli(['schema', '--wrap-untrusted'], { stdinIsTTY: true });
  const doc = parseJson<SchemaDoc>(r.stdout);
  assert.deepEqual(doc.automation.safety, {
    readonly: true,
    no_input: false,
    wrap_untrusted: true,
  });
  assert.equal('externalContent' in doc, false, 'schema output is never wrapped');
  const noInput = await runCli(['schema', '--no-input'], { stdinIsTTY: true });
  assert.equal(parseJson<SchemaDoc>(noInput.stdout).automation.safety.no_input, true);
});

test('schema root flags cover PRD 6.1 with env names, enums and negation', async () => {
  const doc = parseJson<SchemaDoc>((await runCli(['schema'])).stdout);
  const flags = new Map(doc.command.flags.map((f) => [f.name, f]));
  const expected: Record<string, string | null> = {
    json: 'BS_JSON',
    plain: 'BS_PLAIN',
    'results-only': null,
    select: null,
    'wrap-untrusted': 'BS_WRAP_UNTRUSTED',
    'no-input': 'BS_NO_INPUT',
    readonly: 'BS_READONLY',
    color: 'BS_COLOR',
    'base-url': 'BS_BASE_URL',
    root: 'BS_ROOT',
    timeout: 'BS_TIMEOUT',
    verbose: 'BS_VERBOSE',
    'fail-empty': null,
  };
  for (const [name, env] of Object.entries(expected)) {
    const f = flags.get(name);
    assert.ok(f, `flag ${name} present`);
    assert.equal(f.env, env, `env for ${name}`);
    assert.equal(typeof f.help, 'string');
    assert.equal(f.required, false);
  }
  assert.deepEqual(flags.get('color')?.enum, ['auto', 'always', 'never']);
  assert.equal(flags.get('color')?.default, 'auto');
  assert.equal(flags.get('timeout')?.type, 'number');
  assert.equal(flags.get('timeout')?.default, 30);
  assert.equal(flags.get('select')?.type, 'list');
  assert.equal(flags.get('json')?.type, 'bool');
  assert.equal(flags.get('no-input')?.negated, true);
  assert.deepEqual(
    doc.command.flags.map((f) => f.name),
    [...doc.command.flags.map((f) => f.name)].sort(),
    'flags sorted by name',
  );
});

test('schema subcommands are sorted and include version and schema', async () => {
  const doc = parseJson<SchemaDoc>((await runCli(['schema', '--json'])).stdout);
  const names = doc.command.subcommands.map((c) => c.name);
  assert.deepEqual(names, [...names].sort());
  assert.ok(names.includes('version'));
  assert.ok(names.includes('schema'));

  const version = doc.command.subcommands.find((c) => c.name === 'version');
  assert.ok(version);
  assert.equal(version.path, 'bs version');
  assert.deepEqual(version.positionals, []);
  assert.deepEqual(version.subcommands, []);
  assert.deepEqual(version.flags, []);

  const schema = doc.command.subcommands.find((c) => c.name === 'schema');
  assert.ok(schema);
  assert.equal(schema.path, 'bs schema');
  assert.deepEqual(schema.positionals, [
    {
      name: 'cmd',
      help: schema.positionals[0]?.help,
      required: false,
      variadic: true,
      enum: [],
      default: null,
    },
  ]);
  assert.deepEqual(
    schema.flags.map((f) => [f.name, f.type, f.env]),
    [['include-hidden', 'bool', null]],
  );
});

test('schema narrows by command path and rejects unknown paths', async () => {
  const r = await runCli(['schema', 'version']);
  assert.equal(r.code, 0);
  const doc = parseJson<SchemaDoc>(r.stdout);
  assert.equal(doc.command.name, 'version');
  assert.equal(doc.command.path, 'bs version');

  const bad = await runCli(['schema', 'nope']);
  assert.equal(bad.code, 2);
  assert.equal(bad.stdout, '');
  assert.match(bad.stderr, /nope/);
});

test('schema is JSON only: rejects --plain, ignores --select/--results-only', async () => {
  const plain = await runCli(['schema', '--plain']);
  assert.equal(plain.code, 2);
  assert.equal(plain.stdout, '');
  assert.match(plain.stderr, /--plain/);

  const envPlain = await runCli(['schema'], { env: { BS_PLAIN: '1' } });
  assert.equal(envPlain.code, 2);

  const selected = await runCli(['schema', '--json', '--select', 'build', '--results-only']);
  assert.equal(selected.code, 0);
  const doc = parseJson<SchemaDoc>(selected.stdout);
  assert.equal(doc.schema_version, 1);
  assert.ok(doc.command);
});

test('help, version and schema never create the state directory', async () => {
  const base = mkdtempSync(path.join(os.tmpdir(), 'bs-cli-'));
  try {
    const root = path.join(base, 'state-root');
    const env = { BS_ROOT: root };
    for (const argv of [['--help'], ['version', '--json'], ['schema', '--json'], ['version']]) {
      const r = await runCli(argv, { env });
      assert.equal(r.code, 0, argv.join(' '));
      assert.equal(existsSync(root), false, `${argv.join(' ')} created ${root}`);
    }
    const flag = await runCli(['--root', root, 'schema']);
    assert.equal(flag.code, 0);
    assert.equal(existsSync(root), false);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
