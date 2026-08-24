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
 * 1. The document ids come from EVERY entry of `originPaths`, each taken as its
 *    basename — the file `materializeCorpus` wrote, named `<docid>.md`. An atom
 *    speaks for more than one document whenever ingest merged the provenance of
 *    a byte-identical duplicate group into it, and crediting only the first
 *    would book every merged twin as a document no atom claims. `atom.id` MUST
 *    NOT be used: `baseIdOf` slugifies it (`MED-10` → `med-10`) and appends a
 *    SHA1 fragment on collision, so it cannot be mapped back to a qrels key.
 * 2. Dedupe keeps the FIRST occurrence. Rank position IS the measurement; a
 *    later atom from an already-seen document adds nothing but would push every
 *    following document down if it were kept.
 *
 * `excludedIds` exists because BRIGHT ships per-query exclusions. Scoring a
 * document the dataset told us to drop makes the number wrong in both
 * directions — it can occupy a rank and it can never be credited.
 *
 * The rollup is stated ONCE (`rankedDocuments`) and read through two
 * projections: the ids that get scored (`toDocumentRanking`) and the scores the
 * representing atoms carried (`documentScores`). A second implementation of the
 * dedupe would let an id and a score describe different atoms the moment a
 * rerank reorders — which is unobservable in the metrics, since every metric
 * here is rank-based.
 */
import { basename } from 'node:path';

import type { TopicFacets } from './beir.js';
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

/**
 * The score fields of `RetrievedAtom`, on top of the origin the rollup needs.
 * Structural for the same reason `RankedAtom` is.
 *
 * `score` is the number that PRODUCED the order it sits in — the first-pass
 * score on a BM25 run, the FUSED score on a reranked one. The other two are set
 * only on a reranked run (`port.ts`), and an atom the reranker never returned
 * carries no `rerankScore` at all: that is a fact about the atom, not a zero.
 */
export interface ScoredAtom extends RankedAtom {
  readonly score: number;
  readonly firstPassScore?: number;
  readonly rerankScore?: number;
}

/**
 * How many DISTINCT documents the consumer's top slots hold, measured on the
 * SERVED ATOM order — before the document rollup dedupes it away. These are
 * PRESENTATION-diversity counts, not IR measures: no qrels enter, nothing here
 * says a slot was well spent. They exist because an ingest dedupe or a
 * per-document cap moves them and moves NOTHING the document-level metrics see.
 *
 * A cutoff the served list never filled is `undefined`, never 0 and never a
 * short-window count — the window was not measurable, exactly as an unreachable
 * recall cutoff is recorded absent rather than as the value at the truncation
 * point.
 */
export interface AtomSpread {
  readonly distinctDocs5: number | undefined;
  readonly distinctDocs10: number | undefined;
  /**
   * Maximal contiguous same-document runs in the first 10 atoms — `A A B A` is
   * three. Always `>= distinctDocs10` when both are defined, and equal to it
   * exactly when every document's atoms are contiguous, so the gap between the
   * two IS the interleaving.
   */
  readonly sameDocRuns10: number | undefined;
}

/** One topic's outcome, kept per-query so the per-topic TSV can be written. */
export interface TopicScore {
  readonly queryId: string;
  readonly metrics: Metrics;
  /** Absent on a run that measured no spread — a sweep cell records none. */
  readonly spread?: AtomSpread | undefined;
  /**
   * The authored REPORTING facets of this topic, absent on every dataset that
   * authors none. They ride ALONGSIDE the score and enter no metric: attaching
   * them leaves `metrics`, the macro mean and the sd byte-identical.
   */
  readonly facets?: TopicFacets | undefined;
}

/**
 * One axis's DESCRIPTIVE stratum — the mean of the headline measures over the
 * topics that carry that axis, and how many topics that is.
 *
 * DESCRIPTIVE ONLY. A stratum is a handful of topics, far below the corpus-wide
 * MDE, so no p-value, interval or verdict is computed for it here and none may
 * be added: a per-axis delta is a shape to look at, never a result to quote. The
 * headline stays the macro mean over ALL topics.
 */
export interface AxisStratum {
  readonly axis: string;
  readonly topics: number;
  readonly ndcg10: number;
  readonly recall10: number | undefined;
  readonly recall100: number | undefined;
  readonly mrr10: number;
}

