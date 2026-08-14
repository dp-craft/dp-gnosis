import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { type HistoryRow, PER_TOPIC_DIR, reportStem } from './report.js';
import {
  CI_LEVEL,
  pairedSignificance,
  PERMUTATION_ITERATIONS,
  perTopicPath,
  readPerTopic,
  SIGNIFICANCE_SEED
} from './significance.js';

const row = (overrides: Partial<HistoryRow>): HistoryRow => ({
  ts: '2026-08-14T12:57:00.000Z',
  gitSha: 'aaa1111',
  dataset: 'bright-biology',
  corpusBytes: 4096,
  corpusLines: 5183,
  adapter: 'fts5',
  atomMaxChars: null,
  depth: 100,
  rerank: false,
  topics: 12,
  docCount: 5183,
  atomCount: 5202,
  ingestMs: 1000,
  queryMs: 300,
  ndcg10: 0.3,
  recall10: 0.2,
  recall100: 0.5,
  mrr10: 0.25,
  ...overrides,
});

const tempResultsDir = (): string => mkdtempSync(resolve(tmpdir(), 'gnosis-bench-signif-'));

const HEADER = 'query_id\tndcg10\trecall10\trecall100\tmrr10';

/** Write a per-topic TSV at exactly the path the run reporter would have used. */
const writePerTopic = (
  resultsDir: string,
  run: HistoryRow,
  scores: ReadonlyArray<readonly [string, number]>
): void => {
  mkdirSync(resolve(resultsDir, PER_TOPIC_DIR), { recursive: true });
  const lines = scores.map(
    ([id, value]) => `${id}\t${value.toFixed(4)}\t0.1000\t0.2000\t0.3000`
  );
  writeFileSync(
    resolve(resultsDir, PER_TOPIC_DIR, `${reportStem(run.ts)}-${run.dataset}.tsv`),
    [HEADER, ...lines, ''].join('\n'),
    'utf8'
  );
};

const ids = (n: number): readonly string[] =>
  Array.from({ length: n }, (_, i) => `q${String(i).padStart(3, '0')}`);

const paired = (
  values: readonly number[]
): ReadonlyArray<readonly [string, number]> =>
  ids(values.length).map((id, i) => [id, values[i] ?? 0] as const);

const later = row({ ts: '2026-08-14T13:10:00.000Z', gitSha: 'bbb2222' });

/** A high-variance, mean-zero paired difference: the canonical known null. */
const NULL_BEFORE = [0.4, 0.1, 0.55, 0.2, 0.7, 0.05, 0.35, 0.6, 0.15, 0.45, 0.25, 0.5];
const NULL_AFTER = [0.1, 0.4, 0.2, 0.55, 0.05, 0.7, 0.6, 0.35, 0.45, 0.15, 0.5, 0.25];

const setup = (
  before: readonly number[],
  after: readonly number[]
): string => {
  const dir = tempResultsDir();
  writePerTopic(dir, row({}), paired(before));
  writePerTopic(dir, later, paired(after));
  return dir;
};

describe('constants', () => {
  it('pins the seed, the iteration count and the CI level', () => {
    expect(SIGNIFICANCE_SEED).toBeTypeOf('number');
    expect(PERMUTATION_ITERATIONS).toBe(10_000);
    expect(CI_LEVEL).toBe(0.95);
  });
});

describe('readPerTopic', () => {
  it('reads the four metrics per query id', () => {
    const dir = setup(NULL_BEFORE, NULL_AFTER);
    const scores = readPerTopic(perTopicPath(dir, row({})));
    expect(scores?.size).toBe(12);
    expect(scores?.get('q000')?.ndcg10).toBeCloseTo(0.4, 6);
    expect(scores?.get('q000')?.recall100).toBeCloseTo(0.2, 6);
  });

  it('returns undefined for a missing file rather than throwing', () => {
    expect(readPerTopic(resolve(tempResultsDir(), 'nope.tsv'))).toBeUndefined();
  });

  it('returns undefined for a malformed file rather than throwing', () => {
    const dir = tempResultsDir();
    const path = resolve(dir, 'bad.tsv');
    writeFileSync(path, 'not\ta\theader\ngarbage\n', 'utf8');
    expect(readPerTopic(path)).toBeUndefined();
  });

  it('returns undefined for a header-only file — nothing to pair', () => {
    const dir = tempResultsDir();
    const path = resolve(dir, 'empty.tsv');
    writeFileSync(path, `${HEADER}\n`, 'utf8');
    expect(readPerTopic(path)).toBeUndefined();
  });
});

