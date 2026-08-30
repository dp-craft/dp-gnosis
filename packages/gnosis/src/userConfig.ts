import { readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';

import { configHome } from './env.js';

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

/**
 * Every reranker backend an instance may select: the served HTTP endpoint, or
 * an in-process engine. A closed two-member vocabulary, deliberately not an open
 * registry — each member is a different scoring implementation with its own
 * score scale, and a name that resolved to nothing would rerank silently badly.
 */
export const RERANK_BACKENDS = ['http', 'local'] as const;

export type RerankBackend = (typeof RERANK_BACKENDS)[number];

const isRerankBackend = (value: string): value is RerankBackend =>
  RERANK_BACKENDS.some(backend => backend === value);

/**
 * The ONE validator for a backend name, called for `config.json` AND for the
 * environment override, so the two cannot drift on what they accept. `source`
 * is what the refusal names — the file and key, or the variable.
 */
export const asRerankBackend = (source: string, value: string): RerankBackend => {
  if (isRerankBackend(value)) return value;
  return refuse(`${source} must be one of ${RERANK_BACKENDS.join(' or ')}, got "${value}"`);
};

/** Where the reranker is served, under which id, and by WHICH backend. */
export interface RerankConfig {
  /** Absolute `http://` or `https://` base URL of the llama-swap server. */
  readonly url?: string | undefined;
  /** The model id THIS server serves the reranker under. An HTTP id, never a file. */
  readonly model?: string | undefined;
  /** Which implementation scores. Absent means the shipped `http` one. */
  readonly backend?: RerankBackend | undefined;
  /** Absolute path to the GGUF the `local` backend scores with. */
  readonly modelPath?: string | undefined;
}

/**
 * The id each CHAT hop asks its server for, in place of the shipped constant.
 *
 * The three shipped ids are one machine's private llama-swap names, so on every
 * other install `enrich`, `--rephrase` and `--synthesize` asked for models that
 * server never heard of and the only remedy was an exported variable in each
 * shell. Unlike the reranker there is no URL here: all four hops are served by
 * the SAME llama-swap instance and share `rerank.url`, and a second address
 * would be free to drift from the one actually listening.
 */
export interface ModelsConfig {
  /** The rewriter behind `search --rephrase`. */
  readonly rephrase?: string | undefined;
  /** The synthesiser behind `answer --synthesize`. */
  readonly synthesize?: string | undefined;
  /** The generator the enrichment pass calls. */
  readonly enrich?: string | undefined;
}

/** What a `config.json` may declare. Only the keys with a reader live here. */
export interface UserConfig {
  /** Absolute root the vault and cache trees hang off, in place of the default. */
  readonly dataRoot?: string | undefined;
  /** The reranker endpoint, in place of the shipped address and id. */
  readonly rerank?: RerankConfig | undefined;
  /** The chat hop ids, in place of the shipped constants. */
  readonly models?: ModelsConfig | undefined;
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

/** Every accepted URL scheme. A bare `host:port` names no protocol to speak. */
const URL_SCHEMES: readonly string[] = ['http://', 'https://'];

const requireNonEmptyString = (path: string, key: string, value: unknown): string => {
  if (typeof value !== 'string' || value.trim() === '') {
    refuse(`${key} in gnosis config ${path} must be a non-empty string`);
  }
  return value.trim();
};

/**
 * A relative or scheme-less address is refused rather than repaired: guessing
 * `http://` for it would send every rerank call at an address the user never
 * wrote, and a connection refused there names the guess, not the file.
 */
const readRerankUrl = (path: string, value: unknown): string | undefined => {
  if (value === undefined) return undefined;
  const url = requireNonEmptyString(path, 'rerank.url', value);
  if (URL_SCHEMES.some(scheme => url.startsWith(scheme))) return url;
  return refuse(
    `rerank.url in gnosis config ${path} must start with ${URL_SCHEMES.join(' or ')} (it is a server base URL), got "${url}"`
  );
};

const readRerankModel = (path: string, value: unknown): string | undefined =>
  value === undefined ? undefined : requireNonEmptyString(path, 'rerank.model', value);

/**
 * The GGUF the `local` backend scores with. A SEPARATE key from `rerank.model`,
 * which is a served model id: overloading one key to mean either an HTTP id or
 * a filesystem path would leave no way to say which was meant, and the two
 * resolve through different machinery.
 *
 * A relative path is REFUSED rather than resolved against the working
 * directory. `dp-gnosis` is run from anywhere and served from an MCP client
 * whose cwd nobody chose, so the same key would name a different file per
 * caller — and a rerank scored by a file the user did not mean returns a
 * plausible ranking with nothing to notice it by.
 */
const readRerankModelPath = (path: string, value: unknown): string | undefined => {
  if (value === undefined) return undefined;
  const modelPath = requireNonEmptyString(path, 'rerank.modelPath', value);
  if (isAbsolute(modelPath)) return modelPath;
  return refuse(
    `rerank.modelPath in gnosis config ${path} must be an ABSOLUTE path to a .gguf file, got "${modelPath}"`
  );
};

const readRerankBackend = (path: string, value: unknown): RerankBackend | undefined =>
  value === undefined
    ? undefined
    : asRerankBackend(
        `rerank.backend in gnosis config ${path}`,
        requireNonEmptyString(path, 'rerank.backend', value)
      );

const readRerank = (path: string, raw: Readonly<Record<string, unknown>>): RerankConfig | undefined => {
  const value = raw['rerank'];
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    refuse(`rerank in gnosis config ${path} must be a JSON object, e.g. {"rerank": {"url": "http://127.0.0.1:9292"}}`);
  }
  return {
    url: readRerankUrl(path, value['url']),
    model: readRerankModel(path, value['model']),
    backend: readRerankBackend(path, value['backend']),
    modelPath: readRerankModelPath(path, value['modelPath']),
  };
};

/**
 * A blank or non-string id REFUSES by key name rather than falling through to
 * the shipped constant: a user who wrote the key stated something, and silently
 * serving the id they replaced is the same wrong-value-recorded-as-data failure
 * a relative `dataRoot` is refused for.
 */
const readModelId = (path: string, key: string, value: unknown): string | undefined =>
  value === undefined ? undefined : requireNonEmptyString(path, key, value);

const readModels = (path: string, raw: Readonly<Record<string, unknown>>): ModelsConfig | undefined => {
  const value = raw['models'];
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    refuse(`models in gnosis config ${path} must be a JSON object, e.g. {"models": {"enrich": "your-chat-model"}}`);
  }
  return {
    rephrase: readModelId(path, 'models.rephrase', value['rephrase']),
    synthesize: readModelId(path, 'models.synthesize', value['synthesize']),
    enrich: readModelId(path, 'models.enrich', value['enrich']),
  };
};

const readUserConfig = (configDir: string): UserConfig => {
  const path = userConfigPath(configDir);
  const text = readIfPresent(path);
  if (text === undefined) return {};
  const raw = parseObject(path, text);
  return {
    dataRoot: readDataRoot(path, raw),
    rerank: readRerank(path, raw),
    models: readModels(path, raw),
  };
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

/**
 * The chat ids the config home `env` names, or nothing at all. The ONE reader
 * of the `models` block, so the three hops cannot drift on where it lives.
 */
export const configuredModels = (env: NodeJS.ProcessEnv): ModelsConfig =>
  loadUserConfig(configHome(env)).models ?? {};
