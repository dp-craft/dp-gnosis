import { describe, expect, it } from 'vitest';

import type { Metrics, Qrel } from './metrics.js';
import {
  atomSpread,
  documentScores,
  perAxisStrata,
  scoreDataset,
  type ScoredAtom,
  toDocumentRanking,
  type TopicScore,
  withTopicFacets
} from './score.js';

const atom = (...originPaths: string[]): { readonly originPaths: readonly string[] } => ({
  originPaths,
});

describe('toDocumentRanking', () => {
  it('maps an atom to its ORIGIN document id — the basename, never the atom id', () => {
    expect(toDocumentRanking([atom('docs/MED-10.md'), atom('docs/4983.md')])).toEqual([
      'MED-10',
      '4983',
    ]);
  });

  it('dedupes keeping the FIRST occurrence, because rank order is the measurement', () => {
    const atoms = [atom('docs/a.md'), atom('docs/b.md'), atom('docs/a.md'), atom('docs/c.md')];
    expect(toDocumentRanking(atoms)).toEqual(['a', 'b', 'c']);
  });

  it('removes excluded ids before scoring', () => {
    const atoms = [atom('docs/a.md'), atom('docs/b.md'), atom('docs/c.md')];
    expect(toDocumentRanking(atoms, ['b'])).toEqual(['a', 'c']);
  });

  it('skips an atom with no originPaths rather than crashing', () => {
    expect(toDocumentRanking([atom(), atom('docs/a.md'), atom()])).toEqual(['a']);
  });
});

const scoredAtom = (path: string, score: number, rerank?: Partial<ScoredAtom>): ScoredAtom => ({
  originPaths: [path],
  score,
  ...rerank,
});

describe('documentScores', () => {
  it('keeps the score of the atom that OCCUPIED the rank, never a later duplicate', () => {
    const atoms = [scoredAtom('docs/a.md', -2), scoredAtom('docs/a.md', -9)];
    expect(documentScores(atoms)).toEqual([{ docId: 'a', score: -2 }]);
  });

  it('drops excluded and originless atoms exactly as the ranking does', () => {
    const atoms = [
      { originPaths: [], score: -1 },
      scoredAtom('docs/a.md', -2),
      scoredAtom('docs/b.md', -3),
    ];
    expect(documentScores(atoms, ['b'])).toEqual([{ docId: 'a', score: -2 }]);
  });

  it('carries the rerank pair ONLY when the atom has it — absent is not zero', () => {
    const atoms = [
      scoredAtom('docs/a.md', 0.9, { firstPassScore: -4.5, rerankScore: 0.91 }),
      scoredAtom('docs/b.md', 0.1, { firstPassScore: -6.5 }),
    ];
    expect(documentScores(atoms)).toEqual([
      { docId: 'a', score: 0.9, firstPassScore: -4.5, rerankScore: 0.91 },
      { docId: 'b', score: 0.1, firstPassScore: -6.5 },
    ]);
    expect(Object.keys(documentScores(atoms)[1] ?? {})).not.toContain('rerankScore');
  });

  it('is aligned with toDocumentRanking rank for rank — one rollup, two projections', () => {
    const atoms = [
      scoredAtom('docs/a.md', -2),
      { originPaths: [], score: -3 },
      scoredAtom('docs/b.md', -4),
      scoredAtom('docs/a.md', -5),
      scoredAtom('docs/c.md', -6),
    ];
    const excluded = ['c'];
    expect(documentScores(atoms, excluded).map(entry => entry.docId)).toEqual(
      toDocumentRanking(atoms, excluded)
    );
  });
});

const DEPTH_100 = 100;

