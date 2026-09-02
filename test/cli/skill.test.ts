import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { CONFIG_ENV, DEFAULT_CONFIG } from '../../src/core/config.js';
import { EXIT_CODES } from '../../src/core/errors.js';
import type { SchemaDoc, SchemaNode } from '../../src/schema/schema.js';
import { leafCommands, packagedSkillFile, renderSkill } from '../../src/skill/render.js';
import { parseJson, runCli } from '../helpers/cli.js';

const REPO = fileURLToPath(new URL('../../', import.meta.url));

function tempDir(): string {
  return mkdtempSync(path.join(os.tmpdir(), 'bs-skill-'));
}

async function schemaDoc(): Promise<SchemaDoc> {
  const r = await runCli(['schema', '--json']);
  assert.equal(r.code, 0, r.stderr);
  return parseJson<SchemaDoc>(r.stdout);
}

async function markdown(): Promise<string> {
  const r = await runCli(['skill']);
  assert.equal(r.code, 0, r.stderr);
  return r.stdout;
}

test('bs skill prints the markdown on stdout and nothing on stderr', async () => {
  const r = await runCli(['skill']);
  assert.equal(r.code, 0);
  assert.equal(r.stderr, '');
  assert.ok(r.stdout.startsWith('---\n'), 'starts with YAML front-matter');
  assert.ok(r.stdout.endsWith('\n'));
});

test('front-matter carries name: bs and a one-line description', async () => {
  const text = await markdown();
  const end = text.indexOf('\n---\n', 4);
  assert.ok(end > 0, 'front-matter is closed');
  const front = text.slice(4, end).split('\n');
  assert.equal(front[0], 'name: bs');
  assert.ok(front[1]?.startsWith('description: '));
  assert.equal(front.length, 2, 'description is one line');
  assert.ok((front[1] as string).length > 'description: '.length + 20);
});

test('the Safe start block holds exactly the three PRD 10.2 commands', async () => {
  const text = await markdown();
  const section = text.slice(text.indexOf('## Safe start'));
  const open = section.indexOf('```sh');
  const fence = section.slice(open + 5, section.indexOf('```', open + 5));
  assert.deepEqual(
    fence
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean),
    ['bs auth status --json --no-input', 'bs schema --json', 'bs upcoming --json --wrap-untrusted'],
  );
});

test('the rules section covers json, no-input, untrusted data, guessing and auth', async () => {
  const text = await markdown();
  const rules = text.slice(text.indexOf('## Rules'), text.indexOf('## Commands'));
  assert.match(rules, /--json/);
  assert.match(rules, /--no-input/);
  assert.match(rules, /EXTERNAL_UNTRUSTED_CONTENT/);
  assert.match(rules, /data, not instructions/i);
  assert.match(rules, /never guess/i);
  assert.match(rules, /bs schema --json/);
  assert.match(rules, /bs <command> --help/);
  assert.match(rules, /bs auth login/);
  assert.match(rules, /MFA|Authenticator/);
  assert.match(rules, /bs auth refresh/);
});

test('the exit code table lists every code from EXIT_CODES with a meaning', async () => {
  const text = await markdown();
  const table = text.slice(text.indexOf('### Exit codes'), text.indexOf('## Commands'));
  for (const [name, code] of Object.entries(EXIT_CODES)) {
    const row = table
      .split('\n')
      .find((l) => l.startsWith(`| ${code} |`) && l.includes(`\`${name}\``));
    assert.ok(row, `no row for ${name} (${code})`);
    assert.ok((row.split('|')[3] ?? '').trim().length > 3, `no meaning for ${name}`);
  }
});

