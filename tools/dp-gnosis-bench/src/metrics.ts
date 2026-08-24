/**
 * IR metrics with `trec_eval` semantics.
 *
 * nDCG uses LINEAR gain (`gain = rel`) and the `ndcg_cut_10` normalizer: the
 * ideal DCG is taken from the top-`k` of the ideal ranking, not from the whole
 * qrels list. SciFact is binary, so linear and exponential gain coincide here;
 * linear is implemented because that is what `trec_eval` computes.
 *
 * A judgment absent from qrels counts as relevance 0 — `trec_eval`'s treatment
 * of unjudged documents. A topic that retrieves nothing relevant contributes 0
 * rather than being dropped, so the mean is over ALL topics.
 */

/** relevance grade per doc id, for one topic. */
export type Qrel = ReadonlyMap<string, number>;

/**
 * The reported measures, for one topic or averaged over topics.
 *
 * A recall cutoff DEEPER than the run's retrieval depth is not measurable: the
 * ranking was truncated at `depth`, so `recallAt(ranking, qrel, 300)` on a
 * depth-100 run returns recall@100 under a @300 label. Those cutoffs are
 * therefore `number | undefined` and carry `undefined` — never 0, which would
 * read as "measured, and nothing was found". EVERY cutoff obeys this, @10 and
 * @100 included: a `--depth 20` run recorded a `recall100` that was really R@20
 * under the wrong name until it did.
 */
export interface Metrics {
  readonly ndcg10: number;
  readonly recall10: number | undefined;
  /**
   * The HEAD of the reranked order a caller reads, not the reranker's input
   * bound: that pool is `RERANK_K_INIT` wide and has moved, so a document
   * anywhere in the pool is reachable and only the head is delivered.
   */
  readonly recall20: number | undefined;
  readonly recall100: number | undefined;
  readonly recall300: number | undefined;
  readonly recall1000: number | undefined;
  readonly mrr10: number;
  /** `|gold ∩ top-k| / k` — `pytrec_eval`'s `P_5` / `P_10`. */
  readonly precision5: number | undefined;
  readonly precision10: number | undefined;
  /**
   * SATURATING: 1 when the top-10 holds every gold document that COULD fit —
   * `min(R, 10)` of them — else 0. A topic with 36 gold documents is not
   * automatically a miss; the question is whether the caller got everything the
   * window can carry. `R === 0` is 0, the convention `recallAt` already states.
   */
  readonly allGoldInTop10: number | undefined;
  /**
   * Average precision over the WHOLE retrieved ranking, denominator `R`. Always
   * "AP at the run depth" — `depth` is a `SCALE_FIELD`, so a cross-depth
   * subtraction is refused by `compare.ts` rather than by an `undefined` here.
   */
  readonly map: number;
  /**
   * `P@R`. NOT measurable when `R > depth`: the ranking was truncated before
   * rank R, so the cutoff the measure names was never retrieved to.
   */
  readonly rPrecision: number | undefined;
  /**
   * Moffat–Zobel RBP residual at `p = 0.8` — the probability mass sitting on
   * ranks whose document is UNJUDGED, plus the tail past the ranking. A qrel
   * entry graded 0 is JUDGED and adds nothing: `readQrels` (`beir.ts`) keeps
   * grade-0 rows, so the distinction is real. Only the residual is recorded,
   * which makes it grade-independent by construction.
   */
  readonly rbpResidual: number;
}

const NDCG_CUT = 10;
const MRR_CUT = 10;
const RECALL_10 = 10;
const RECALL_20 = 20;
const RECALL_100 = 100;
const RECALL_300 = 300;
const RECALL_1000 = 1000;
const PRECISION_5 = 5;
const PRECISION_10 = 10;
const ALL_GOLD_CUT = 10;

/** Moffat–Zobel's persistence parameter — the caller's chance of reading on. */
const RBP_P = 0.8;

const discount = (rank: number): number => Math.log2(rank + 1);

const gainsOf = (ranking: readonly string[], qrel: Qrel): readonly number[] =>
  ranking.map(docId => qrel.get(docId) ?? 0);

const dcg = (gains: readonly number[]): number =>
  gains.reduce((sum, gain, index) => sum + gain / discount(index + 1), 0);

/** The ideal top-`k` ranking's gains: every graded doc, best first. */
const idealGains = (qrel: Qrel, k: number): readonly number[] =>
  [...qrel.values()].filter(gain => gain > 0).sort((a, b) => b - a).slice(0, k);

export const ndcgAt = (ranking: readonly string[], qrel: Qrel, k: number): number => {
  const ideal = dcg(idealGains(qrel, k));
  return ideal === 0 ? 0 : dcg(gainsOf(ranking.slice(0, k), qrel)) / ideal;
};

const relevantCount = (qrel: Qrel): number =>
  [...qrel.values()].filter(gain => gain > 0).length;

