import { describe, expect, it } from 'vitest';

import { compareAll, compareLastTwo, formatComparison } from './compare.js';
import type { HistoryRow } from './report.js';

const row = (overrides: Partial<HistoryRow>): HistoryRow => ({
  ts: '2026-08-14T09:30:00.000Z',
  gitSha: 'aaa1111',
  dataset: 'scifact',
  corpusBytes: 4096,
  corpusLines: 5183,
  adapter: 'fts5',
  atomMaxChars: null,
  depth: 100,
  rerank: false,
  topics: 300,
  docCount: 5183,
  atomCount: 5202,
  ingestMs: 1000,
  queryMs: 300,
  ndcg10: 0.6,
  recall10: 0.5,
  recall100: 0.9,
  mrr10: 0.55,
  ...overrides,
});

describe('compareLastTwo', () => {
  it('reports the delta of the four metrics when provenance is identical', () => {
    const result = compareLastTwo([row({}), row({ gitSha: 'bbb2222', ndcg10: 0.65 })], 'scifact');
    expect(result.kind).toBe('delta');
    if (result.kind !== 'delta') return;
    expect(result.delta.ndcg10).toBeCloseTo(0.05, 12);
    expect(result.delta.recall100).toBeCloseTo(0, 12);
    expect(result.latest.gitSha).toBe('bbb2222');
  });

  it('REFUSES a delta when atomMaxChars changed, naming that field', () => {
    const result = compareLastTwo(
      [row({}), row({ gitSha: 'bbb2222', atomMaxChars: 4000, ndcg10: 0.9 })],
      'scifact'
    );
    expect(result.kind).toBe('provenance-changed');
    if (result.kind !== 'provenance-changed') return;
    expect(result.changed.map(change => change.field)).toEqual(['atomMaxChars']);
    expect(result.changed[0]?.previous).toBe(null);
    expect(result.changed[0]?.latest).toBe(4000);
    expect(formatComparison(result)).toContain('atomMaxChars');
  });

  it('names every changed provenance field, not just the first', () => {
    const result = compareLastTwo(
      [row({}), row({ gitSha: 'bbb2222', rerank: true, corpusBytes: 9001 })],
      'scifact'
    );
    expect(result.kind).toBe('provenance-changed');
    if (result.kind !== 'provenance-changed') return;
    expect(result.changed.map(change => change.field).sort()).toEqual(['corpusBytes', 'rerank']);
  });

  it('COMPARES an adapter change as an arm comparison, labelled as one', () => {
    const result = compareLastTwo(
      [row({}), row({ gitSha: 'bbb2222', adapter: 'linear', ndcg10: 0.65 })],
      'scifact'
    );
    expect(result.kind).toBe('arm-delta');
    if (result.kind !== 'arm-delta') return;
    expect(result.arms.map(change => change.field)).toEqual(['adapter']);
    expect(result.delta.ndcg10).toBeCloseTo(0.05, 12);
    const line = formatComparison(result);
    expect(line).toContain('ARM COMPARISON');
    expect(line).toContain('adapter');
    expect(line).toContain('+0.0500');
  });

  it('COMPARES a rerank change as an arm comparison — that IS the experiment', () => {
    const result = compareLastTwo(
      [row({}), row({ gitSha: 'bbb2222', rerank: true, ndcg10: 0.62 })],
      'scifact'
    );
    expect(result.kind).toBe('arm-delta');
    if (result.kind !== 'arm-delta') return;
    expect(result.arms.map(change => change.field)).toEqual(['rerank']);
  });

  it('still REFUSES when a measuring-scale field moved alongside a treatment field', () => {
    const result = compareLastTwo(
      [row({}), row({ gitSha: 'bbb2222', adapter: 'linear', depth: 300 })],
      'scifact'
    );
    expect(result.kind).toBe('provenance-changed');
    if (result.kind !== 'provenance-changed') return;
    expect(result.changed.map(change => change.field).sort()).toEqual(['adapter', 'depth']);
    expect(formatComparison(result)).toContain('NO DELTA REPORTED');
  });

  it('reports insufficient history rather than inventing a baseline', () => {
    expect(compareLastTwo([row({})], 'scifact').kind).toBe('insufficient-history');
    expect(compareLastTwo([], 'scifact').kind).toBe('insufficient-history');
  });

  it('compares only rows of the named dataset', () => {
    const history = [row({}), row({ dataset: 'nfcorpus', ndcg10: 0.1 }), row({ ndcg10: 0.7 })];
    const result = compareLastTwo(history, 'scifact');
    expect(result.kind).toBe('delta');
    if (result.kind !== 'delta') return;
    expect(result.delta.ndcg10).toBeCloseTo(0.1, 12);
  });
});

describe('compareAll', () => {
  it('produces one comparison per dataset present in the history', () => {
    const history = [row({}), row({ ndcg10: 0.7 }), row({ dataset: 'nfcorpus' })];
    expect(compareAll(history).map(c => c.dataset)).toEqual(['scifact', 'nfcorpus']);
  });
});
