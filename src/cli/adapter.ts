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
import {
  createLanceDbDenseAdapter,
  type DenseRoute
} from '../adapters/lanceDbDenseAdapter.js';
import { createLinearScanAdapter } from '../adapters/linearScanAdapter.js';
import { createMiniSearchAdapter } from '../adapters/miniSearchAdapter.js';
import {
  FTS5_INDEX_PATH,
  LANCEDB_HYBRID_INDEX_DIR,
  LANCEDB_INDEX_DIR,
  LANCEDB_VEC_INDEX_DIR,
  MINISEARCH_INDEX_PATH,
  NO_INDEX_PATH
} from '../paths.js';
import type { KnowledgePort } from '../port.js';

/**
 * The closed adapter vocabulary. It grows ADDITIVELY: `lancedb` is the FROZEN
 * lexical route, and the two dense routes are separate NAMES rather than a flag
 * on it, so the recorded `adapter` field carries the treatment on its own.
 */
export const ADAPTER_NAMES = [
  'linear',
  'fts5',
  'minisearch',
  'lancedb',
  'lancedb-vec',
  'lancedb-hybrid',
  'lancedb-hybrid-full',
] as const;

export type AdapterName = (typeof ADAPTER_NAMES)[number];

/** The reference adapter: no index, so `index` is a no-op and retrieval always works. */
export const DEFAULT_ADAPTER: AdapterName = 'linear';

/** Membership test rather than a cast — an unknown name is not an `AdapterName`. */
export const resolveAdapter = (value: string): AdapterName | undefined =>
  ADAPTER_NAMES.find(name => name === value);

export const adapterError = (value: string): string =>
  `unknown adapter "${value}" — pass --adapter with one of: ${ADAPTER_NAMES.join(', ')}`;

/**
 * Adapter name → the dense LEG it opens. The ONE owner of that mapping: the port
 * factories below read it, and so does any caller that must construct a dense
 * adapter with a tuning parameter attached (the benchmark's leg-weight sweep) —
 * a second copy is how a name ends up measuring another route.
 */
export const DENSE_ROUTES = {
  'lancedb-vec': 'vec',
  'lancedb-hybrid': 'hybrid',
  'lancedb-hybrid-full': 'hybrid-full',
} as const satisfies Readonly<Partial<Record<AdapterName, DenseRoute>>>;

/** The adapter names that open a dense leg — the keys of {@link DENSE_ROUTES}. */
export type DenseAdapterName = keyof typeof DENSE_ROUTES;

/** The same table, widened over the vocabulary so a lookup needs no cast. */
const DENSE_ROUTE_BY_NAME: Readonly<Partial<Record<AdapterName, DenseRoute>>> = DENSE_ROUTES;

/** The leg `adapter` opens, or `undefined` when it opens no dense leg at all. */
export const denseRouteOf = (adapter: AdapterName): DenseRoute | undefined =>
  DENSE_ROUTE_BY_NAME[adapter];

/** Adapters that persist an index; the rest treat `index` as an explicit no-op. */
export const hasPersistentIndex = (adapter: AdapterName): boolean => adapter !== 'linear';

/**
 * Where each adapter's index lives when `--index-path` is not given. The record
 * is TOTAL over the vocabulary, so a new adapter cannot be added without stating
 * its own location — two adapters sharing one would corrupt each other.
 *
 * The ONE stated exception: `lancedb-hybrid-full` builds and reads BYTE-IDENTICAL
 * content to `lancedb-hybrid` — same schema, same vectors, same BM25 index — and
 * differs only in what it does with the fused order at retrieve time. Two names
 * over one tree is therefore safe here, and it is what keeps the expensive
 * embedding sidecar (`<indexDir>.embed-cache`) warm across the pair.
 */
const DEFAULT_INDEX_PATHS: Readonly<Record<AdapterName, string>> = {
  linear: NO_INDEX_PATH,
  fts5: FTS5_INDEX_PATH,
  minisearch: MINISEARCH_INDEX_PATH,
  lancedb: LANCEDB_INDEX_DIR,
  'lancedb-vec': LANCEDB_VEC_INDEX_DIR,
  'lancedb-hybrid': LANCEDB_HYBRID_INDEX_DIR,
  'lancedb-hybrid-full': LANCEDB_HYBRID_INDEX_DIR,
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
const denseFactory =
  (route: DenseRoute) =>
    (location: PortLocation): KnowledgePort =>
      createLanceDbDenseAdapter({
        atomsDir: location.atomsDir,
        indexDir: location.indexPath,
        route,
        now: new Date(),
      });

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
  'lancedb-vec': denseFactory(DENSE_ROUTES['lancedb-vec']),
  'lancedb-hybrid': denseFactory(DENSE_ROUTES['lancedb-hybrid']),
  'lancedb-hybrid-full': denseFactory(DENSE_ROUTES['lancedb-hybrid-full']),
};

export const createPort = (
  adapter: AdapterName,
  atomsDir: string,
  indexPath: string
): KnowledgePort => PORT_FACTORIES[adapter]({ atomsDir, indexPath });
