import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

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
 * The single top-level directory dp-gnosis owns (`<root>/dp-gnosis`). Both the
 * tracked vault and the disposable cache hang off it, so the package occupies
 * ONE entry at the repo root instead of two siblings whose names implied no
 * relationship.
 */
const gnosisRoot = (root: string = repoRoot()): string => resolve(root, 'dp-gnosis');

/** The markdown atom vault, the liftable knowledge unit (`<root>/dp-gnosis/vault`). */
export const vaultRoot = (root: string = repoRoot()): string => resolve(gnosisRoot(root), 'vault');

/** Tracked, curated atoms — the ONLY root the indexer is allowed to read. */
export const atomsDir = (root: string = repoRoot()): string => resolve(vaultRoot(root), 'atoms');

/** Gitignored draft atoms awaiting review. MUST never be retrievable. */
export const proposalsDir = (root: string = repoRoot()): string =>
  resolve(vaultRoot(root), 'proposals');

/**
 * Derived, disposable runtime state (`<root>/dp-gnosis/cache`). Gitignored as a
 * whole; everything under it is rebuildable from `atomsDir()`.
 */
export const runtimeRoot = (root: string = repoRoot()): string => resolve(gnosisRoot(root), 'cache');

/** Built search indexes; rebuildable from `atomsDir()` alone. */
export const indexDir = (root: string = repoRoot()): string => resolve(runtimeRoot(root), 'index');

/** Default destination of the FTS5 index the CLI builds and reads. */
export const fts5IndexPath = (root: string = repoRoot()): string =>
  resolve(indexDir(root), 'atoms-fts5.db');

/** Default destination of the MiniSearch index the CLI builds and reads. */
export const minisearchIndexPath = (root: string = repoRoot()): string =>
  resolve(indexDir(root), 'atoms-minisearch.json');

/**
 * Default LanceDB dataset DIRECTORY — LanceDB writes a tree, not a single file,
 * and rebuilds it by REMOVING the directory. Every adapter therefore owns a
 * distinct default location: sharing one would let a LanceDB rebuild delete
 * another adapter's index.
 */
export const lancedbIndexDir = (root: string = repoRoot()): string =>
  resolve(indexDir(root), 'atoms-lancedb');

/**
 * The two DENSE LanceDB routes' dataset directories. Each is its OWN tree: the
 * schemas differ (they carry a vector column the frozen route has not), the
 * `hybrid` tree additionally carries a BM25 index, and every LanceDB build
 * REMOVES its directory first — so a shared path would delete another route's
 * index and silently serve a third route's schema.
 */
export const lancedbVecIndexDir = (root: string = repoRoot()): string =>
  resolve(indexDir(root), 'atoms-lancedb-vec');

/** See {@link lancedbVecIndexDir} — one directory per route, never shared. */
export const lancedbHybridIndexDir = (root: string = repoRoot()): string =>
  resolve(indexDir(root), 'atoms-lancedb-hybrid');

/**
 * Stated index location for an adapter that keeps no index. It is never created
 * nor read; it exists so every adapter has its OWN location and the scan adapter
 * cannot silently inherit another adapter's index file.
 */
export const noIndexPath = (root: string = repoRoot()): string => resolve(indexDir(root), 'none');

/**
 * Scratch root for the benchmark: corpus working copies and their indexes.
 * Under `runtimeRoot()` because it is derived and disposable — the bench never
 * measures `atomsDir()` in place, so a run cannot mutate the curated vault.
 */
export const benchWorkDir = (root: string = repoRoot()): string =>
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

/**
 * The SHIPPED ingest profile: the vocabularies and the path→label tables ingest
 * labels a corpus with. Tracked next to the code because it is authored policy,
 * not derived state — a missing or malformed file is a hard error, never a
 * silent fallback to values built into the code.
 */
export const ingestProfilePath = (): string =>
  resolve(profilesDir(), 'default.profile.json');

