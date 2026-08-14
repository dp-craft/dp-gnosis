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
      qrels
    );
    expect(result.perTopic.map(t => t.queryId)).toEqual(['q1', 'q2']);
    expect(result.perTopic[0]?.metrics.ndcg10).toBeCloseTo(1, 12);
    expect(result.perTopic[1]?.metrics.ndcg10).toBe(0);
    expect(result.mean.ndcg10).toBeCloseTo(0.5, 12);
  });

  it('treats a topic with no qrels entry as all-zero instead of throwing', () => {
    const result = scoreDataset(new Map([['unknown', ['a']]]), qrels);
    expect(result.mean).toEqual({ ndcg10: 0, recall10: 0, recall100: 0, mrr10: 0 });
  });
});
