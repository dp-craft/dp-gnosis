import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';

/**
 * Cross-platform resolution of the four user directories dp-gnosis writes to:
 * config, data, cache and state. Every export is a FUNCTION, never a
 * module-level constant — a constant would freeze the environment at import
 * time, so a test (or a CLI that sets a variable before dispatch) could never
 * change it, and the frozen value would be whatever the first importer saw.
 *
 * Precedence, per directory:
 *   1. the gnosis-specific override (`GNOSIS_*_HOME`);
 *   2. the platform convention (`XDG_*_HOME`, or `APPDATA`/`LOCALAPPDATA` on
 *      Windows), else the platform's home-relative default;
 *   3. the app directory name `gnosis` appended to whatever won.
 *
 * The gnosis-specific override outranks XDG because XDG is a SHARED setting: a
 * user who points `XDG_DATA_HOME` at a new tree is redirecting every
 * application at once, while `GNOSIS_DATA_HOME` names this one. The narrower
 * statement of intent MUST win, or a user could not relocate gnosis alone.
 * On darwin an XDG variable, when SET, still beats the Apple default — a user
 * who exports it on macOS is opting out of that convention deliberately.
 *
 * Nothing here creates a directory or touches the filesystem: these are pure
 * computations, so they are safe to call from a validator, a `--help` path, or
 * a test, none of which should leave a tree behind. Creation belongs to the
 * writer that actually needs the directory.
 *
 * An env var that is set but empty or all-whitespace is treated as UNSET. An
 * empty `XDG_DATA_HOME` resolving to `/gnosis` is precisely the silent-wrong-
 * path failure this project polices. A relative value is REFUSED rather than
 * resolved against `process.cwd()`, which would make the location depend on the
 * caller's shell; the error names the variable and its value.
 */

/** The one directory name dp-gnosis owns under every resolved base. */
const APP_DIR = 'gnosis';

type DirKind = 'config' | 'data' | 'cache' | 'state';

const GNOSIS_VARS: Readonly<Record<DirKind, string>> = {
  config: 'GNOSIS_CONFIG_HOME',
  data: 'GNOSIS_DATA_HOME',
  cache: 'GNOSIS_CACHE_HOME',
  state: 'GNOSIS_STATE_HOME',
};

const XDG_VARS: Readonly<Record<DirKind, string>> = {
  config: 'XDG_CONFIG_HOME',
  data: 'XDG_DATA_HOME',
  cache: 'XDG_CACHE_HOME',
  state: 'XDG_STATE_HOME',
};

const XDG_FALLBACKS: Readonly<Record<DirKind, readonly string[]>> = {
  config: ['.config'],
  data: ['.local', 'share'],
  cache: ['.cache'],
  state: ['.local', 'state'],
};

const DARWIN_FALLBACKS: Readonly<Record<DirKind, readonly string[]>> = {
  config: ['Library', 'Application Support'],
  data: ['Library', 'Application Support'],
  cache: ['Library', 'Caches'],
  state: ['Library', 'Logs'],
};

const WIN_VARS: Readonly<Record<DirKind, string>> = {
  config: 'APPDATA',
  data: 'APPDATA',
  cache: 'LOCALAPPDATA',
  state: 'LOCALAPPDATA',
};

const WIN_FALLBACKS: Readonly<Record<DirKind, readonly string[]>> = {
  config: ['AppData', 'Roaming'],
  data: ['AppData', 'Roaming'],
  cache: ['AppData', 'Local'],
  state: ['AppData', 'Local'],
};

/** A set-but-blank variable carries no path; it MUST read as unset. */
const readVar = (env: NodeJS.ProcessEnv, name: string): string | undefined => {
  const raw = env[name];
  const trimmed = raw === undefined ? '' : raw.trim();
  return trimmed === '' ? undefined : trimmed;
};

/** Refuses a relative value by NAME — never resolves it against cwd. */
const requireAbsolute = (name: string, value: string): string => {
  if (isAbsolute(value)) return value;
  throw new Error(
    `${name} must be an absolute path (it is used as a directory base), got "${value}"`
  );
};

const fromVar = (env: NodeJS.ProcessEnv, name: string): string | undefined => {
  const value = readVar(env, name);
  return value === undefined ? undefined : requireAbsolute(name, value);
};

const underHome = (segments: readonly string[]): string => join(homedir(), ...segments);

const win32Base = (env: NodeJS.ProcessEnv, kind: DirKind): string =>
  fromVar(env, WIN_VARS[kind]) ?? underHome(WIN_FALLBACKS[kind]);

const xdgBase = (
  env: NodeJS.ProcessEnv,
  kind: DirKind,
  fallbacks: Readonly<Record<DirKind, readonly string[]>>
): string => fromVar(env, XDG_VARS[kind]) ?? underHome(fallbacks[kind]);

const platformBase = (env: NodeJS.ProcessEnv, platform: NodeJS.Platform, kind: DirKind): string => {
  if (platform === 'win32') return win32Base(env, kind);
  if (platform === 'darwin') return xdgBase(env, kind, DARWIN_FALLBACKS);
  return xdgBase(env, kind, XDG_FALLBACKS);
};

const resolveHome = (kind: DirKind, env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string =>
  join(fromVar(env, GNOSIS_VARS[kind]) ?? platformBase(env, platform, kind), APP_DIR);

/** Directory holding `config.yaml`. */
export const configHome = (
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform
): string => resolveHome('config', env, platform);

/** Directory holding the per-topic atoms and their indexes. */
export const dataHome = (
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform
): string => resolveHome('data', env, platform);

/** Directory holding downloaded models and the rephrase disk cache. */
export const cacheHome = (
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform
): string => resolveHome('cache', env, platform);

/** Directory holding logs. */
export const stateHome = (
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform
): string => resolveHome('state', env, platform);