/** Unjudged reads as grade 0 — `trec_eval`'s treatment, applied everywhere here. */
const isRelevant = (qrel: Qrel, docId: string): boolean => (qrel.get(docId) ?? 0) > 0;

const hitsIn = (ranking: readonly string[], qrel: Qrel): number =>
  ranking.filter(docId => isRelevant(qrel, docId)).length;

export const recallAt = (ranking: readonly string[], qrel: Qrel, k: number): number => {
  const total = relevantCount(qrel);
  return total === 0 ? 0 : hitsIn(ranking.slice(0, k), qrel) / total;
};

export const reciprocalRankAt = (ranking: readonly string[], qrel: Qrel, k: number): number => {
  const first = ranking.slice(0, k).findIndex(docId => (qrel.get(docId) ?? 0) > 0);
  return first === -1 ? 0 : 1 / (first + 1);
};

/**
 * A cutoff the run never retrieved to is NOT measured. `recallAt` would happily
 * return the recall at the truncation point instead, which is the project's
 * recurring failure: a component produced nothing and the pipeline recorded it
 * as data.
 */
const measurableRecallAt = (
  ranking: readonly string[],
  qrel: Qrel,
  k: number,
  depth: number
): number | undefined => (k > depth ? undefined : recallAt(ranking, qrel, k));

/** Relevant documents in the top `k`, over `k` — unfilled ranks count against it. */
export const precisionAt = (ranking: readonly string[], qrel: Qrel, k: number): number =>
  k <= 0 ? 0 : hitsIn(ranking.slice(0, k), qrel) / k;

/** The same refusal `measurableRecallAt` makes, for a precision cutoff. */
const measurablePrecisionAt = (
  ranking: readonly string[],
  qrel: Qrel,
  k: number,
  depth: number
): number | undefined => (k > depth ? undefined : precisionAt(ranking, qrel, k));

/**
 * 1 when the top 10 holds every gold document that could fit in it. The bound is
 * `min(R, 10)`, not `R`: a topic with more gold than the window can carry would
 * otherwise be scored 0 for a shortfall no ranking can avoid.
 */
const allGoldInTop10Of = (
  ranking: readonly string[],
  qrel: Qrel,
  depth: number
): number | undefined => {
  if (ALL_GOLD_CUT > depth) return undefined;
  const total = relevantCount(qrel);
  const reachable = Math.min(total, ALL_GOLD_CUT);
  return total > 0 && hitsIn(ranking.slice(0, ALL_GOLD_CUT), qrel) === reachable ? 1 : 0;
};

/**
 * Average precision: the precision at each rank that holds a gold document,
 * averaged over `R`. A gold document the run never retrieved contributes 0,
 * which is what makes AP sensitive to recall as well as to order.
 */
export const averagePrecision = (ranking: readonly string[], qrel: Qrel): number => {
  const total = relevantCount(qrel);
  const sum = ranking.reduce(
    (acc, docId, index) =>
      isRelevant(qrel, docId) ? acc + precisionAt(ranking, qrel, index + 1) : acc,
    0
  );
  return total === 0 ? 0 : sum / total;
};

/** `P@R`; unmeasurable when the run was truncated before rank `R`. */
const rPrecisionOf = (
  ranking: readonly string[],
  qrel: Qrel,
  depth: number
): number | undefined => {
  const total = relevantCount(qrel);
  if (total === 0) return 0;
  return total > depth ? undefined : precisionAt(ranking, qrel, total);
};

/**
 * The RBP mass this run cannot account for: every rank whose document is absent
 * from the qrel map, plus the whole tail past the ranking's end. A document
 * graded 0 IS judged and contributes nothing.
 */
export const rbpResidualAt = (ranking: readonly string[], qrel: Qrel, p: number): number => {
  const unjudged = ranking.reduce(
    (acc, docId, index) => (qrel.has(docId) ? acc : acc + p ** index),
    0
  );
  return (1 - p) * unjudged + p ** ranking.length;
};

/** Every measure for one topic's ranking, at the depth the run retrieved to. */
export const scoreTopic = (ranking: readonly string[], qrel: Qrel, depth: number): Metrics => ({
  ndcg10: ndcgAt(ranking, qrel, NDCG_CUT),
  recall10: measurableRecallAt(ranking, qrel, RECALL_10, depth),
  recall20: measurableRecallAt(ranking, qrel, RECALL_20, depth),
  recall100: measurableRecallAt(ranking, qrel, RECALL_100, depth),
  recall300: measurableRecallAt(ranking, qrel, RECALL_300, depth),
  recall1000: measurableRecallAt(ranking, qrel, RECALL_1000, depth),
  mrr10: reciprocalRankAt(ranking, qrel, MRR_CUT),
  precision5: measurablePrecisionAt(ranking, qrel, PRECISION_5, depth),
  precision10: measurablePrecisionAt(ranking, qrel, PRECISION_10, depth),
  allGoldInTop10: allGoldInTop10Of(ranking, qrel, depth),
  map: averagePrecision(ranking, qrel),
  rPrecision: rPrecisionOf(ranking, qrel, depth),
  rbpResidual: rbpResidualAt(ranking, qrel, RBP_P),
});

