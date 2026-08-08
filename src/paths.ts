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

/** The markdown atom vault, the liftable knowledge unit (`<repo>/gnosis`). */
export const VAULT_ROOT: string = resolve(REPO_ROOT, 'gnosis');

/** Tracked, curated atoms — the ONLY root the indexer is allowed to read. */
export const ATOMS_DIR: string = resolve(VAULT_ROOT, 'atoms');

/** Gitignored draft atoms awaiting review. MUST never be retrievable. */
export const PROPOSALS_DIR: string = resolve(VAULT_ROOT, 'proposals');

/** Derived, disposable runtime state (`<repo>/.dp-gnosis`). */
export const RUNTIME_ROOT: string = resolve(REPO_ROOT, '.dp-gnosis');

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
export const GOLDEN_SET_PATH: string = resolve(SRC_DIR, '..', 'golden', 'golden-set.v1.json');

/** Where reproducible, comparable reports are persisted (repo convention). */
export const DOCS_TEST_DIR: string = resolve(REPO_ROOT, 'docs', 'test');
