import { existsSync } from 'node:fs';
import { dirname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { configHome, dataHome, dataHomeOverride, DATA_HOME_VAR, statedVar } from './env.js';
import { loadUserConfig } from './userConfig.js';

/**
 * Sole owner of every dp-gnosis filesystem path (COMMON.md §III constant
 * ownership). No other module may spell these paths as string literals.
 *
 * Every path is a FUNCTION OF A ROOT, not a module-level constant. A
 * module-level `const` is evaluated once, at import time, and freezes the
 * layout for the lifetime of the process: the same process cannot then serve
 * two roots (a vault under test beside the real one, one topic's tree beside
 * another's), and an INSTALLED CLI resolves the vault against its own installed
 * source location rather than the root the caller is working in. Both defects
 * are invisible — they produce a plausible path, never an error. Taking the
 * root as a parameter makes the layout re-derivable per call and keeps the
 * default identical to what it always was.
 *
 * The DEFAULT root is anchored on this file's own location —
 * `<repo>/packages/gnosis/src/paths.ts` — so the values are identical no matter
 * which directory a CLI, a test, or a hook was invoked from. `process.cwd()` is
 * deliberately NOT used: it makes the vault location depend on the caller's
 * shell.
 */
const srcDir = (): string => dirname(fileURLToPath(import.meta.url));

/** Absolute path of the repository root (`<repo>`). */
export const repoRoot = (): string => resolve(srcDir(), '..', '..', '..');

/**
 * This package's own directory, which carries the authored, tracked assets
 * (`profiles/`, `golden/`). It is anchored on THIS FILE's location — one level
 * above `src/` in the repository, one level above `dist/` in an install — and
 * NOT on `repoRoot()`: `<root>/packages/gnosis` is a fact about the development
 * checkout, and an installed package sits at `<prefix>/@dp/gnosis` instead, so
 * the derived form resolved a profile path that does not exist and the CLI died
 * on `--help`. The value is identical to the old one in the checkout.
 *
 * It takes NO root, deliberately: an authored asset follows the CODE, while the
 * vault and the cache follow the caller's root. That split is the whole reason
 * both forms exist here.
 */
const packageDir = (): string => resolve(srcDir(), '..');

/**
 * Whether this package is running from an INSTALL rather than a checkout —
 * decided by its own location, which is the only evidence that survives being
 * copied anywhere. `node_modules` is matched as a whole PATH SEGMENT, never as a
 * substring: a checkout under `~/my_node_modules_backup/` is not an install, and
 * a substring test would say it is and silently relocate that developer's vault.
 *
 * It matters because an installed tree is WIPED on upgrade and is often not
 * user-writable, so `<prefix>/lib/node_modules/benchmark-data/vault` — what the
 * repo-relative default resolves to once installed — is a vault that disappears.
 */
export const isInstalled = (dir: string = srcDir()): boolean =>
  dir.split(sep).includes('node_modules');

/**
 * The root the VAULT and the CACHE hang off, resolved per call. Precedence, most
 * specific statement of intent first:
 *
 *   1. `DP_GNOSIS_DATA_HOME` / `XDG_DATA_HOME` — the user named a data location for
 *      this run, via `env.ts:dataHomeOverride()`;
 *   2. `dataRoot` in `config.json` under `env.ts:configHome()` — the user named
 *      one persistently. A malformed file REFUSES rather than falling back;
 *   3. the data home when INSTALLED, else `repoRoot()` — so a checkout resolves
 *      byte-identically to what it always did, and every recorded number stands.
 *
 * Authored assets (`profiles/`, `golden/`) are NOT resolved through here: they
 * follow the CODE, via `packageDir()`. Only derived, user-owned state moves.
 */
export const dataRoot = (
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform
): string =>
  dataHomeOverride(env, platform) ??
  loadUserConfig(configHome(env, platform)).dataRoot ??
  defaultDataRoot(env, platform);

const defaultDataRoot = (env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string =>
  isInstalled() ? dataHome(env, platform) : repoRoot();

/** Which tier supplied the resolved data root — the precedence, made readable. */
export type DataRootOrigin = 'env' | 'config' | 'default';

/**
 * The resolved data root WITH the tier that supplied it and the statements it
 * beat. A value alone cannot say that a `config.json` declared something else
 * and lost, which is the whole subject of the diagnostic that reads this.
 */
export interface DataRootFact {
  readonly value: string;
  readonly origin: DataRootOrigin;
  /**
   * What the environment VARIABLE holds, whether or not it won -- the string the
   * user wrote, not the directory it resolves to. A diagnostic quotes this back
   * as the variable's value, and `dataHomeOverride` already appended the
   * application directory, so reporting that quoted a value nothing had set.
   */
  readonly stated: string | undefined;
  /** What `config.json` declared, whether or not it won. */
  readonly configured: string | undefined;
}

/**
 * The same chain {@link dataRoot} applies, reported rather than reduced — so a
 * diagnostic names the order this module actually uses instead of re-deriving
 * one of its own. `tests/dataRoot.test.ts` pins the two to the same value on
 * every tier; that pin is what makes two spellings safe.
 *
 * It reads BOTH tiers where `dataRoot` short-circuits, which is deliberate:
 * `dataRoot` must keep resolving from the environment over a `config.json` it
 * would refuse, so the file is never touched on that path. A caller of this one
 * is asking about the file, and gets its refusal.
 */
export const dataRootFact = (
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform
): DataRootFact => {
  const override = dataHomeOverride(env, platform);
  const stated = statedVar(env, DATA_HOME_VAR);
  const configured = loadUserConfig(configHome(env, platform)).dataRoot;
  if (override !== undefined) return { value: override, origin: 'env', stated, configured };
  return configured !== undefined
    ? { value: configured, origin: 'config', stated, configured }
    : { value: defaultDataRoot(env, platform), origin: 'default', stated, configured };
};

/**
 * The single top-level directory dp-gnosis owns (`<root>/benchmark-data`). Both the
 * tracked vault and the disposable cache hang off it, so the package occupies
 * ONE entry at the repo root instead of two siblings whose names implied no
 * relationship.
 */
const gnosisRoot = (root: string = dataRoot()): string => resolve(root, 'benchmark-data');

/** The markdown atom vault, the liftable knowledge unit (`<root>/benchmark-data/vault`). */
export const vaultRoot = (root: string = dataRoot()): string => resolve(gnosisRoot(root), 'vault');

/** Tracked, curated atoms — the ONLY root the indexer is allowed to read. */
export const atomsDir = (root: string = dataRoot()): string => resolve(vaultRoot(root), 'atoms');

/** Gitignored draft atoms awaiting review. MUST never be retrievable. */
export const proposalsDir = (root: string = dataRoot()): string =>
  resolve(vaultRoot(root), 'proposals');

/**
 * Derived, disposable runtime state (`<root>/benchmark-data/cache`). Gitignored as a
 * whole; everything under it is rebuildable from `atomsDir()`.
 */
export const runtimeRoot = (root: string = dataRoot()): string => resolve(gnosisRoot(root), 'cache');

/** Built search indexes; rebuildable from `atomsDir()` alone. */
export const indexDir = (root: string = dataRoot()): string => resolve(runtimeRoot(root), 'index');

/** Default destination of the FTS5 index the CLI builds and reads. */
export const fts5IndexPath = (root: string = dataRoot()): string =>
  resolve(indexDir(root), 'atoms-fts5.db');

/** Default destination of the MiniSearch index the CLI builds and reads. */
export const minisearchIndexPath = (root: string = dataRoot()): string =>
  resolve(indexDir(root), 'atoms-minisearch.json');

/**
 * Default LanceDB dataset DIRECTORY — LanceDB writes a tree, not a single file,
 * and rebuilds it by REMOVING the directory. Every adapter therefore owns a
 * distinct default location: sharing one would let a LanceDB rebuild delete
 * another adapter's index.
 */
export const lancedbIndexDir = (root: string = dataRoot()): string =>
  resolve(indexDir(root), 'atoms-lancedb');

/**
 * The two DENSE LanceDB routes' dataset directories. Each is its OWN tree: the
 * schemas differ (they carry a vector column the frozen route has not), the
 * `hybrid` tree additionally carries a BM25 index, and every LanceDB build
 * REMOVES its directory first — so a shared path would delete another route's
 * index and silently serve a third route's schema.
 */
export const lancedbVecIndexDir = (root: string = dataRoot()): string =>
  resolve(indexDir(root), 'atoms-lancedb-vec');

/** See {@link lancedbVecIndexDir} — one directory per route, never shared. */
export const lancedbHybridIndexDir = (root: string = dataRoot()): string =>
  resolve(indexDir(root), 'atoms-lancedb-hybrid');

/**
 * Stated index location for an adapter that keeps no index. It is never created
 * nor read; it exists so every adapter has its OWN location and the scan adapter
 * cannot silently inherit another adapter's index file.
 */
export const noIndexPath = (root: string = dataRoot()): string => resolve(indexDir(root), 'none');

/**
 * Scratch root for the benchmark: corpus working copies and their indexes.
 * Under `runtimeRoot()` because it is derived and disposable — the bench never
 * measures `atomsDir()` in place, so a run cannot mutate the curated vault.
 */
export const benchWorkDir = (root: string = dataRoot()): string =>
  resolve(runtimeRoot(root), 'bench');

/**
 * The FROZEN golden relevance set the benchmark scores every adapter against.
 * Tracked next to the code, NOT under `runtimeRoot()`: it is authored evidence,
 * not derived state, and regenerating it from a retriever's output would make
 * the measurement circular.
 */
export const goldenDir = (): string =>
  resolve(packageDir(), 'golden');

/** The one golden set the shipped loader reads; every other version sits beside it. */
export const goldenSetPath = (): string =>
  resolve(goldenDir(), 'golden-set.v1.json');

/**
 * The directory the named profile instances are authored in. A profile is
 * selected by NAME as well as by path, so the directory is resolved here rather
 * than spelled as a literal at each caller.
 */
export const profilesDir = (): string =>
  resolve(packageDir(), 'profiles');

/** The name of the instance `init` creates, and what it stamps the atoms with. */
export const USER_PROFILE_NAME = 'user';

/**
 * The file `init` writes into the config home. It lives here because this
 * module is the sole owner of every dp-gnosis path, and because BOTH `init`
 * (which writes it) and {@link ingestProfilePath} (which prefers it) need it —
 * spelling it twice is how the writer and the reader drift apart.
 */
export const USER_PROFILE_FILE = `${USER_PROFILE_NAME}.profile.json`;

/** Where `init` writes the user's own profile; `--profile` also selects it by path. */
export const userProfilePath = (): string =>
  resolve(configHome(), USER_PROFILE_FILE);

/**
 * The SHIPPED ingest profile, authored for the vault this repository carries.
 * Exported so a refusal can tell this ONE file apart from every profile a user
 * authored: it is the only one tracked beside `config.ts`, and so the only one
 * for which "edit the TypeScript tuple" is a remedy rather than a dead end.
 */
export const shippedProfilePath = (): string =>
  resolve(profilesDir(), 'default.profile.json');

/**
 * The ingest profile an invocation runs under when `--profile` names none: the
 * user's own if `init` wrote one, else the shipped one. Tracked next to the
 * code because it is authored policy, not derived state — a missing or
 * malformed file is a hard error, never a silent fallback to values built into
 * the code.
 *
 * The preference is the fix for a SILENT defect: `init` wrote a profile the
 * user then edited, and every later command ignored it, serving the user's own
 * index under the shipped profile's `defaultPrf`, `defaultExcludedTypes`,
 * `defaultAnalyzer` and `domainRules` at exit 0. A CHECKOUT has no such file,
 * so its resolution is unchanged.
 */
export const ingestProfilePath = (): string => {
  const own = userProfilePath();
  return existsSync(own) ? own : shippedProfilePath();
};

/** Where reproducible, comparable reports are persisted (repo convention). */
export const docsTestDir = (root: string = repoRoot()): string =>
  resolve(root, 'docs', 'test');

/**
 * @deprecated (resolved against `repoRoot()`, so it is NOT config- or
 * install-aware — one more reason not to use it). Use `repoRoot()`. The constant form freezes the layout at import
 * time and dies when topic resolution lands.
 */
export const REPO_ROOT: string = repoRoot();

/**
 * @deprecated (resolved against `repoRoot()`, so it is NOT config- or
 * install-aware — one more reason not to use it). Use `vaultRoot()`. The constant form freezes the layout at import
 * time and dies when topic resolution lands.
 */
export const VAULT_ROOT: string = vaultRoot(repoRoot());

/**
 * @deprecated (resolved against `repoRoot()`, so it is NOT config- or
 * install-aware — one more reason not to use it). Use `atomsDir()`. The constant form freezes the layout at import
 * time and dies when topic resolution lands.
 */
export const ATOMS_DIR: string = atomsDir(repoRoot());

/**
 * @deprecated (resolved against `repoRoot()`, so it is NOT config- or
 * install-aware — one more reason not to use it). Use `proposalsDir()`. The constant form freezes the layout at
 * import time and dies when topic resolution lands.
 */
export const PROPOSALS_DIR: string = proposalsDir(repoRoot());

/**
 * @deprecated (resolved against `repoRoot()`, so it is NOT config- or
 * install-aware — one more reason not to use it). Use `runtimeRoot()`. The constant form freezes the layout at
 * import time and dies when topic resolution lands.
 */
export const RUNTIME_ROOT: string = runtimeRoot(repoRoot());

/**
 * @deprecated (resolved against `repoRoot()`, so it is NOT config- or
 * install-aware — one more reason not to use it). Use `indexDir()`. The constant form freezes the layout at import
 * time and dies when topic resolution lands.
 */
export const INDEX_DIR: string = indexDir(repoRoot());

/**
 * @deprecated (resolved against `repoRoot()`, so it is NOT config- or
 * install-aware — one more reason not to use it). Use `fts5IndexPath()`. The constant form freezes the layout at
 * import time and dies when topic resolution lands.
 */
export const FTS5_INDEX_PATH: string = fts5IndexPath(repoRoot());

/**
 * @deprecated (resolved against `repoRoot()`, so it is NOT config- or
 * install-aware — one more reason not to use it). Use `minisearchIndexPath()`. The constant form freezes the layout
 * at import time and dies when topic resolution lands.
 */
export const MINISEARCH_INDEX_PATH: string = minisearchIndexPath(repoRoot());

/**
 * @deprecated (resolved against `repoRoot()`, so it is NOT config- or
 * install-aware — one more reason not to use it). Use `lancedbIndexDir()`. The constant form freezes the layout at
 * import time and dies when topic resolution lands.
 */
export const LANCEDB_INDEX_DIR: string = lancedbIndexDir(repoRoot());

/**
 * @deprecated (resolved against `repoRoot()`, so it is NOT config- or
 * install-aware — one more reason not to use it). Use `lancedbVecIndexDir()`. The constant form freezes the layout
 * at import time and dies when topic resolution lands.
 */
export const LANCEDB_VEC_INDEX_DIR: string = lancedbVecIndexDir(repoRoot());

/**
 * @deprecated (resolved against `repoRoot()`, so it is NOT config- or
 * install-aware — one more reason not to use it). Use `lancedbHybridIndexDir()`. The constant form freezes the
 * layout at import time and dies when topic resolution lands.
 */
export const LANCEDB_HYBRID_INDEX_DIR: string = lancedbHybridIndexDir(repoRoot());

/**
 * @deprecated (resolved against `repoRoot()`, so it is NOT config- or
 * install-aware — one more reason not to use it). Use `noIndexPath()`. The constant form freezes the layout at
 * import time and dies when topic resolution lands.
 */
export const NO_INDEX_PATH: string = noIndexPath(repoRoot());

/**
 * @deprecated (resolved against `repoRoot()`, so it is NOT config- or
 * install-aware — one more reason not to use it). Use `benchWorkDir()`. The constant form freezes the layout at
 * import time and dies when topic resolution lands.
 */
export const BENCH_WORK_DIR: string = benchWorkDir(repoRoot());

/**
 * @deprecated (resolved against `repoRoot()`, so it is NOT config- or
 * install-aware — one more reason not to use it). Use `goldenDir()`. The constant form freezes the layout at import
 * time and dies when topic resolution lands.
 */
export const GOLDEN_DIR: string = goldenDir();

/**
 * @deprecated (resolved against `repoRoot()`, so it is NOT config- or
 * install-aware — one more reason not to use it). Use `goldenSetPath()`. The constant form freezes the layout at
 * import time and dies when topic resolution lands.
 */
export const GOLDEN_SET_PATH: string = goldenSetPath();

/**
 * @deprecated (resolved against `repoRoot()`, so it is NOT config- or
 * install-aware — one more reason not to use it). Use `profilesDir()`. The constant form freezes the layout at
 * import time and dies when topic resolution lands.
 */
export const PROFILES_DIR: string = profilesDir();

/**
 * @deprecated (resolved against `repoRoot()`, so it is NOT config- or
 * install-aware — one more reason not to use it). Use `ingestProfilePath()`. The constant form freezes the layout
 * at import time and dies when topic resolution lands.
 */
export const INGEST_PROFILE_PATH: string = ingestProfilePath();

/**
 * @deprecated (resolved against `repoRoot()`, so it is NOT config- or
 * install-aware — one more reason not to use it). Use `docsTestDir()`. The constant form freezes the layout at
 * import time and dies when topic resolution lands.
 */
export const DOCS_TEST_DIR: string = docsTestDir(repoRoot());
