import { describe, expect, it } from 'vitest';

import { meanMetrics, ndcgAt, recallAt, reciprocalRankAt, scoreTopic } from './metrics.js';

const qrel = new Map([
  ['a', 1],
  ['b', 1],
]);

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
    expect(scoreTopic(['x', 'y'], qrel)).toEqual({
      ndcg10: 0,
      recall10: 0,
      recall100: 0,
      mrr10: 0,
    });
  });

  it('averages over all topics, including the zero ones', () => {
    const perfect = scoreTopic(['a', 'b'], qrel);
    const empty = scoreTopic([], qrel);
    expect(meanMetrics([perfect, empty]).ndcg10).toBeCloseTo(0.5, 12);
  });
});
