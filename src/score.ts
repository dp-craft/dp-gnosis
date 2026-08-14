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

import { meanMetrics, type Metrics, type Qrel, scoreTopic } from './metrics.js';

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

/** Every topic's score plus the macro mean over all of them. */
export interface DatasetScore {
  readonly perTopic: readonly TopicScore[];
  readonly mean: Metrics;
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
 */
export const scoreDataset = (
  rankingsByQuery: ReadonlyMap<string, readonly string[]>,
  qrels: ReadonlyMap<string, Qrel>
): DatasetScore => {
  const perTopic = [...rankingsByQuery].map(([queryId, ranking]) => ({
    queryId,
    metrics: scoreTopic(ranking, qrels.get(queryId) ?? EMPTY_QREL),
  }));
  return { perTopic, mean: meanMetrics(perTopic.map(topic => topic.metrics)) };
};
