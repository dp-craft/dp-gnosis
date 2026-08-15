import { describe, expect, it } from 'vitest';

import { meanMetrics, ndcgAt, recallAt, reciprocalRankAt, scoreTopic, sdMetrics } from './metrics.js';

const qrel = new Map([
  ['a', 1],
  ['b', 1],
]);

/** The depth a default run retrieves to — every cutoff at or below it is measurable. */
const DEPTH_100 = 100;

describe('trec_eval semantics', () => {
  it('nDCG@10 discounts by log2(rank+1) and normalizes by the top-10 ideal DCG', () => {
    // relevant at ranks 2 and 3 → DCG = 1/log2(3) + 1/log2(4)
    // ideal top-10 = two relevant at ranks 1,2 → 1/log2(2) + 1/log2(3)
    const dcg = 1 / Math.log2(3) + 1 / Math.log2(4);
    const idcg = 1 / Math.log2(2) + 1 / Math.log2(3);
    expect(ndcgAt(['x', 'a', 'b'], qrel, 10)).toBeCloseTo(dcg / idcg, 12);
  });

  it('caps the ideal DCG at k, so a topic with more relevant docs than k can still reach 1', () => {
    const many = new Map([['a', 1], ['b', 1], ['c', 1]]);
    expect(ndcgAt(['a', 'b'], many, 2)).toBeCloseTo(1, 12);
  });

  it('treats an unjudged document as relevance 0', () => {
    expect(recallAt(['unjudged', 'a'], qrel, 10)).toBeCloseTo(0.5, 12);
  });

  it('reciprocal rank is 0 when the first relevant doc falls outside the cut', () => {
    const ranking = [...Array.from({ length: 10 }, (_, i) => `x${i}`), 'a'];
    expect(reciprocalRankAt(ranking, qrel, 10)).toBe(0);
    expect(reciprocalRankAt(ranking, qrel, 11)).toBeCloseTo(1 / 11, 12);
  });

  it('scores a topic that retrieved nothing relevant as 0 on every measure', () => {
    expect(scoreTopic(['x', 'y'], qrel, DEPTH_100)).toEqual({
      ndcg10: 0,
      recall10: 0,
      recall20: 0,
      recall100: 0,
      recall300: undefined,
      recall1000: undefined,
      mrr10: 0,
    });
  });

  it('averages over all topics, including the zero ones', () => {
    const perfect = scoreTopic(['a', 'b'], qrel, DEPTH_100);
    const empty = scoreTopic([], qrel, DEPTH_100);
    expect(meanMetrics([perfect, empty]).ndcg10).toBeCloseTo(0.5, 12);
  });
});

/** A gold document at rank 15: inside the @20 cut, outside the @10 one. */
const rankedAt = (position: number): readonly string[] => [
  ...Array.from({ length: position - 1 }, (_unused, i) => `x${i}`),
  'a',
];

describe('recall@20 — the reranker reads RERANK_K_INIT=20 candidates', () => {
  it('credits a gold document at rank 15, which recall@10 misses', () => {
    const topic = scoreTopic(rankedAt(15), qrel, DEPTH_100);
    expect(topic.recall10).toBe(0);
    expect(topic.recall20).toBeCloseTo(0.5, 12);
  });

  it('is measurable at exactly depth 20, and refuses below it', () => {
    expect(scoreTopic(rankedAt(15), qrel, 20).recall20).toBeCloseTo(0.5, 12);
    expect(scoreTopic(rankedAt(15), qrel, 10).recall20).toBeUndefined();
  });
});

describe('a cutoff deeper than the run retrieved is NOT a measurement', () => {
  it('reports undefined — never 0, and never recall@depth under a @300 label', () => {
    const topic = scoreTopic(['a', 'b'], qrel, DEPTH_100);
    expect(topic.recall100).toBe(1);
    expect(topic.recall300).toBeUndefined();
    expect(topic.recall1000).toBeUndefined();
  });

  it('measures @300 and @1000 once the run retrieved that deep', () => {
    const topic = scoreTopic(['a', 'b'], qrel, 1000);
    expect(topic.recall300).toBe(1);
    expect(topic.recall1000).toBe(1);
  });

  it('propagates undefined through the mean and the sd rather than averaging in a 0', () => {
    const perTopic = [scoreTopic(['a'], qrel, DEPTH_100), scoreTopic(['b'], qrel, DEPTH_100)];
    expect(meanMetrics(perTopic).recall20).toBeCloseTo(0.5, 12);
    expect(meanMetrics(perTopic).recall300).toBeUndefined();
    expect(sdMetrics(perTopic).recall20).toBe(0);
    expect(sdMetrics(perTopic).recall1000).toBeUndefined();
  });
});