/** Where reproducible, comparable reports are persisted (repo convention). */
export const docsTestDir = (root: string = repoRoot()): string =>
  resolve(root, 'docs', 'test');

/**
 * @deprecated Use `repoRoot()`. The constant form freezes the layout at import
 * time and dies when topic resolution lands.
 */
export const REPO_ROOT: string = repoRoot();

/**
 * @deprecated Use `vaultRoot()`. The constant form freezes the layout at import
 * time and dies when topic resolution lands.
 */
export const VAULT_ROOT: string = vaultRoot();

/**
 * @deprecated Use `atomsDir()`. The constant form freezes the layout at import
 * time and dies when topic resolution lands.
 */
export const ATOMS_DIR: string = atomsDir();

/**
 * @deprecated Use `proposalsDir()`. The constant form freezes the layout at
 * import time and dies when topic resolution lands.
 */
export const PROPOSALS_DIR: string = proposalsDir();

/**
 * @deprecated Use `runtimeRoot()`. The constant form freezes the layout at
 * import time and dies when topic resolution lands.
 */
export const RUNTIME_ROOT: string = runtimeRoot();

/**
 * @deprecated Use `indexDir()`. The constant form freezes the layout at import
 * time and dies when topic resolution lands.
 */
export const INDEX_DIR: string = indexDir();

/**
 * @deprecated Use `fts5IndexPath()`. The constant form freezes the layout at
 * import time and dies when topic resolution lands.
 */
export const FTS5_INDEX_PATH: string = fts5IndexPath();

/**
 * @deprecated Use `minisearchIndexPath()`. The constant form freezes the layout
 * at import time and dies when topic resolution lands.
 */
export const MINISEARCH_INDEX_PATH: string = minisearchIndexPath();

/**
 * @deprecated Use `lancedbIndexDir()`. The constant form freezes the layout at
 * import time and dies when topic resolution lands.
 */
export const LANCEDB_INDEX_DIR: string = lancedbIndexDir();

/**
 * @deprecated Use `lancedbVecIndexDir()`. The constant form freezes the layout
 * at import time and dies when topic resolution lands.
 */
export const LANCEDB_VEC_INDEX_DIR: string = lancedbVecIndexDir();

/**
 * @deprecated Use `lancedbHybridIndexDir()`. The constant form freezes the
 * layout at import time and dies when topic resolution lands.
 */
export const LANCEDB_HYBRID_INDEX_DIR: string = lancedbHybridIndexDir();

/**
 * @deprecated Use `noIndexPath()`. The constant form freezes the layout at
 * import time and dies when topic resolution lands.
 */
export const NO_INDEX_PATH: string = noIndexPath();

/**
 * @deprecated Use `benchWorkDir()`. The constant form freezes the layout at
 * import time and dies when topic resolution lands.
 */
export const BENCH_WORK_DIR: string = benchWorkDir();

/**
 * @deprecated Use `goldenDir()`. The constant form freezes the layout at import
 * time and dies when topic resolution lands.
 */
export const GOLDEN_DIR: string = goldenDir();

/**
 * @deprecated Use `goldenSetPath()`. The constant form freezes the layout at
 * import time and dies when topic resolution lands.
 */
export const GOLDEN_SET_PATH: string = goldenSetPath();

/**
 * @deprecated Use `profilesDir()`. The constant form freezes the layout at
 * import time and dies when topic resolution lands.
 */
export const PROFILES_DIR: string = profilesDir();

/**
 * @deprecated Use `ingestProfilePath()`. The constant form freezes the layout
 * at import time and dies when topic resolution lands.
 */
export const INGEST_PROFILE_PATH: string = ingestProfilePath();

/**
 * @deprecated Use `docsTestDir()`. The constant form freezes the layout at
 * import time and dies when topic resolution lands.
 */
export const DOCS_TEST_DIR: string = docsTestDir();