describe('scoreDataset', () => {
  const qrels = new Map<string, Qrel>([
    ['q1', new Map([['a', 1]])],
    ['q2', new Map([['z', 1]])],
  ]);

  it('scores every topic and reports the macro mean over ALL of them', () => {
    const result = scoreDataset(
      new Map([
        ['q1', ['a', 'b']],
        ['q2', ['a', 'b']],
      ]),
      qrels,
      DEPTH_100
    );
    expect(result.perTopic.map(t => t.queryId)).toEqual(['q1', 'q2']);
    expect(result.perTopic[0]?.metrics.ndcg10).toBeCloseTo(1, 12);
    expect(result.perTopic[1]?.metrics.ndcg10).toBe(0);
    expect(result.mean.ndcg10).toBeCloseTo(0.5, 12);
  });

  it('reports the SAMPLE sd of the per-topic values — the sample-size input, not a standard error', () => {
    const result = scoreDataset(
      new Map([
        ['q1', ['a', 'b']],
        ['q2', ['a', 'b']],
      ]),
      qrels,
      DEPTH_100
    );
    // per-topic nDCG@10 is [1, 0]; sample sd = sqrt(((0.5)^2 + (0.5)^2) / 1).
    expect(result.sd.ndcg10).toBeCloseTo(Math.SQRT1_2, 12);
    expect(result.sd.recall10).toBeCloseTo(Math.SQRT1_2, 12);
    expect(result.sd.mrr10).toBeCloseTo(Math.SQRT1_2, 12);
  });

  it('reports a zero sd for a single topic, where a sample sd is undefined', () => {
    expect(scoreDataset(new Map([['q1', ['a']]]), qrels, DEPTH_100).sd.ndcg10).toBe(0);
  });

  it('treats a topic with no qrels entry as all-zero instead of throwing', () => {
    const result = scoreDataset(new Map([['unknown', ['a']]]), qrels, DEPTH_100);
    expect(result.mean).toEqual({
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
      // the one retrieved id is UNJUDGED for this topic, so all the mass is residual
      rbpResidual: 1,
    });
  });

  it('carries the run DEPTH into the cutoffs: @20 is measured at depth 100, @300 is not', () => {
    const result = scoreDataset(new Map([['q1', ['a', 'b']]]), qrels, DEPTH_100);
    expect(result.mean.recall20).toBe(1);
    expect(result.mean.recall300).toBeUndefined();
    expect(result.perTopic[0]?.metrics.recall1000).toBeUndefined();
  });

  it('measures every cutoff the run actually retrieved to', () => {
    const result = scoreDataset(new Map([['q1', ['a', 'b']]]), qrels, 1000);
    expect(result.mean.recall300).toBe(1);
    expect(result.mean.recall1000).toBe(1);
  });
});

const SPREAD_ATOMS_10 = [
  atom('docs/a.md'),
  atom('docs/a.md'),
  atom('docs/b.md'),
  atom('docs/b.md'),
  atom('docs/c.md'),
  atom('docs/c.md'),
  atom('docs/d.md'),
  atom('docs/d.md'),
  atom('docs/e.md'),
  atom('docs/e.md'),
];

describe('atomSpread', () => {
  it('counts DISTINCT documents in the first 5 and first 10 served atoms', () => {
    const spread = atomSpread(SPREAD_ATOMS_10);
    expect(spread.distinctDocs5).toBe(3);
    expect(spread.distinctDocs10).toBe(5);
  });

  it('counts MAXIMAL contiguous same-document runs — A A B A is three runs', () => {
    const atoms = [
      atom('docs/a.md'),
      atom('docs/a.md'),
      atom('docs/b.md'),
      atom('docs/a.md'),
      atom('docs/a.md'),
      atom('docs/b.md'),
      atom('docs/b.md'),
      atom('docs/c.md'),
      atom('docs/c.md'),
      atom('docs/c.md'),
    ];
    const spread = atomSpread(atoms);
    expect(spread.sameDocRuns10).toBe(5);
    expect(spread.distinctDocs10).toBe(3);
  });

  it('does NOT dedupe — an interleaved order spreads further than a blocked one', () => {
    const interleaved = [0, 1, 2, 3, 4, 0, 1, 2, 3, 4].map(index => SPREAD_ATOMS_10[index * 2] ?? atom());
    const spread = atomSpread(interleaved);
    expect(spread.distinctDocs5).toBe(5);
    expect(spread.distinctDocs10).toBe(5);
    expect(spread.sameDocRuns10).toBe(10);
  });

  it('drops excluded ids before measuring, exactly as the document rollup does', () => {
    const spread = atomSpread(SPREAD_ATOMS_10, ['a']);
    expect(spread.distinctDocs5).toBe(3);
    expect(spread.distinctDocs10).toBeUndefined();
  });

  it('skips an atom with no originPaths', () => {
    const spread = atomSpread([atom(), ...SPREAD_ATOMS_10.slice(0, 5), atom()]);
    expect(spread.distinctDocs5).toBe(3);
    expect(spread.distinctDocs10).toBeUndefined();
  });

  it('reports a cutoff the window never filled as UNDEFINED, never as a short count', () => {
    const spread = atomSpread(SPREAD_ATOMS_10.slice(0, 4));
    expect(spread.distinctDocs5).toBeUndefined();
    expect(spread.distinctDocs10).toBeUndefined();
    expect(spread.sameDocRuns10).toBeUndefined();
  });

  it('holds sameDocRuns10 >= distinctDocs10, with equality iff every document is contiguous', () => {
    const blocked = atomSpread(SPREAD_ATOMS_10);
    expect(blocked.sameDocRuns10).toBe(blocked.distinctDocs10);
    const scattered = atomSpread([
      atom('docs/a.md'),
      ...SPREAD_ATOMS_10.slice(2),
      atom('docs/a.md'),
    ]);
    expect(scattered.sameDocRuns10 ?? 0).toBeGreaterThan(scattered.distinctDocs10 ?? 0);
  });
});

