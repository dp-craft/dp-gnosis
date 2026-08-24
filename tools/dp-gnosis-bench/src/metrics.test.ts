import { describe, expect, it } from 'vitest';

import {
  meanMetrics,
  ndcgAt,
  recallAt,
  reciprocalRankAt,
  rPrecisionTopics,
  scoreTopic,
  sdMetrics
} from './metrics.js';

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
      precision5: 0,
      precision10: 0,
      allGoldInTop10: 0,
      map: 0,
      rPrecision: 0,
      // both retrieved ids are UNJUDGED, so the whole ranking is residual mass:
      // 0.2*(0.8^0 + 0.8^1) + 0.8^2 = 0.36 + 0.64 = 1
      rbpResidual: 1,
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

/** `a` at rank 1, an unjudged doc at rank 2, `b` at rank 3 — two gold of two. */
const MIXED_RANKING: readonly string[] = ['a', 'x', 'b'];

describe('P@5 / P@10 — what fraction of the window the caller reads is gold', () => {
  it('divides by k, not by the gold count: two gold in the top 5 is 0.4', () => {
    const topic = scoreTopic(MIXED_RANKING, qrel, DEPTH_100);
    expect(topic.precision5).toBeCloseTo(2 / 5, 12);
    expect(topic.precision10).toBeCloseTo(2 / 10, 12);
  });

  it('refuses a cutoff deeper than the run retrieved to', () => {
    const topic = scoreTopic(MIXED_RANKING, qrel, 5);
    expect(topic.precision5).toBeCloseTo(2 / 5, 12);
    expect(topic.precision10).toBeUndefined();
  });
});

/** Twelve gold documents — more than the top-10 window can ever hold. */
const twelveGold = new Map(
  Array.from({ length: 12 }, (_unused, i) => [`g${i}`, 1] as const)
);

const goldRanking = (count: number): readonly string[] => [
  ...Array.from({ length: count }, (_unused, i) => `g${i}`),
  ...Array.from({ length: 10 - count }, (_unused, i) => `x${i}`),
];

describe('allGoldInTop10 SATURATES at what the window can hold', () => {
  it('is 1 when a 12-gold topic fills the top 10 with gold', () => {
    expect(scoreTopic(goldRanking(10), twelveGold, DEPTH_100).allGoldInTop10).toBe(1);
  });

  it('is 0 when one of the ten reachable gold documents is missing', () => {
    expect(scoreTopic(goldRanking(9), twelveGold, DEPTH_100).allGoldInTop10).toBe(0);
  });

  it('is 1 for a 2-gold topic that retrieved both, and 0 when it missed one', () => {
    expect(scoreTopic(['a', 'b'], qrel, DEPTH_100).allGoldInTop10).toBe(1);
    expect(scoreTopic(['a', 'x'], qrel, DEPTH_100).allGoldInTop10).toBe(0);
  });

  it('is 0 on an empty qrel, the convention recallAt already states', () => {
    expect(scoreTopic(['a'], new Map(), DEPTH_100).allGoldInTop10).toBe(0);
  });

  it('is not measurable below depth 10', () => {
    expect(scoreTopic(['a', 'b'], qrel, 5).allGoldInTop10).toBeUndefined();
  });
});

describe('MAP — average precision over the whole retrieved ranking', () => {
  it('averages the precision at each gold rank over the gold COUNT', () => {
    // gold at ranks 1 and 3 → (1/1 + 2/3) / 2
    expect(scoreTopic(MIXED_RANKING, qrel, DEPTH_100).map).toBeCloseTo((1 + 2 / 3) / 2, 12);
  });

  it('charges a gold document the run never retrieved as 0', () => {
    expect(scoreTopic(['a'], qrel, DEPTH_100).map).toBeCloseTo(0.5, 12);
  });

  it('is 0 on an empty qrel', () => {
    expect(scoreTopic(['a'], new Map(), DEPTH_100).map).toBe(0);
  });
});

describe('R-Precision — P@R, and unmeasurable when R is past the truncation', () => {
  it('is P@2 for a 2-gold topic', () => {
    expect(scoreTopic(MIXED_RANKING, qrel, DEPTH_100).rPrecision).toBeCloseTo(0.5, 12);
  });

  it('is undefined when R exceeds the run depth — the ranking was cut before rank R', () => {
    expect(scoreTopic(goldRanking(10), twelveGold, 10).rPrecision).toBeUndefined();
    expect(scoreTopic(goldRanking(10), twelveGold, 12).rPrecision).toBeCloseTo(10 / 12, 12);
  });

  it('is 0 on an empty qrel', () => {
    expect(scoreTopic(['a'], new Map(), DEPTH_100).rPrecision).toBe(0);
  });

  it('means over the MEASURED topics only, and reports how many there were', () => {
    const measured = scoreTopic(MIXED_RANKING, qrel, DEPTH_100);
    const unmeasured = scoreTopic(goldRanking(10), twelveGold, 10);
    expect(meanMetrics([measured, unmeasured]).rPrecision).toBeCloseTo(0.5, 12);
    expect(rPrecisionTopics([measured, unmeasured])).toBe(1);
    expect(rPrecisionTopics([unmeasured, unmeasured])).toBe(0);
  });
});

describe('RBP residual at p=0.8 — how much of the measured mass is UNJUDGED', () => {
  it('counts an id absent from the qrel map, plus the tail past the ranking', () => {
    // rank 2 is unjudged: 0.2 * 0.8^1 + 0.8^3
    expect(scoreTopic(MIXED_RANKING, qrel, DEPTH_100).rbpResidual).toBeCloseTo(
      0.2 * 0.8 + 0.8 ** 3,
      12
    );
  });

  it('treats a qrel entry GRADED 0 as judged — it adds nothing to the residual', () => {
    const graded = new Map([['a', 1], ['x', 0], ['b', 1]]);
    expect(scoreTopic(MIXED_RANKING, graded, DEPTH_100).rbpResidual).toBeCloseTo(0.8 ** 3, 12);
  });

  it('is 1 when nothing was retrieved at all', () => {
    expect(scoreTopic([], qrel, DEPTH_100).rbpResidual).toBe(1);
  });
});

describe('G10 — R@10 and R@100 are cutoffs like every other', () => {
  it('reports recall100 as undefined on a depth-20 run instead of R@20 under its name', () => {
    const topic = scoreTopic(['a'], qrel, 20);
    expect(topic.recall10).toBeCloseTo(0.5, 12);
    expect(topic.recall20).toBeCloseTo(0.5, 12);
    expect(topic.recall100).toBeUndefined();
  });

  it('reports recall10 as undefined on a depth-5 run', () => {
    expect(scoreTopic(['a'], qrel, 5).recall10).toBeUndefined();
  });

  it('propagates the absent cutoff through the mean and the sd', () => {
    const perTopic = [scoreTopic(['a'], qrel, 20), scoreTopic(['b'], qrel, 20)];
    expect(meanMetrics(perTopic).recall100).toBeUndefined();
    expect(sdMetrics(perTopic).recall100).toBeUndefined();
    expect(meanMetrics(perTopic).recall10).toBeCloseTo(0.5, 12);
  });
});
