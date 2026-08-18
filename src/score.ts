/**
 * Atom ranking → DOCUMENT ranking → metrics.
 *
 * This is the layer that makes the numbers survive a chunker change. The engine
 * ranks atoms, and an atom is not a stable unit: commit `0ee258ea` altered atom
 * ids and silently put the before/after nDCG numbers on different scales. The
 * dataset's qrels are document-level, so the ranking is rolled up to documents
 * before it is scored, and a corpus cut into more (or fewer) atoms is still
 * measured on the same scale.
 *
 * Two rules, both load-bearing:
 *
 * 1. The document id comes from `originPaths[0]`'s basename — the file
 *    `materializeCorpus` wrote, named `<docid>.md`. `atom.id` MUST NOT be used:
 *    `baseIdOf` slugifies it (`MED-10` → `med-10`) and appends a SHA1 fragment
 *    on collision, so it cannot be mapped back to a qrels key.
 * 2. Dedupe keeps the FIRST occurrence. Rank position IS the measurement; a
 *    later atom from an already-seen document adds nothing but would push every
 *    following document down if it were kept.
 *
 * `excludedIds` exists because BRIGHT ships per-query exclusions. Scoring a
 * document the dataset told us to drop makes the number wrong in both
 * directions — it can occupy a rank and it can never be credited.
 */
import { basename } from 'node:path';

import {
  meanMetrics,
  type Metrics,
  type Qrel,
  rPrecisionTopics,
  scoreTopic,
  sdMetrics
} from './metrics.js';

const MARKDOWN_EXT = '.md';

/** A topic with no qrels row: every document is unjudged, so every measure is 0. */
const EMPTY_QREL: Qrel = new Map<string, number>();

/**
 * The only part of `RetrievedAtom` this layer reads. Structural so a test can
 * state a ranking without staging an index.
 */
export interface RankedAtom {
  readonly originPaths: readonly string[];
}

/** One topic's outcome, kept per-query so the per-topic TSV can be written. */
export interface TopicScore {
  readonly queryId: string;
  readonly metrics: Metrics;
}

/** Every topic's score, the macro mean, and the per-topic spread around it. */
export interface DatasetScore {
  readonly perTopic: readonly TopicScore[];
  readonly mean: Metrics;
  /** Sample sd (n-1) of the per-topic values — the sample-size input. */
  readonly sd: Metrics;
  /**
   * How many topics R-Precision was measurable on. Its cutoff is `R`, the
   * topic's own gold count, so a deep topic can exceed the run depth while its
   * neighbours do not — the mean is over this subset, and the subset size
   * travels with it so the denominator is never implicit.
   */
  readonly rPrecisionTopics: number;
}

/** An atom with no `sources` frontmatter has no document — it is skipped. */
const originDocId = (atom: RankedAtom): string | undefined => {
  const origin = atom.originPaths[0];
  return origin === undefined ? undefined : basename(origin, MARKDOWN_EXT);
};

const isPresent = (value: string | undefined): value is string => value !== undefined;

/** Atom order → document order: map, drop excluded, dedupe keeping the first. */
export const toDocumentRanking = (
  atoms: readonly RankedAtom[],
  excludedIds: readonly string[] = []
): readonly string[] => {
  const excluded = new Set(excludedIds);
  const docIds = atoms
    .map(originDocId)
    .filter(isPresent)
    .filter(docId => !excluded.has(docId));
  return docIds.filter((docId, index) => docIds.indexOf(docId) === index);
};

/**
 * Score one dataset. The mean is over EVERY topic that was run, including those
 * that retrieved nothing relevant — dropping them would flatter the run.
 *
 * `depth` is the run's retrieval depth, and it is REQUIRED: the rankings were
 * truncated to it (`run.ts`), so a recall cutoff above it cannot be measured and
 * must be recorded as absent rather than as the recall at the truncation point.
 */
export const scoreDataset = (
  rankingsByQuery: ReadonlyMap<string, readonly string[]>,
  qrels: ReadonlyMap<string, Qrel>,
  depth: number
): DatasetScore => {
  const perTopic = [...rankingsByQuery].map(([queryId, ranking]) => ({
    queryId,
    metrics: scoreTopic(ranking, qrels.get(queryId) ?? EMPTY_QREL, depth),
  }));
  const metrics = perTopic.map(topic => topic.metrics);
  return {
    perTopic,
    mean: meanMetrics(metrics),
    sd: sdMetrics(metrics),
    rPrecisionTopics: rPrecisionTopics(metrics),
  };
};
