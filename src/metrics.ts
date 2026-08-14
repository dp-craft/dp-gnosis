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

/** The four reported measures, for one topic or averaged over topics. */
export interface Metrics {
  readonly ndcg10: number;
  readonly recall10: number;
  readonly recall100: number;
  readonly mrr10: number;
}

const NDCG_CUT = 10;
const MRR_CUT = 10;
const RECALL_10 = 10;
const RECALL_100 = 100;

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

export const recallAt = (ranking: readonly string[], qrel: Qrel, k: number): number => {
  const total = relevantCount(qrel);
  const hits = ranking.slice(0, k).filter(docId => (qrel.get(docId) ?? 0) > 0).length;
  return total === 0 ? 0 : hits / total;
};

export const reciprocalRankAt = (ranking: readonly string[], qrel: Qrel, k: number): number => {
  const first = ranking.slice(0, k).findIndex(docId => (qrel.get(docId) ?? 0) > 0);
  return first === -1 ? 0 : 1 / (first + 1);
};

/** All four measures for one topic's ranking. */
export const scoreTopic = (ranking: readonly string[], qrel: Qrel): Metrics => ({
  ndcg10: ndcgAt(ranking, qrel, NDCG_CUT),
  recall10: recallAt(ranking, qrel, RECALL_10),
  recall100: recallAt(ranking, qrel, RECALL_100),
  mrr10: reciprocalRankAt(ranking, qrel, MRR_CUT),
});

const meanOf = (values: readonly number[]): number =>
  values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;

/** Macro-average over every topic, including topics that retrieved nothing. */
export const meanMetrics = (perTopic: readonly Metrics[]): Metrics => ({
  ndcg10: meanOf(perTopic.map(m => m.ndcg10)),
  recall10: meanOf(perTopic.map(m => m.recall10)),
  recall100: meanOf(perTopic.map(m => m.recall100)),
  mrr10: meanOf(perTopic.map(m => m.mrr10)),
});
