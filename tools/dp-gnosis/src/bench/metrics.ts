/**
 * Retrieval quality metrics: recall@k and MRR.
 *
 * Pure and separated from every adapter on purpose — these are validated
 * against the fake adapter (`adapters/fakeAdapter.ts`), whose ranking is fixed
 * and therefore hand-computable. Without that separation a metrics bug and a
 * ranking bug are indistinguishable the first time real numbers land.
 *
 * A query that declares NO relevant atoms scores `undefined`, never 0: there is
 * no denominator, and folding it in as a zero would silently drag both averages
 * down while looking like measured evidence. Such queries are counted as
 * `unscorableQueries` in the aggregate so they can never vanish quietly.
 */
import type { GoldenQuery } from '../goldenSet.js';

/** One query's score against one adapter. */
export interface QueryMetric {
  readonly queryId: string;
  readonly axis: string;
  readonly retrievedCount: number;
  /** `undefined` when the query declares no relevant atoms — NOT 0. */
  readonly recall: number | undefined;
  /** Reciprocal of the FIRST relevant hit's 1-based rank; 0 when none hit. */
  readonly reciprocalRank: number | undefined;
}

/** The averaged view over one adapter × one corpus. */
export interface QueryAggregate {
  readonly k: number;
  readonly recallAtK: number | undefined;
  readonly mrr: number | undefined;
  readonly scoredQueries: number;
  readonly unscorableQueries: number;
}

const definedOnly = (values: readonly (number | undefined)[]): readonly number[] =>
  values.filter((value): value is number => value !== undefined);

/** Arithmetic mean over the defined values; `undefined` when none are defined. */
export const mean = (values: readonly (number | undefined)[]): number | undefined => {
  const defined = definedOnly(values);
  return defined.length === 0
    ? undefined
    : defined.reduce((sum, value) => sum + value, 0) / defined.length;
};

/**
 * Fraction of the relevant atoms that appear in the first `k` results.
 * `undefined` when the query has no relevant atoms — the zero-denominator case.
 */
export const recallAtK = (
  retrievedIds: readonly string[],
  relevantIds: readonly string[],
  k: number
): number | undefined => {
  const relevant = new Set(relevantIds);
  const hits = retrievedIds.slice(0, k).filter(id => relevant.has(id)).length;
  return relevant.size === 0 ? undefined : hits / relevant.size;
};

/**
 * `1 / rank` of the FIRST relevant hit (1-based), 0 when no relevant atom is
 * retrieved. Later hits are irrelevant by definition — MRR asks only how far a
 * reader must scan before the first useful result.
 */
export const reciprocalRank = (
  retrievedIds: readonly string[],
  relevantIds: readonly string[]
): number | undefined => {
  const relevant = new Set(relevantIds);
  const index = retrievedIds.findIndex(id => relevant.has(id));
  return relevant.size === 0 ? undefined : index === -1 ? 0 : 1 / (index + 1);
};

/** Score one golden query against the ids an adapter returned, in rank order. */
export const scoreQuery = (
  query: GoldenQuery,
  retrievedIds: readonly string[],
  k: number
): QueryMetric => ({
  queryId: query.id,
  axis: query.axis,
  retrievedCount: retrievedIds.length,
  recall: recallAtK(retrievedIds, query.relevantAtomIds, k),
  reciprocalRank: reciprocalRank(retrievedIds, query.relevantAtomIds),
});

/** Average the per-query scores, reporting how many were unscorable. */
export const aggregate = (k: number, metrics: readonly QueryMetric[]): QueryAggregate => ({
  k,
  recallAtK: mean(metrics.map(metric => metric.recall)),
  mrr: mean(metrics.map(metric => metric.reciprocalRank)),
  scoredQueries: definedOnly(metrics.map(metric => metric.recall)).length,
  unscorableQueries: metrics.filter(metric => metric.recall === undefined).length,
});
