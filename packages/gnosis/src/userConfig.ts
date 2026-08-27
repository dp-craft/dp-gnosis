import { readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';

/**
 * The OPTIONAL user configuration file, `config.json`, read from the config home
 * `env.ts:configHome()` resolves. JSON, not YAML, deliberately: `JSON.parse` is
 * in the runtime, and a configuration file is not worth a parser dependency.
 *
 * Two rules govern every read here, and they pull in opposite directions on
 * purpose. An ABSENT file is not an error — a user who never wrote one gets the
 * built-in defaults, which is the common case. A file that EXISTS but cannot be
 * understood REFUSES, naming the path: the alternative is to ignore what the
 * user wrote and resolve a plausible path they never asked for, which is exactly
 * the silent-wrong-location failure this project polices. A refusal names the
 * file so the user can find it; a fallback would name nothing.
 *
 * A relative `dataRoot` is refused rather than resolved against `process.cwd()`,
 * matching `env.ts:requireAbsolute` — a root that moves with the caller's shell
 * is a different vault per terminal.
 *
 * Every refusal here is TAGGED (`isUserConfigError`) so the CLI can render it as
 * the usage failure it is — exit 2, one line naming the file and the correction —
 * instead of letting a stack trace and a `dist/` path reach the user.
 *
 * The read is MEMOISED per config directory. A path lookup is a default
 * parameter on a dozen exported functions, so an unmemoised read would put a
 * `readFileSync` behind every single one. The cache is lazy and keyed by
 * directory, never a module-level eager constant: that would freeze the layout
 * at import time, which is the defect `paths.ts` exists to avoid.
 */

/** The one file name gnosis reads out of its config home. */
export const USER_CONFIG_FILE = 'config.json';

/** What a `config.json` may declare. Only the keys with a reader live here. */
export interface UserConfig {
  /** Absolute root the vault and cache trees hang off, in place of the default. */
  readonly dataRoot?: string | undefined;
}

export const userConfigPath = (configDir: string): string => join(configDir, USER_CONFIG_FILE);

/** Marks a refusal that MUST be rendered as a usage failure, not a crash. */
const USER_CONFIG_ERROR = 'GnosisUserConfigError';

/** Explicitly typed so a bare `refuse(...)` statement narrows the code after it. */
const refuse: (message: string) => never = message => {
  throw Object.assign(new Error(message), { name: USER_CONFIG_ERROR });
};

/** True for a refusal raised by this module — the CLI renders those as exit 2. */
export const isUserConfigError = (error: unknown): error is Error =>
  error instanceof Error && error.name === USER_CONFIG_ERROR;

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const isNotFound = (error: unknown): boolean =>
  error instanceof Error && 'code' in error && error.code === 'ENOENT';

/** `undefined` means the file is absent — every other read failure refuses. */
const readIfPresent = (path: string): string | undefined => {
  try {
    return readFileSync(path, 'utf8');
  } catch (error) {
    if (isNotFound(error)) return undefined;
    return refuse(`gnosis config ${path} could not be read: ${messageOf(error)} — fix or remove the file`);
  }
};

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const parseObject = (path: string, text: string): Readonly<Record<string, unknown>> => {
  const parsed: unknown = tryParse(path, text);
  if (!isRecord(parsed)) refuse(`gnosis config ${path} must contain a JSON object, e.g. {"dataRoot": "/absolute/path"}`);
  return parsed;
};

const tryParse = (path: string, text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch (error) {
    return refuse(`gnosis config ${path} is not valid JSON: ${messageOf(error)}`);
  }
};

const readDataRoot = (path: string, raw: Readonly<Record<string, unknown>>): string | undefined => {
  const value = raw['dataRoot'];
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.trim() === '') {
    refuse(`dataRoot in gnosis config ${path} must be a non-empty string naming an absolute directory`);
  }
  return requireAbsoluteRoot(path, value.trim());
};

const requireAbsoluteRoot = (path: string, value: string): string => {
  if (isAbsolute(value)) return value;
  return refuse(
    `dataRoot in gnosis config ${path} must be an absolute path (it is used as a directory base), got "${value}"`
  );
};

const readUserConfig = (configDir: string): UserConfig => {
  const path = userConfigPath(configDir);
  const text = readIfPresent(path);
  if (text === undefined) return {};
  return { dataRoot: readDataRoot(path, parseObject(path, text)) };
};

const CACHE = new Map<string, UserConfig>();

/**
 * Drops the memoised reads. For a TEST that writes a different `config.json`
 * into a directory it already read — the only caller that can observe the file
 * change within one process.
 */
export const clearUserConfigCache = (): void => CACHE.clear();

/**
 * An absent file yields an empty configuration; a malformed one refuses. Read at
 * most ONCE per config directory per process — a refusal is not cached, so it
 * costs a re-read, which only ever happens on the path to an exit 2.
 */
export const loadUserConfig = (configDir: string): UserConfig => {
  const cached = CACHE.get(configDir);
  if (cached !== undefined) return cached;
  const loaded = readUserConfig(configDir);
  CACHE.set(configDir, loaded);
  return loaded;
};
