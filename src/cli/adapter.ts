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
import { createLinearScanAdapter } from '../adapters/linearScanAdapter.js';
import type { KnowledgePort } from '../port.js';

/** The closed adapter vocabulary. */
export const ADAPTER_NAMES = ['linear', 'fts5'] as const;

export type AdapterName = (typeof ADAPTER_NAMES)[number];

/** The reference adapter: no index, so `index` is a no-op and retrieval always works. */
export const DEFAULT_ADAPTER: AdapterName = 'linear';

/** Membership test rather than a cast — an unknown name is not an `AdapterName`. */
export const resolveAdapter = (value: string): AdapterName | undefined =>
  ADAPTER_NAMES.find(name => name === value);

export const adapterError = (value: string): string =>
  `unknown adapter "${value}" — pass --adapter with one of: ${ADAPTER_NAMES.join(', ')}`;

/** Adapters that persist an index; the rest treat `index` as an explicit no-op. */
export const hasPersistentIndex = (adapter: AdapterName): boolean => adapter === 'fts5';

export const createPort = (
  adapter: AdapterName,
  atomsDir: string,
  indexPath: string
): KnowledgePort =>
  adapter === 'linear'
    ? createLinearScanAdapter(atomsDir)
    : createFts5Adapter({ atomsDir, indexPath, now: new Date() });