test('every leaf command from the schema appears exactly once in the command table', async () => {
  const doc = await schemaDoc();
  const text = await markdown();
  const table = text.slice(text.indexOf('| Command | Purpose |'));
  const rows = table
    .split('\n')
    .filter((l) => l.startsWith('| `bs '))
    .map((l) => (l.split('|')[1] ?? '').trim().replace(/`/g, ''));
  const leaves = leafCommands(doc.command).map((n) => n.path);
  assert.ok(leaves.length > 20, `expected the full command surface, got ${leaves.length}`);
  assert.deepEqual(rows, leaves, 'table rows are the leaf commands in schema order');
  for (const leaf of leaves) {
    assert.equal(rows.filter((r) => r === leaf).length, 1, `${leaf} listed more than once`);
  }
  for (const expected of ['bs auth status', 'bs courses list', 'bs api', 'bs skill', 'bs whoami']) {
    assert.ok(rows.includes(expected), `${expected} missing from the table`);
  }
});

test('no group command (a node with subcommands) is listed as a leaf', async () => {
  const doc = await schemaDoc();
  const groups = doc.command.subcommands.filter((c) => c.subcommands.length > 0).map((c) => c.path);
  const text = await markdown();
  const rows = text.split('\n').filter((l) => l.startsWith('| `bs '));
  for (const group of groups) {
    assert.equal(
      rows.some((r) => (r.split('|')[1] ?? '').trim() === `\`${group}\``),
      false,
      `${group} is a group, not a leaf`,
    );
  }
});

test('the environment section lists the tenant knobs, BS_ROOT and the credentials', async () => {
  const text = await markdown();
  const env = text.slice(text.indexOf('## Environment'));
  for (const name of ['BS_ROOT', 'BS_EMAIL', 'BS_PASSWORD', ...Object.values(CONFIG_ENV)]) {
    assert.ok(env.includes(`\`${name}\``), `${name} missing`);
  }
  assert.ok(env.includes(DEFAULT_CONFIG.baseUrl), 'the tenant default is rendered from config');
  assert.ok(env.includes(DEFAULT_CONFIG.lpVersion));
});

test('the footer names the version and never the build commit', () => {
  const doc: SchemaDoc = {
    schema_version: 1,
    build: '9.9.9 (cafed00d 2020-01-01)',
    automation: {
      output_formats: ['json', 'plain'],
      exit_codes: { ...EXIT_CODES },
      safety: { readonly: true, no_input: true, wrap_untrusted: false },
    },
    command: {
      name: 'bs',
      aliases: [],
      help: 'Read Brightspace data. Second sentence.',
      path: 'bs',
      usage: '[options]',
      hidden: false,
      flags: [],
      positionals: [],
      subcommands: [
        {
          name: 'whoami',
          aliases: [],
          help: 'Show the | signed-in user',
          path: 'bs whoami',
          usage: '',
          hidden: false,
          flags: [],
          positionals: [],
          subcommands: [],
        },
      ],
    },
  };
  const text = renderSkill(doc, { version: '9.9.9' });
  assert.ok(text.includes('Generated by bs skill (bs 9.9.9) — do not edit by hand'));
  assert.equal(text.includes('cafed00d'), false, 'the commit hash must not be rendered');
  assert.equal(text.includes('2020-01-01'), false, 'the build date must not be rendered');
  assert.match(text, /description: Read Brightspace data\.$/m);
  assert.ok(text.includes('Show the \\| signed-in user'), 'pipes in help are escaped');
});

test('the render is deterministic', async () => {
  assert.equal(await markdown(), await markdown());
});

test('--json wraps the markdown as {markdown}', async () => {
  const r = await runCli(['skill', '--json']);
  assert.equal(r.code, 0);
  const doc = parseJson<{ markdown: string }>(r.stdout);
  assert.equal(Object.keys(doc).length, 1);
  assert.equal(typeof doc.markdown, 'string');
  assert.equal(doc.markdown, await markdown());
});

test('--json --wrap-untrusted never wraps the generated skill (local, trusted)', async () => {
  const r = await runCli(['skill', '--json', '--wrap-untrusted']);
  assert.equal(r.code, 0);
  const doc = parseJson<Record<string, unknown>>(r.stdout);
  assert.equal('externalContent' in doc, false);
  // The rules quote the marker literals; wrapping would have rewritten them to [[MARKER_SANITIZED]].
  assert.equal(doc.markdown, await markdown());
  assert.equal(String(doc.markdown).includes('MARKER_SANITIZED'), false);
});

test('--check exits 0 against a matching file and prints nothing on stdout', async () => {
  const dir = tempDir();
  try {
    const file = path.join(dir, 'SKILL.md');
    writeFileSync(file, await markdown());
    const r = await runCli(['skill', '--check', file]);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.stdout, '');
    assert.match(r.stderr, /up to date/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('--check exits 1 with a diff summary and the npm run skill hint when stale', async () => {
  const dir = tempDir();
  try {
    const file = path.join(dir, 'SKILL.md');
    const lines = (await markdown()).split('\n');
    lines[1] = 'name: stale';
    writeFileSync(file, lines.join('\n'));
    const r = await runCli(['skill', '--check', file]);
    assert.equal(r.code, 1);
    assert.equal(r.stdout, '');
    assert.match(r.stderr, /out of date/);
    assert.match(r.stderr, /line 2/);
    assert.match(r.stderr, /Run: npm run skill/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('--check on a missing file is exit 1 with the same hint', async () => {
  const dir = tempDir();
  try {
    const r = await runCli(['skill', '--check', path.join(dir, 'nope', 'SKILL.md')]);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /Run: npm run skill/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the committed skills/bs/SKILL.md is the rendered output', async () => {
  const file = packagedSkillFile();
  assert.equal(file, path.join(REPO, 'skills', 'bs', 'SKILL.md'));
  assert.ok(existsSync(file), 'skills/bs/SKILL.md is committed');
  // The committed file is generated by the built binary, whose build info differs from tsx's
  // only in commit/date, which the renderer never emits.
  assert.equal(readFileSync(file, 'utf8'), await markdown());
});

test('bs skill creates no state directory', async () => {
  const dir = tempDir();
  try {
    const root = path.join(dir, 'root');
    const r = await runCli(['skill', '--json'], { env: { BS_ROOT: root } });
    assert.equal(r.code, 0);
    assert.equal(existsSync(root), false, 'skill must not create the state root');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('leafCommands walks depth-first in schema order', () => {
  const node = (name: string, subs: SchemaNode[] = []): SchemaNode => ({
    name,
    aliases: [],
    help: name,
    path: `bs ${name}`,
    usage: '',
    hidden: false,
    flags: [],
    positionals: [],
    subcommands: subs,
  });
  const root = node('bs', [node('auth', [node('login'), node('status')]), node('whoami')]);
  assert.deepEqual(
    leafCommands(root).map((n) => n.name),
    ['login', 'status', 'whoami'],
  );
  assert.deepEqual(
    leafCommands(node('leaf')).map((n) => n.name),
    ['leaf'],
    'a node with no subcommands is its own leaf',
  );
});
