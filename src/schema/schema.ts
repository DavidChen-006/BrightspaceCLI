/**
 * `bs schema --json` (PRD 10.1): a walk of the live commander tree.
 */
import type { Argument, Command, Option } from 'commander';
import { type FlagType, flagType } from '../cli/options.js';
import { EXIT_CODES, UsageError } from '../core/errors.js';

export const SCHEMA_VERSION = 1;

export interface SchemaFlag {
  name: string;
  short: string | null;
  help: string;
  type: FlagType;
  required: boolean;
  default: unknown;
  enum: string[];
  env: string | null;
  hidden: boolean;
  negated: boolean;
}

export interface SchemaArg {
  name: string;
  help: string;
  required: boolean;
  variadic: boolean;
  enum: string[];
  default: unknown;
}

export interface SchemaNode {
  name: string;
  aliases: string[];
  help: string;
  path: string;
  usage: string;
  hidden: boolean;
  flags: SchemaFlag[];
  positionals: SchemaArg[];
  subcommands: SchemaNode[];
}

export interface SchemaSafety {
  readonly: boolean;
  no_input: boolean;
  wrap_untrusted: boolean;
}

export interface SchemaDoc {
  schema_version: number;
  build: string;
  automation: {
    output_formats: string[];
    exit_codes: Record<string, number>;
    safety: SchemaSafety;
  };
  command: SchemaNode;
}

export interface BuildSchemaOptions {
  /** Command path to narrow to, e.g. ["courses", "list"]. */
  path?: readonly string[];
  includeHidden?: boolean;
  build: string;
  safety: SchemaSafety;
}

function isHidden(cmd: Command): boolean {
  return Boolean((cmd as unknown as { _hidden?: boolean })._hidden);
}

function commandPath(cmd: Command): string {
  const parts: string[] = [];
  for (let c: Command | null = cmd; c; c = c.parent) parts.unshift(c.name());
  return parts.join(' ');
}

function flagNode(option: Option): SchemaFlag {
  const name = option.long?.replace(/^--/, '') ?? option.short?.replace(/^-/, '') ?? '';
  const type = flagType(option);
  const negated = Boolean(option.negate);
  let def: unknown = option.defaultValue ?? null;
  if (type === 'bool' && def === null) def = false;
  return {
    name,
    short: option.short ? option.short.replace(/^-/, '') : null,
    help: option.description,
    type,
    required: Boolean(option.mandatory),
    default: def,
    enum: option.argChoices ? [...option.argChoices] : [],
    env: option.envVar ?? null,
    hidden: Boolean(option.hidden),
    negated,
  };
}

function argNode(arg: Argument): SchemaArg {
  return {
    name: arg.name(),
    help: arg.description,
    required: arg.required,
    variadic: arg.variadic,
    enum: arg.argChoices ? [...arg.argChoices] : [],
    default: arg.defaultValue ?? null,
  };
}

function byName<T extends { name: string }>(a: T, b: T): number {
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}

export function commandNode(cmd: Command, includeHidden: boolean): SchemaNode {
  return {
    name: cmd.name(),
    aliases: [...cmd.aliases()],
    help: cmd.description(),
    path: commandPath(cmd),
    usage: cmd.usage(),
    hidden: isHidden(cmd),
    flags: cmd.options
      .filter((o) => includeHidden || !o.hidden)
      .map(flagNode)
      .sort(byName),
    positionals: cmd.registeredArguments.map(argNode),
    subcommands: cmd.commands
      .filter((c) => includeHidden || !isHidden(c))
      .map((c) => commandNode(c, includeHidden))
      .sort(byName),
  };
}

function findChild(cmd: Command, name: string): Command | undefined {
  return cmd.commands.find((c) => c.name() === name || c.aliases().includes(name));
}

export function buildSchema(program: Command, options: BuildSchemaOptions): SchemaDoc {
  let target = program;
  for (const segment of options.path ?? []) {
    const child = findChild(target, segment);
    if (!child) {
      throw new UsageError(`unknown command path: ${[...(options.path ?? [])].join(' ')}`, {
        hint: `Run: ${commandPath(target)} --help  (or: bs schema --json to list commands)`,
      });
    }
    target = child;
  }
  return {
    schema_version: SCHEMA_VERSION,
    build: options.build,
    automation: {
      output_formats: ['json', 'plain'],
      exit_codes: { ...EXIT_CODES },
      safety: { ...options.safety },
    },
    command: commandNode(target, Boolean(options.includeHidden)),
  };
}
