/**
 * Tenant knobs (PRD 8.3): CLI overrides > BS_* env > config.json > defaults.
 *
 * config.json is optional and tolerant: missing, corrupt or non-object content is treated as
 * "no overrides" (with a warning to the caller's logger), never as an error.
 */
import { readFileSync } from 'node:fs';
import { ConfigError } from './errors.js';

export interface TenantConfig {
  /** Tenant base URL, no trailing slash. */
  baseUrl: string;
  /** Campus selector text on /d2l/login. */
  campusText: string;
  /** LP API version. */
  lpVersion: string;
  /** LE API version. */
  leVersion: string;
  /** Org unit type id for course offerings. */
  courseTypeId: number;
  /** playwright channel: 'chromium' (default) or 'chrome' for installed Google Chrome. */
  browserChannel: string;
  /** Courses in flight during fan-out. */
  concurrency: number;
}

export const DEFAULT_CONFIG: Readonly<TenantConfig> = Object.freeze({
  baseUrl: 'https://purdue.brightspace.com',
  campusText: 'Purdue West Lafayette',
  lpVersion: '1.62',
  leVersion: '1.96',
  courseTypeId: 3,
  browserChannel: 'chromium',
  concurrency: 4,
});

export const CONFIG_ENV: Readonly<Record<keyof TenantConfig, string>> = Object.freeze({
  baseUrl: 'BS_BASE_URL',
  campusText: 'BS_CAMPUS_TEXT',
  lpVersion: 'BS_LP_VERSION',
  leVersion: 'BS_LE_VERSION',
  courseTypeId: 'BS_COURSE_TYPE_ID',
  browserChannel: 'BS_BROWSER_CHANNEL',
  concurrency: 'BS_CONCURRENCY',
});

const CONFIG_KEYS = Object.keys(CONFIG_ENV) as (keyof TenantConfig)[];

export type ConfigWarn = (message: string) => void;

export interface LoadConfigInput {
  env?: NodeJS.ProcessEnv;
  /** Path to config.json; read only when `file` is not supplied. */
  configFile?: string;
  /** Already-parsed config.json content (tests, or a caller that read it itself). */
  file?: Partial<TenantConfig>;
  /** Highest precedence, e.g. --base-url. */
  overrides?: Partial<TenantConfig>;
  warn?: ConfigWarn;
}

/** Reads config.json; returns {} for a missing, unreadable, corrupt or non-object file. */
export function readConfigFile(file: string, warn: ConfigWarn = () => {}): Partial<TenantConfig> {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT' && code !== 'ENOTDIR') {
      warn(`config.json could not be read (${code ?? 'error'}); using defaults: ${file}`);
    }
    return {};
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    warn(`config.json is not valid JSON; ignoring it: ${file}`);
    return {};
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    warn(`config.json must contain a JSON object; ignoring it: ${file}`);
    return {};
  }
  const out: Partial<TenantConfig> = {};
  const record = parsed as Record<string, unknown>;
  for (const key of CONFIG_KEYS) {
    if (record[key] !== undefined && record[key] !== null) {
      (out as Record<string, unknown>)[key] = record[key];
    }
  }
  return out;
}

function asString(key: keyof TenantConfig, value: unknown, origin: string): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return String(value);
  throw new ConfigError(`${origin} must be a string (got ${typeof value})`, {
    hint: `Fix ${origin} in your environment or config.json (key "${key}").`,
  });
}

function asPositiveInt(key: keyof TenantConfig, value: unknown, origin: string): number {
  const n =
    typeof value === 'number'
      ? value
      : Number(typeof value === 'string' ? value.trim() : Number.NaN);
  if (!Number.isInteger(n) || n <= 0) {
    throw new ConfigError(`${origin} must be a positive integer (got ${JSON.stringify(value)})`, {
      hint: `Fix ${origin} in your environment or config.json (key "${key}").`,
    });
  }
  return n;
}

function normalizeBaseUrl(value: string, origin: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ConfigError(`${origin} is not a valid URL: ${JSON.stringify(value)}`, {
      hint: 'Use a full origin such as https://purdue.brightspace.com',
    });
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new ConfigError(`${origin} must use http(s): ${JSON.stringify(value)}`, {
      hint: 'Use a full origin such as https://purdue.brightspace.com',
    });
  }
  return value.replace(/\/+$/, '');
}

/** Resolves the effective tenant config. Throws ConfigError (exit 10) on invalid values. */
export function loadConfig(input: LoadConfigInput = {}): TenantConfig {
  const env = input.env ?? process.env;
  const warn = input.warn ?? (() => {});
  const file =
    input.file ??
    (input.configFile ? readConfigFile(input.configFile, warn) : ({} as Partial<TenantConfig>));
  const overrides = input.overrides ?? {};

  const pick = (key: keyof TenantConfig): { value: unknown; origin: string } => {
    if (overrides[key] !== undefined) return { value: overrides[key], origin: `--${kebab(key)}` };
    const envName = CONFIG_ENV[key];
    const fromEnv = env[envName];
    if (fromEnv !== undefined && fromEnv !== '') return { value: fromEnv, origin: envName };
    if (file[key] !== undefined) return { value: file[key], origin: `config.json "${key}"` };
    return { value: DEFAULT_CONFIG[key], origin: 'default' };
  };

  const baseUrl = pick('baseUrl');
  const campusText = pick('campusText');
  const lpVersion = pick('lpVersion');
  const leVersion = pick('leVersion');
  const courseTypeId = pick('courseTypeId');
  const browserChannel = pick('browserChannel');
  const concurrency = pick('concurrency');

  return {
    baseUrl: normalizeBaseUrl(asString('baseUrl', baseUrl.value, baseUrl.origin), baseUrl.origin),
    campusText: asString('campusText', campusText.value, campusText.origin),
    lpVersion: asString('lpVersion', lpVersion.value, lpVersion.origin),
    leVersion: asString('leVersion', leVersion.value, leVersion.origin),
    courseTypeId: asPositiveInt('courseTypeId', courseTypeId.value, courseTypeId.origin),
    browserChannel: asString('browserChannel', browserChannel.value, browserChannel.origin),
    concurrency: asPositiveInt('concurrency', concurrency.value, concurrency.origin),
  };
}

function kebab(key: string): string {
  return key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
}