describe('pairedSignificance — known null', () => {
  it('does NOT flag a permuted-but-identical score set', () => {
    const dir = setup(NULL_BEFORE, NULL_AFTER);
    const result = pairedSignificance({
      resultsDir: dir,
      previous: row({}),
      latest: later,
      metric: 'ndcg10',
    });
    expect(result.kind).toBe('verdict');
    if (result.kind !== 'verdict') return;
    expect(result.topics).toBe(12);
    expect(result.meanDifference).toBeCloseTo(0, 6);
    expect(result.pValue).toBeGreaterThan(0.05);
    expect(result.significant).toBe(false);
    expect(result.ciLow).toBeLessThanOrEqual(0);
    expect(result.ciHigh).toBeGreaterThanOrEqual(0);
  });

  it('does NOT flag a small noisy difference', () => {
    const before = [0.10, 0.40, 0.05, 0.60, 0.25, 0.50, 0.15, 0.45, 0.30, 0.55];
    const after = [0.35, 0.15, 0.30, 0.35, 0.50, 0.25, 0.40, 0.20, 0.05, 0.60];
    const result = pairedSignificance({
      resultsDir: setup(before, after),
      previous: row({}),
      latest: later,
      metric: 'ndcg10',
    });
    expect(result.kind).toBe('verdict');
    if (result.kind !== 'verdict') return;
    expect(result.pValue).toBeGreaterThan(0.05);
    expect(result.significant).toBe(false);
  });
});

describe('pairedSignificance — known effect', () => {
  it('flags a uniform improvement with a small p and a CI clear of zero', () => {
    const before = NULL_BEFORE;
    const after = before.map((value, i) => value + 0.09 + (i % 3) * 0.01);
    const result = pairedSignificance({
      resultsDir: setup(before, after),
      previous: row({}),
      latest: later,
      metric: 'ndcg10',
    });
    expect(result.kind).toBe('verdict');
    if (result.kind !== 'verdict') return;
    expect(result.meanDifference).toBeGreaterThan(0.09);
    expect(result.pValue).toBeLessThan(0.01);
    expect(result.significant).toBe(true);
    expect(result.ciLow).toBeGreaterThan(0);
  });
});

describe('pairedSignificance — determinism', () => {
  it('reproduces an identical p-value and CI across calls', () => {
    const dir = setup(NULL_BEFORE, NULL_AFTER);
    const options = {
      resultsDir: dir,
      previous: row({}),
      latest: later,
      metric: 'ndcg10',
    } as const;
    expect(JSON.stringify(pairedSignificance(options))).toBe(
      JSON.stringify(pairedSignificance(options))
    );
  });
});

describe('pairedSignificance — refusals', () => {
  it('REFUSES when provenance moved, naming the field', () => {
    const dir = setup(NULL_BEFORE, NULL_AFTER);
    const result = pairedSignificance({
      resultsDir: dir,
      previous: row({}),
      latest: row({ ts: later.ts, gitSha: 'bbb2222', depth: 300 }),
      metric: 'ndcg10',
    });
    expect(result.kind).toBe('provenance-changed');
    if (result.kind !== 'provenance-changed') return;
    expect(result.changed.map(change => change.field)).toEqual(['depth']);
  });

  it('REFUSES to inner-join when the topic sets differ, naming both sides', () => {
    const dir = tempResultsDir();
    writePerTopic(dir, row({}), [
      ['q000', 0.4],
      ['q001', 0.2],
    ]);
    writePerTopic(dir, later, [
      ['q000', 0.5],
      ['q002', 0.3],
    ]);
    const result = pairedSignificance({
      resultsDir: dir,
      previous: row({}),
      latest: later,
      metric: 'ndcg10',
    });
    expect(result.kind).toBe('topics-differ');
    if (result.kind !== 'topics-differ') return;
    expect(result.onlyInPrevious).toEqual(['q001']);
    expect(result.onlyInLatest).toEqual(['q002']);
  });

  it('reports the unreadable per-topic files instead of throwing', () => {
    const dir = tempResultsDir();
    writePerTopic(dir, row({}), paired(NULL_BEFORE));
    const result = pairedSignificance({
      resultsDir: dir,
      previous: row({}),
      latest: later,
      metric: 'ndcg10',
    });
    expect(result.kind).toBe('missing-per-topic');
    if (result.kind !== 'missing-per-topic') return;
    expect(result.paths).toEqual([perTopicPath(dir, later)]);
  });
});

describe('pairedSignificance — metric selection', () => {
  it('tests the named metric, not always nDCG@10', () => {
    const dir = setup(NULL_BEFORE, NULL_AFTER);
    const result = pairedSignificance({
      resultsDir: dir,
      previous: row({}),
      latest: later,
      metric: 'recall10',
    });
    expect(result.kind).toBe('verdict');
    if (result.kind !== 'verdict') return;
    expect(result.metric).toBe('recall10');
    expect(result.meanDifference).toBeCloseTo(0, 12);
    expect(result.pValue).toBe(1);
  });
});
