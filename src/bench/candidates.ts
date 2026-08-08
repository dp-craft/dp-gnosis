/**
 * The adapters the benchmark measures, and the reason any of them did not run.
 *
 * A candidate that cannot run is REPORTED as skipped, never dropped. Silent
 * omission is the failure this file exists to prevent: a report listing two
 * adapters when three were intended reads as "we measured everything", and the
 * absent one — typically an optional dependency that failed to load — becomes
 * invisible evidence.
 *
 * An adapter is reached through the `KnowledgePort` only, so the harness cannot
 * branch on which implementation it is timing.
 */
import { stat } from 'node:fs/promises';

import type * as Fts5Namespace from '../adapters/fts5Adapter.js';
import { createLinearScanAdapter } from '../adapters/linearScanAdapter.js';
import type { KnowledgePort } from '../port.js';

/** Where one adapter reads its corpus and writes its index. */
export interface CorpusLocation {
  readonly atomsDir: string;
  readonly indexPath: string;
}

/** One measurable adapter, plus the reason it cannot be measured. */
export interface AdapterCandidate {
  readonly name: string;
  /** Present ONLY when the adapter cannot run; its text goes into the report. */
  readonly unavailableReason?: string;
  /** Build or rebuild the persistent index. Returns bytes on disk (0 = none). */
  readonly index: (location: CorpusLocation) => Promise<number>;
  /** Open a port. Called once per cold measurement, so it pays index load. */
  readonly open: (location: CorpusLocation) => KnowledgePort;
}

/** Why an adapter did not run, as persisted in the report. */
export interface SkippedAdapter {
  readonly name: string;
  readonly reason: string;
}

const FTS5_UNAVAILABLE =
  'optional dependency better-sqlite3 could not be loaded (missing package or native binding) — run `npm install` in tools/dp-gnosis to include this adapter';

export const isAvailable = (candidate: AdapterCandidate): boolean =>
  candidate.unavailableReason === undefined;

export const skippedOf = (candidates: readonly AdapterCandidate[]): readonly SkippedAdapter[] =>
  candidates
    .filter(candidate => candidate.unavailableReason !== undefined)
    .map(candidate => ({ name: candidate.name, reason: candidate.unavailableReason ?? '' }));

const fileSize = async (path: string): Promise<number> => {
  const info = await stat(path).catch(() => undefined);
  return info?.size ?? 0;
};

/** The reference line: no index at all, so `index` is a stated no-op of 0 bytes. */
export const linearScanCandidate = (): AdapterCandidate => ({
  name: 'linear-scan',
  index: () => Promise.resolve(0),
  open: location => createLinearScanAdapter(location.atomsDir),
});

type Fts5Module = typeof Fts5Namespace;

/** Lazy so a missing native binding SKIPS this adapter instead of throwing. */
const loadFts5 = async (): Promise<Fts5Module | undefined> =>
  await import('../adapters/fts5Adapter.js').catch(() => undefined);

const fts5From = (module: Fts5Module): AdapterCandidate => ({
  name: 'fts5',
  index: async (location: CorpusLocation): Promise<number> => {
    module.buildFts5Index(location);
    return await fileSize(location.indexPath);
  },
  open: (location: CorpusLocation): KnowledgePort =>
    module.createFts5Adapter({ ...location, now: new Date() }),
});

const fts5Unavailable = (): AdapterCandidate => ({
  name: 'fts5',
  unavailableReason: FTS5_UNAVAILABLE,
  index: () => Promise.resolve(0),
  open: (): KnowledgePort => {
    throw new Error(FTS5_UNAVAILABLE);
  },
});

export const fts5Candidate = async (): Promise<AdapterCandidate> => {
  const module = await loadFts5();
  return module === undefined ? fts5Unavailable() : fts5From(module);
};

/** Every adapter this package ships, available or not. */
export const defaultCandidates = async (): Promise<readonly AdapterCandidate[]> => [
  linearScanCandidate(),
  await fts5Candidate(),
];
