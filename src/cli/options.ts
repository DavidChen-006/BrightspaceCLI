/**
 * Global flags (PRD 6.1) and the small type registry the schema generator reads.
 */
import { type Command, InvalidArgumentError, Option } from 'commander';
import { COLOR_MODES } from '../core/output.js';

export type FlagType = 'bool' | 'string' | 'number' | 'list';

const FLAG_TYPES = new WeakMap<Option, FlagType>();

/** Records the value type of a non-boolean option for `bs schema`. */
export function typed(option: Option, type: FlagType): Option {
  FLAG_TYPES.set(option, type);
  return option;
}

export function flagType(option: Option): FlagType {
  return FLAG_TYPES.get(option) ?? (option.isBoolean() || option.negate ? 'bool' : 'string');
}

export function parseTimeout(value: string): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) {
    throw new InvalidArgumentError('expected a positive number of seconds.');
  }
  return n;
}

/** `--limit <n>` and friends: a positive integer or a usage error. */
export function parsePositiveInt(value: string): number {
  if (!/^\d+$/.test(value.trim()) || Number(value) <= 0) {
    throw new InvalidArgumentError('expected a positive integer.');
  }
  return Number(value);
}

export function parseSelect(value: string): string[] {
  const paths = value
    .split(',')
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  if (paths.length === 0) {
    throw new InvalidArgumentError('expected comma-separated dot paths, e.g. id,title,due.date');
  }
  return paths;
}

export function addGlobalOptions(program: Command): Command {
  program
    .addOption(
      new Option('--json', 'JSON on stdout (2-space indent, no HTML escaping)').env('BS_JSON'),
    )
    .addOption(
      new Option(
        '--plain',
        'TSV on stdout with a header row; cells escape tab, newline and backslash',
      ).env('BS_PLAIN'),
    )
    .addOption(new Option('--results-only', 'unwrap list envelopes to the items (needs --json)'))
    .addOption(
      typed(
        new Option(
          '--select <paths>',
          'project fields by comma-separated dot paths, per item for lists (needs --json)',
        ).argParser(parseSelect),
        'list',
      ),
    )
    .addOption(
      new Option(
        '--wrap-untrusted',
        'wrap fetched free text in EXTERNAL_UNTRUSTED_CONTENT markers',
      ).env('BS_WRAP_UNTRUSTED'),
    )
    .addOption(
      new Option('--no-input', 'never prompt (implied when stdin is not a TTY)').env('BS_NO_INPUT'),
    )
    .addOption(
      new Option('--readonly', 'accepted for forward compatibility; v1 is always read-only').env(
        'BS_READONLY',
      ),
    )
    .addOption(
      new Option('--color <mode>', 'color output; always overrides NO_COLOR')
        .choices([...COLOR_MODES])
        .default('auto')
        .env('BS_COLOR'),
    )
    .addOption(
      typed(
        new Option(
          '--base-url <url>',
          'tenant base URL (default https://purdue.brightspace.com)',
        ).env('BS_BASE_URL'),
        'string',
      ),
    )
    .addOption(
      typed(
        new Option('--root <dir>', 'directory for all state (session, profile, cache)').env(
          'BS_ROOT',
        ),
        'string',
      ),
    )
    .addOption(
      typed(
        new Option('--timeout <s>', 'seconds to first response byte per request')
          .argParser(parseTimeout)
          .default(30)
          .env('BS_TIMEOUT'),
        'number',
      ),
    )
    .addOption(new Option('--verbose', 'diagnostics on stderr (never secrets)').env('BS_VERBOSE'))
    .addOption(
      new Option(
        '--fail-empty',
        'exit 3 when a list command returns nothing (output still written)',
      ),
    );
  return program;
}
