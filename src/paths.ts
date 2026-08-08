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