/** A topic with no authored facets keeps the field ABSENT, never present-undefined. */
const withFacets = (score: TopicScore, facets: TopicFacets | undefined): TopicScore =>
  facets === undefined ? score : { ...score, facets };

/**
 * Attach the authored facets to the scored topics. Deliberately OUTSIDE
 * `scoreDataset`: the facets decorate a score and must be unable to move one,
 * and a caller that measured none (the sweep) is byte-identical to one that did.
 */
export const withTopicFacets = (
  perTopic: readonly TopicScore[],
  facetsByQuery: ReadonlyMap<string, TopicFacets>
): readonly TopicScore[] =>
  perTopic.map(score => withFacets(score, facetsByQuery.get(score.queryId)));

const axisOf = (score: TopicScore): string | undefined => score.facets?.axis;

const byAxis = (perTopic: readonly TopicScore[]): ReadonlyMap<string, readonly Metrics[]> =>
  perTopic.reduce((groups, score) => {
    const axis = axisOf(score);
    return axis === undefined ? groups : groups.set(axis, [...(groups.get(axis) ?? []), score.metrics]);
  }, new Map<string, readonly Metrics[]>());

const stratumOf = (axis: string, metrics: readonly Metrics[]): AxisStratum => {
  const mean = meanMetrics(metrics);
  return {
    axis,
    topics: metrics.length,
    ndcg10: mean.ndcg10,
    recall10: mean.recall10,
    recall100: mean.recall100,
    mrr10: mean.mrr10,
  };
};

/** Largest stratum first, then by axis name — a stable order for a rendered table. */
const bySize = (a: AxisStratum, b: AxisStratum): number =>
  b.topics - a.topics || (a.axis < b.axis ? -1 : 1);

/**
 * The per-axis means, or an EMPTY list when no topic carries an axis — an empty
 * list renders no section, where a single catch-all bucket would read as a
 * stratum the author never wrote.
 */
export const perAxisStrata = (perTopic: readonly TopicScore[]): readonly AxisStratum[] =>
  [...byAxis(perTopic)].map(([axis, metrics]) => stratumOf(axis, metrics)).sort(bySize);

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

/** An atom with no `sources` frontmatter has no document — it contributes none. */
const originDocIds = (atom: RankedAtom): readonly string[] =>
  atom.originPaths.map(origin => basename(origin, MARKDOWN_EXT));

/**
 * One document and the ATOM that put it there — the atom occupying that rank.
 * The pair travels together so a projection can never read an id from one list
 * and a score from another.
 */
interface RolledDocument<A extends RankedAtom> {
  readonly docId: string;
  readonly atom: A;
}

/**
 * One atom → one entry per document it speaks for, in `originPaths` order. A
 * merged atom therefore occupies consecutive positions, which is exactly what it
 * earned: one retrieval reached all of them.
 */
const rolledOf = <A extends RankedAtom>(atom: A): readonly RolledDocument<A>[] =>
  originDocIds(atom).map(docId => ({ docId, atom }));

/**
 * Atom order → documents, WITHOUT the dedupe: expand, drop excluded. Shared with
 * `atomSpread` so the two can never disagree about which atoms are in the
 * ranking.
 */
const mappedDocuments = <A extends RankedAtom>(
  atoms: readonly A[],
  excludedIds: readonly string[]
): readonly RolledDocument<A>[] => {
  const excluded = new Set(excludedIds);
  return atoms.flatMap(rolledOf).filter(entry => !excluded.has(entry.docId));
};

/** THE rollup: map, drop excluded, dedupe keeping the first. Projected, never copied. */
const rankedDocuments = <A extends RankedAtom>(
  atoms: readonly A[],
  excludedIds: readonly string[]
): readonly RolledDocument<A>[] => {
  const mapped = mappedDocuments(atoms, excludedIds);
  const docIds = mapped.map(entry => entry.docId);
  return mapped.filter((entry, index) => docIds.indexOf(entry.docId) === index);
};

/** Atom order → document order: the rollup, projected to the ids that get scored. */
export const toDocumentRanking = (
  atoms: readonly RankedAtom[],
  excludedIds: readonly string[] = []
): readonly string[] => rankedDocuments(atoms, excludedIds).map(entry => entry.docId);

