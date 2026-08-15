import { describe, expect, it } from 'vitest';

import type { Qrel } from './metrics.js';
import { scoreDataset, toDocumentRanking } from './score.js';

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