describe('scoreDataset — the atom spread rides along', () => {
  const rankings = new Map([
    ['q1', ['a', 'b']],
    ['q2', ['a', 'b']],
  ]);
  const spreadQrels = new Map<string, Qrel>([['q1', new Map([['a', 1]])]]);

  it('scores IDENTICALLY with and without the spread argument', () => {
    const withoutSpread = scoreDataset(rankings, spreadQrels, DEPTH_100);
    const withSpread = scoreDataset(
      rankings,
      spreadQrels,
      DEPTH_100,
      new Map([['q1', atomSpread(SPREAD_ATOMS_10)]])
    );
    expect(withSpread.perTopic.map(t => t.metrics)).toEqual(withoutSpread.perTopic.map(t => t.metrics));
    expect(withSpread.mean).toEqual(withoutSpread.mean);
    expect(withSpread.sd).toEqual(withoutSpread.sd);
  });

  it('carries each topic its own entry and leaves an unnamed topic without one', () => {
    const scored = scoreDataset(
      rankings,
      spreadQrels,
      DEPTH_100,
      new Map([['q1', atomSpread(SPREAD_ATOMS_10)]])
    );
    expect(scored.perTopic[0]?.spread?.distinctDocs10).toBe(5);
    expect(scored.perTopic[1]?.spread).toBeUndefined();
  });
});

const metricsAt = (ndcg10: number, recall10: number | undefined, mrr10: number): Metrics => ({
  ndcg10,
  recall10,
  recall20: undefined,
  recall100: recall10,
  recall300: undefined,
  recall1000: undefined,
  mrr10,
  precision5: undefined,
  precision10: undefined,
  allGoldInTop10: 0,
  map: 0,
  rPrecision: undefined,
  rbpResidual: 0,
});

const topic = (queryId: string, ndcg10: number, mrr10: number): TopicScore => ({
  queryId,
  metrics: metricsAt(ndcg10, ndcg10, mrr10),
});

describe('withTopicFacets', () => {
  it('attaches the authored facets and touches no metric', () => {
    const scored = [topic('q1', 0.4, 0.5), topic('q2', 0.6, 0.7)];

    const faceted = withTopicFacets(scored, new Map([['q1', { axis: 'synonym' }]]));

    expect(faceted[0]?.facets).toEqual({ axis: 'synonym' });
    expect(faceted[1]?.facets).toBeUndefined();
    expect(faceted.map(t => t.metrics)).toEqual(scored.map(t => t.metrics));
  });

  it('leaves every topic untouched when the dataset authored no facet', () => {
    const scored = [topic('q1', 0.4, 0.5)];
    expect(withTopicFacets(scored, new Map())).toEqual(scored);
  });
});

describe('perAxisStrata', () => {
  const faceted = withTopicFacets(
    [topic('q1', 0.4, 0.5), topic('q2', 0.6, 0.9), topic('q3', 0.2, 0.3), topic('q4', 0.8, 0.1)],
    new Map([
      ['q1', { axis: 'synonym' }],
      ['q2', { axis: 'synonym' }],
      ['q3', { axis: 'exact-keyword' }],
    ])
  );

  it('means each axis over ITS topics only, hand-checked', () => {
    const strata = perAxisStrata(faceted);

    expect(strata.map(s => [s.axis, s.topics])).toEqual([
      ['synonym', 2],
      ['exact-keyword', 1],
    ]);
    expect(strata[0]?.ndcg10).toBeCloseTo(0.5, 12);
    expect(strata[0]?.recall10).toBeCloseTo(0.5, 12);
    expect(strata[0]?.mrr10).toBeCloseTo(0.7, 12);
    expect(strata[1]?.ndcg10).toBeCloseTo(0.2, 12);
  });

  it('opens NO bucket for the topics that carry no axis', () => {
    expect(perAxisStrata(faceted).map(s => s.axis)).not.toContain('');
  });

  it('is EMPTY — never one bucket — when no topic carries an axis', () => {
    expect(perAxisStrata([topic('q1', 0.4, 0.5)])).toEqual([]);
  });
});