/**
 * One document's place in the ranking and what it scored there — the rollup's
 * SECOND projection, entry for entry with `toDocumentRanking`.
 *
 * It exists because the rollup is where the numbers were lost. Every metric here
 * is rank-based, so nothing downstream ever needed a score, and the recorded
 * `.trec` writes a deliberately RANK-DERIVED score column (`report.ts`) so an
 * evaluator's re-sort cannot alter the measured order. Between them no recorded
 * artefact carried what the retrieval actually scored, and any score-distribution
 * question — query-performance prediction, score decay, calibration — cost a
 * full re-run of the benchmark to ask.
 *
 * Rank is the ARRAY POSITION: it is the rollup's own order, and a stored copy
 * beside the entry is one more thing that can disagree with it.
 */
export interface DocumentScore {
  readonly docId: string;
  // Deliberately NOT reusing `ScoredAtom`'s fields: this is a recorded FILE
  // FORMAT, and sharing them would let a new field on the atom silently add a
  // column to every future scores TSV.

  readonly score: number;
  readonly firstPassScore?: number;
  readonly rerankScore?: number;
}

/** An absent rerank field stays ABSENT, never present-undefined. */
const documentScoreOf = (entry: RolledDocument<ScoredAtom>): DocumentScore => ({
  docId: entry.docId,
  score: entry.atom.score,
  ...(entry.atom.firstPassScore === undefined
    ? {}
    : { firstPassScore: entry.atom.firstPassScore }),
  ...(entry.atom.rerankScore === undefined ? {} : { rerankScore: entry.atom.rerankScore }),
});

/** The ranking's scores — same atoms, same exclusions, same rollup, other projection. */
export const documentScores = (
  atoms: readonly ScoredAtom[],
  excludedIds: readonly string[] = []
): readonly DocumentScore[] => rankedDocuments(atoms, excludedIds).map(documentScoreOf);

const SPREAD_5 = 5;
const SPREAD_10 = 10;

/** Distinct documents in the first `k` atoms — absent when there are fewer. */
const distinctDocsAt = (docIds: readonly string[], k: number): number | undefined =>
  docIds.length < k ? undefined : new Set(docIds.slice(0, k)).size;

/** A run STARTS wherever the doc id differs from its predecessor. */
const sameDocRunsAt = (docIds: readonly string[], k: number): number | undefined =>
  docIds.length < k
    ? undefined
    : docIds.slice(0, k).filter((docId, index, window) => window[index - 1] !== docId).length;

/** The served atom order's document spread — the dedupe's blind spot, measured. */
export const atomSpread = (
  atoms: readonly RankedAtom[],
  excludedIds: readonly string[] = []
): AtomSpread => {
  const docIds = mappedDocuments(atoms, excludedIds).map(entry => entry.docId);
  return {
    distinctDocs5: distinctDocsAt(docIds, SPREAD_5),
    distinctDocs10: distinctDocsAt(docIds, SPREAD_10),
    sameDocRuns10: sameDocRunsAt(docIds, SPREAD_10),
  };
};

/** A topic with no spread entry keeps the field ABSENT, never present-undefined. */
const withSpread = (score: TopicScore, spread: AtomSpread | undefined): TopicScore =>
  spread === undefined ? score : { ...score, spread };

/**
 * Score one dataset. The mean is over EVERY topic that was run, including those
 * that retrieved nothing relevant — dropping them would flatter the run.
 *
 * `depth` is the run's retrieval depth, and it is REQUIRED: the rankings were
 * truncated to it (`run.ts`), so a recall cutoff above it cannot be measured and
 * must be recorded as absent rather than as the recall at the truncation point.
 *
 * `spreadByQuery` is OPTIONAL and touches no number: it only rides the
 * presentation counts through to the per-topic TSV. A caller that measured none
 * (the sweep) scores byte-identically to one that did.
 */
export const scoreDataset = (
  rankingsByQuery: ReadonlyMap<string, readonly string[]>,
  qrels: ReadonlyMap<string, Qrel>,
  depth: number,
  spreadByQuery?: ReadonlyMap<string, AtomSpread>
): DatasetScore => {
  const perTopic = [...rankingsByQuery].map(([queryId, ranking]) =>
    withSpread(
      {
        queryId,
        metrics: scoreTopic(ranking, qrels.get(queryId) ?? EMPTY_QREL, depth),
      },
      spreadByQuery?.get(queryId)
    )
  );
  const metrics = perTopic.map(topic => topic.metrics);
  return {
    perTopic,
    mean: meanMetrics(metrics),
    sd: sdMetrics(metrics),
    rPrecisionTopics: rPrecisionTopics(metrics),
  };
};
