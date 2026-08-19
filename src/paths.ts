import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Sole owner of every dp-gnosis filesystem path (COMMON.md §III constant
 * ownership). No other module may spell these paths as string literals.
 *
 * Anchored on this file's own location — `<repo>/tools/dp-gnosis/src/paths.ts`
 * — so the values are identical no matter which directory a CLI, a test, or a
 * hook was invoked from. `process.cwd()` is deliberately NOT used: it makes the
 * vault location depend on the caller's shell.
 */
const SRC_DIR: string = dirname(fileURLToPath(import.meta.url));

/** Absolute path of the repository root (`<repo>`). */
export const REPO_ROOT: string = resolve(SRC_DIR, '..', '..', '..');

/**
 * The single top-level directory dp-gnosis owns (`<repo>/dp-gnosis`). Both the
 * tracked vault and the disposable cache hang off it, so the package occupies
 * ONE entry at the repo root instead of two siblings whose names implied no
 * relationship.
 */
const GNOSIS_ROOT: string = resolve(REPO_ROOT, 'dp-gnosis');

/** The markdown atom vault, the liftable knowledge unit (`<repo>/dp-gnosis/vault`). */
export const VAULT_ROOT: string = resolve(GNOSIS_ROOT, 'vault');

/** Tracked, curated atoms — the ONLY root the indexer is allowed to read. */
export const ATOMS_DIR: string = resolve(VAULT_ROOT, 'atoms');

/** Gitignored draft atoms awaiting review. MUST never be retrievable. */
export const PROPOSALS_DIR: string = resolve(VAULT_ROOT, 'proposals');

/**
 * Derived, disposable runtime state (`<repo>/dp-gnosis/cache`). Gitignored as a
 * whole; everything under it is rebuildable from `ATOMS_DIR`.
 */
export const RUNTIME_ROOT: string = resolve(GNOSIS_ROOT, 'cache');

/** Built search indexes; rebuildable from `ATOMS_DIR` alone. */
export const INDEX_DIR: string = resolve(RUNTIME_ROOT, 'index');

/** Default destination of the FTS5 index the CLI builds and reads. */
export const FTS5_INDEX_PATH: string = resolve(INDEX_DIR, 'atoms-fts5.db');

/** Default destination of the MiniSearch index the CLI builds and reads. */
export const MINISEARCH_INDEX_PATH: string = resolve(INDEX_DIR, 'atoms-minisearch.json');

/**
 * Default LanceDB dataset DIRECTORY — LanceDB writes a tree, not a single file,
 * and rebuilds it by REMOVING the directory. Every adapter therefore owns a
 * distinct default location: sharing one would let a LanceDB rebuild delete
 * another adapter's index.
 */
export const LANCEDB_INDEX_DIR: string = resolve(INDEX_DIR, 'atoms-lancedb');

/**
 * The two DENSE LanceDB routes' dataset directories. Each is its OWN tree: the
 * schemas differ (they carry a vector column the frozen route has not), the
 * `hybrid` tree additionally carries a BM25 index, and every LanceDB build
 * REMOVES its directory first — so a shared path would delete another route's
 * index and silently serve a third route's schema.
 */
export const LANCEDB_VEC_INDEX_DIR: string = resolve(INDEX_DIR, 'atoms-lancedb-vec');

/** See {@link LANCEDB_VEC_INDEX_DIR} — one directory per route, never shared. */
export const LANCEDB_HYBRID_INDEX_DIR: string = resolve(INDEX_DIR, 'atoms-lancedb-hybrid');

/**
 * Stated index location for an adapter that keeps no index. It is never created
 * nor read; it exists so every adapter has its OWN location and the scan adapter
 * cannot silently inherit another adapter's index file.
 */
export const NO_INDEX_PATH: string = resolve(INDEX_DIR, 'none');

/**
 * Scratch root for the benchmark: corpus working copies and their indexes.
 * Under `RUNTIME_ROOT` because it is derived and disposable — the bench never
 * measures `ATOMS_DIR` in place, so a run cannot mutate the curated vault.
 */
export const BENCH_WORK_DIR: string = resolve(RUNTIME_ROOT, 'bench');

/**
 * The FROZEN golden relevance set the benchmark scores every adapter against.
 * Tracked next to the code, NOT under `RUNTIME_ROOT`: it is authored evidence,
 * not derived state, and regenerating it from a retriever's output would make
 * the measurement circular.
 */
export const GOLDEN_DIR: string = resolve(SRC_DIR, '..', 'golden');

/** The one golden set the shipped loader reads; every other version sits beside it. */
export const GOLDEN_SET_PATH: string = resolve(GOLDEN_DIR, 'golden-set.v1.json');

/**
 * The SHIPPED ingest profile: the vocabularies and the path→label tables ingest
 * labels a corpus with. Tracked next to the code because it is authored policy,
 * not derived state — a missing or malformed file is a hard error, never a
 * silent fallback to values built into the code.
 */
export const INGEST_PROFILE_PATH: string = resolve(SRC_DIR, '..', 'profiles', 'default.profile.json');

/** Where reproducible, comparable reports are persisted (repo convention). */
export const DOCS_TEST_DIR: string = resolve(REPO_ROOT, 'docs', 'test');