const meanOf = (values: readonly number[]): number =>
  values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;

const isMeasured = (value: number | undefined): value is number => value !== undefined;

/**
 * Aggregate an unmeasurable-capable field. The depth is uniform across a run, so
 * a cutoff is either present on every topic or on none; a partially present one
 * still yields `undefined` rather than an average over a subset of topics.
 */
const aggregateOptional = (
  values: readonly (number | undefined)[],
  aggregate: (measured: readonly number[]) => number
): number | undefined => {
  const measured = values.filter(isMeasured);
  return measured.length === values.length ? aggregate(measured) : undefined;
};

/**
 * Aggregate a field whose measurability is PER TOPIC rather than per run:
 * `rPrecision`'s cutoff is the topic's own gold count, so one topic can exceed
 * the depth while its neighbours do not. All-or-nothing would discard the whole
 * measure for one deep topic, so this means over the measured subset — and the
 * subset size is recorded beside it (`rPrecisionTopics`) so the denominator is
 * never implicit. `undefined` only when NO topic was measurable.
 */
const aggregateMeasured = (
  values: readonly (number | undefined)[],
  aggregate: (measured: readonly number[]) => number
): number | undefined => {
  const measured = values.filter(isMeasured);
  return measured.length === 0 ? undefined : aggregate(measured);
};

/**
 * SAMPLE standard deviation (n-1) of the per-topic values — the spread of the
 * topics themselves, which is what a required-sample-size formula takes. A
 * standard error (sd/sqrt(n)) MUST NOT be recorded in its place: it shrinks with
 * the topic count and would understate the sample size a future run needs.
 *
 * A single topic has no sample sd; 0 is recorded rather than `NaN`.
 */
const sdOf = (values: readonly number[]): number => {
  if (values.length < 2) return 0;
  const mean = meanOf(values);
  const squares = values.map(value => (value - mean) ** 2);
  return Math.sqrt(squares.reduce((sum, square) => sum + square, 0) / (values.length - 1));
};

type Aggregate = (measured: readonly number[]) => number;

type RetrievalPart = Pick<
  Metrics,
  'ndcg10' | 'recall10' | 'recall20' | 'recall100' | 'recall300' | 'recall1000' | 'mrr10'
>;

type ConsumerPart = Omit<Metrics, keyof RetrievalPart>;

const aggregateRetrieval = (
  perTopic: readonly Metrics[],
  aggregate: Aggregate
): RetrievalPart => ({
  ndcg10: aggregate(perTopic.map(m => m.ndcg10)),
  recall10: aggregateOptional(perTopic.map(m => m.recall10), aggregate),
  recall20: aggregateOptional(perTopic.map(m => m.recall20), aggregate),
  recall100: aggregateOptional(perTopic.map(m => m.recall100), aggregate),
  recall300: aggregateOptional(perTopic.map(m => m.recall300), aggregate),
  recall1000: aggregateOptional(perTopic.map(m => m.recall1000), aggregate),
  mrr10: aggregate(perTopic.map(m => m.mrr10)),
});

const aggregateConsumer = (
  perTopic: readonly Metrics[],
  aggregate: Aggregate
): ConsumerPart => ({
  precision5: aggregateOptional(perTopic.map(m => m.precision5), aggregate),
  precision10: aggregateOptional(perTopic.map(m => m.precision10), aggregate),
  allGoldInTop10: aggregateOptional(perTopic.map(m => m.allGoldInTop10), aggregate),
  map: aggregate(perTopic.map(m => m.map)),
  rPrecision: aggregateMeasured(perTopic.map(m => m.rPrecision), aggregate),
  rbpResidual: aggregate(perTopic.map(m => m.rbpResidual)),
});

const aggregateMetrics = (perTopic: readonly Metrics[], aggregate: Aggregate): Metrics => ({
  ...aggregateRetrieval(perTopic, aggregate),
  ...aggregateConsumer(perTopic, aggregate),
});

/** Macro-average over every topic, including topics that retrieved nothing. */
export const meanMetrics = (perTopic: readonly Metrics[]): Metrics =>
  aggregateMetrics(perTopic, meanOf);

/** The per-topic spread of each measure, alongside `meanMetrics`. */
export const sdMetrics = (perTopic: readonly Metrics[]): Metrics =>
  aggregateMetrics(perTopic, sdOf);

/**
 * How many topics `rPrecision` was actually measured on — the denominator behind
 * the mean `aggregateMeasured` produces. Recorded next to the run (NOT on
 * `Metrics`, whose keys are the pairable metric names) so a reader can see that
 * an R-Precision mean covers a SUBSET of the topics.
 */
export const rPrecisionTopics = (perTopic: readonly Metrics[]): number =>
  perTopic.filter(m => isMeasured(m.rPrecision)).length;
