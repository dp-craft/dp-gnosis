/**
 * `--adapter` resolution and port construction — the ONLY place in the CLI that
 * knows which adapters exist.
 *
 * The load-bearing property this file protects: swapping the adapter changes
 * RANKING and PERFORMANCE and nothing else. Every subcommand below this point
 * sees a bare `KnowledgePort`, so it cannot branch on the implementation, and
 * the output schema and exit codes therefore cannot diverge per adapter.
 */
import { createFts5Adapter } from '../adapters/fts5Adapter.js';
import { createLanceDbAdapter } from '../adapters/lanceDbAdapter.js';
import { createLinearScanAdapter } from '../adapters/linearScanAdapter.js';
import { createMiniSearchAdapter } from '../adapters/miniSearchAdapter.js';
import {
  FTS5_INDEX_PATH,
  LANCEDB_INDEX_DIR,
  MINISEARCH_INDEX_PATH,
  NO_INDEX_PATH
} from '../paths.js';
import type { KnowledgePort } from '../port.js';

/** The closed adapter vocabulary. */
export const ADAPTER_NAMES = ['linear', 'fts5', 'minisearch', 'lancedb'] as const;

export type AdapterName = (typeof ADAPTER_NAMES)[number];

/** The reference adapter: no index, so `index` is a no-op and retrieval always works. */
export const DEFAULT_ADAPTER: AdapterName = 'linear';

/** Membership test rather than a cast — an unknown name is not an `AdapterName`. */
export const resolveAdapter = (value: string): AdapterName | undefined =>
  ADAPTER_NAMES.find(name => name === value);

export const adapterError = (value: string): string =>
  `unknown adapter "${value}" — pass --adapter with one of: ${ADAPTER_NAMES.join(', ')}`;

/** Adapters that persist an index; the rest treat `index` as an explicit no-op. */
export const hasPersistentIndex = (adapter: AdapterName): boolean => adapter !== 'linear';

/**
 * Where each adapter's index lives when `--index-path` is not given. The record
 * is TOTAL over the vocabulary, so a new adapter cannot be added without stating
 * its own location — two adapters sharing one would corrupt each other.
 */
const DEFAULT_INDEX_PATHS: Readonly<Record<AdapterName, string>> = {
  linear: NO_INDEX_PATH,
  fts5: FTS5_INDEX_PATH,
  minisearch: MINISEARCH_INDEX_PATH,
  lancedb: LANCEDB_INDEX_DIR,
};

export const defaultIndexPath = (adapter: AdapterName): string => DEFAULT_INDEX_PATHS[adapter];

/** The corpus root and the index location one port is opened against. */
interface PortLocation {
  readonly atomsDir: string;
  readonly indexPath: string;
}

/**
 * A total map rather than a chain of conditionals: every adapter is constructed
 * in exactly one place, and adding one is a compile error until it is listed.
 * `indexPath` is a DIRECTORY for LanceDB, which writes a tree rather than a file.
 */
const PORT_FACTORIES: Readonly<Record<AdapterName, (location: PortLocation) => KnowledgePort>> = {
  linear: location => createLinearScanAdapter(location.atomsDir),
  fts5: location => createFts5Adapter({ ...location, now: new Date() }),
  minisearch: location => createMiniSearchAdapter({ ...location, now: new Date() }),
  lancedb: location =>
    createLanceDbAdapter({
      atomsDir: location.atomsDir,
      indexDir: location.indexPath,
      now: new Date(),
    }),
};

export const createPort = (
  adapter: AdapterName,
  atomsDir: string,
  indexPath: string
): KnowledgePort => PORT_FACTORIES[adapter]({ atomsDir, indexPath });
