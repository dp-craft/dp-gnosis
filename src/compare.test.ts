import { describe, expect, it } from 'vitest';

import { HYBRID_FUSION, RERANK_MODEL_ID } from '../../dp-gnosis/src/config.js';
import { DEFAULT_ANALYZER } from '../../dp-gnosis/src/query.js';
import {
  compareAll,
  compareLastTwo,
  formatComparison,
  PROVENANCE_FIELDS,
  SCALE_FIELDS,
  TREATMENT_FIELDS
} from './compare.js';
import type { HistoryRow } from './report.js';

/** The shipped DENSE leg weight — what an absent `hybridWeight` on a row means. */
const HYBRID_FUSION_WEIGHT: number = HYBRID_FUSION.rerankWeight;

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
  recall20: 0.7,
  recall100: 0.9,
  recall300: undefined,
  recall1000: undefined,
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

  it('COMPARES a rerankProfile change as an arm comparison, never subtracting it silently', () => {
    const result = compareLastTwo(
      [
        row({ rerank: true, rerankProfile: 'shipped' }),
        row({ gitSha: 'bbb2222', rerank: true, rerankProfile: 'beir-ce', ndcg10: 0.63 }),
      ],
      'scifact'
    );
    expect(result.kind).toBe('arm-delta');
    if (result.kind !== 'arm-delta') return;
    expect(result.arms.map(change => change.field)).toEqual(['rerankProfile']);
    const line = formatComparison(result);
    expect(line).toContain('ARM COMPARISON');
    expect(line).toContain('rerankProfile');
  });

  it('COMPARES a raw rerankWeight override as an arm comparison too', () => {
    const result = compareLastTwo(
      [
        row({ rerank: true, rerankProfile: 'shipped' }),
        row({ gitSha: 'bbb2222', rerank: true, rerankProfile: 'shipped', rerankWeight: 0.8 }),
      ],
      'scifact'
    );
    expect(result.kind).toBe('arm-delta');
    if (result.kind !== 'arm-delta') return;
    expect(result.arms.map(change => change.field)).toEqual(['rerankWeight']);
  });

  it('guards the rerank protocol through the DERIVED union, not a hand-written list', () => {
    expect(TREATMENT_FIELDS).toContain('rerankProfile');
    expect(TREATMENT_FIELDS).toContain('rerankWeight');
    expect(PROVENANCE_FIELDS).toEqual([...SCALE_FIELDS, ...TREATMENT_FIELDS]);
  });

  it('guards the HYBRID leg weight as a TREATMENT, never as a measuring scale', () => {
    expect(TREATMENT_FIELDS).toContain('hybridWeight');
    expect(SCALE_FIELDS).not.toContain('hybridWeight');
  });

  it('COMPARES a hybrid leg weight change as an arm comparison', () => {
    const result = compareLastTwo(
      [
        row({ adapter: 'lancedb-hybrid' }),
        row({ gitSha: 'bbb2222', adapter: 'lancedb-hybrid', hybridWeight: 0.8 }),
      ],
      'scifact'
    );
    expect(result.kind).toBe('arm-delta');
    if (result.kind !== 'arm-delta') return;
    expect(result.arms.map(change => change.field)).toEqual(['hybridWeight']);
  });

  /** An absent weight IS the shipped one, so naming it explicitly is not an arm. */
  it('reads an ABSENT hybrid weight as the shipped leg weight', () => {
    const result = compareLastTwo(
      [
        row({ adapter: 'lancedb-hybrid' }),
        row({ gitSha: 'bbb2222', adapter: 'lancedb-hybrid', hybridWeight: HYBRID_FUSION_WEIGHT }),
      ],
      'scifact'
    );
    expect(result.kind).toBe('delta');
  });

  it('guards the analyzer as a TREATMENT, never as a measuring scale', () => {
    expect(TREATMENT_FIELDS).toContain('analyzer');
    expect(SCALE_FIELDS).not.toContain('analyzer');
  });

  it('COMPARES an analyzer change as an arm comparison, never subtracting it silently', () => {
    const result = compareLastTwo(
      [
        row({ analyzer: 'porter-fold' }),
        row({ gitSha: 'bbb2222', analyzer: 'nostem-fold', ndcg10: 0.65 }),
      ],
      'scifact'
    );
    expect(result.kind).toBe('arm-delta');
    if (result.kind !== 'arm-delta') return;
    expect(result.arms.map(change => change.field)).toEqual(['analyzer']);
    const line = formatComparison(result);
    expect(line).toContain('ARM COMPARISON');
    expect(line).toContain('analyzer');
    expect(line).toContain('nostem-fold');
  });

  /**
   * Every row recorded before the chain was selectable was built by
   * `DEFAULT_ANALYZER`; reading its absence as a treatment move would label the
   * first comparison after this landed an arm comparison against an arm nobody ran.
   */
  it('reads an ABSENT analyzer as the default chain, not as a changed treatment', () => {
    const result = compareLastTwo(
      [row({}), row({ gitSha: 'bbb2222', analyzer: DEFAULT_ANALYZER, ndcg10: 0.65 })],
      'scifact'
    );
    expect(result.kind).toBe('delta');
  });

  it('guards the reranker MODEL as a TREATMENT, never as a measuring scale', () => {
    expect(TREATMENT_FIELDS).toContain('rerankModel');
    expect(SCALE_FIELDS).not.toContain('rerankModel');
  });

  /**
   * Two cross-encoders produce two different orders. Subtracting them would read
   * a model swap as a quality movement of one arm — the failure `TREATMENT_FIELDS`
   * exists to prevent, and the one a shipped-constant model id made unavoidable.
   */
  it('COMPARES a rerankModel change as an arm comparison, never subtracting it', () => {
    const result = compareLastTwo(
      [
        row({ rerank: true, rerankModel: RERANK_MODEL_ID }),
        row({
          gitSha: 'bbb2222',
          rerank: true,
          rerankModel: 'jina-reranker-v2-base-multilingual',
          ndcg10: 0.65,
        }),
      ],
      'scifact'
    );
    expect(result.kind).toBe('arm-delta');
    if (result.kind !== 'arm-delta') return;
    expect(result.arms.map(change => change.field)).toEqual(['rerankModel']);
    const line = formatComparison(result);
    expect(line).toContain('ARM COMPARISON');
    expect(line).toContain('rerankModel');
    expect(line).toContain('jina-reranker-v2-base-multilingual');
  });

  /**
   * Every row recorded before the model was selectable was scored by
   * `RERANK_MODEL_ID`. Reading its absence as a move would label the first
   * default-model comparison after this landed an arm comparison against an arm
   * nobody ran — the whole recorded history against itself.
   */
  it('reads an ABSENT rerankModel as the shipped model, not as a changed treatment', () => {
    const result = compareLastTwo(
      [
        row({ rerank: true, rerankProfile: 'shipped' }),
        row({
          gitSha: 'bbb2222',
          rerank: true,
          rerankProfile: 'shipped',
          rerankModel: RERANK_MODEL_ID,
          ndcg10: 0.65,
        }),
      ],
      'scifact'
    );
    expect(result.kind).toBe('delta');
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
