import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { DEFAULT_ANALYZER } from '../../dp-gnosis/src/query.js';
import {
  type HistoryRow,
  PER_TOPIC_DIR,
  perTopicRelPath,
  reportStem,
  type RunProvenance
} from './report.js';
import {
  CI_LEVEL,
  pairedScores,
  pairedSignificance,
  PERMUTATION_ITERATIONS,
  perTopicPath,
  readPerTopic,
  SIGNIFICANCE_SEED,
  type TopicScores
} from './significance.js';

const BASE_ROW: HistoryRow = {
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
  recall20: 0.35,
  recall100: 0.5,
  recall300: undefined,
  recall1000: undefined,
  mrr10: 0.25,
};

/**
 * A recorded row, carrying the per-topic path the writer would have recorded for
 * it. `perTopicPath: undefined` in the overrides reproduces a row written before
 * the field existed.
 */
/** A row is provenance-shaped except for the analyzer, absent on a legacy row. */
const asProvenance = (run: HistoryRow): RunProvenance => ({
  ...run,
  analyzer: run.analyzer ?? DEFAULT_ANALYZER,
});

const row = (overrides: Partial<HistoryRow>): HistoryRow => {
  const merged = { ...BASE_ROW, ...overrides };
  return { perTopicPath: perTopicRelPath(asProvenance(merged), merged.dataset), ...merged };
};

const tempResultsDir = (): string => mkdtempSync(resolve(tmpdir(), 'gnosis-bench-signif-'));

const HEADER = 'query_id\tndcg10\trecall10\trecall100\tmrr10';

const tsvBody = (scores: ReadonlyArray<readonly [string, number]>): string =>
  [
    HEADER,
    ...scores.map(([id, value]) => `${id}\t${value.toFixed(4)}\t0.1000\t0.2000\t0.3000`),
    '',
  ].join('\n');

/** Write a per-topic TSV at exactly the path the run reporter recorded on the row. */
const writePerTopic = (
  resultsDir: string,
  run: HistoryRow,
  scores: ReadonlyArray<readonly [string, number]>
): void => {
  mkdirSync(resolve(resultsDir, PER_TOPIC_DIR), { recursive: true });
  writeFileSync(
    resolve(resultsDir, run.perTopicPath ?? perTopicRelPath(asProvenance(run), run.dataset)),
    tsvBody(scores),
    'utf8'
  );
};

/** The legacy layout: stem + dataset only, with no adapter and no recorded path. */
const writeLegacyPerTopic = (
  resultsDir: string,
  run: HistoryRow,
  scores: ReadonlyArray<readonly [string, number]>
): void => {
  mkdirSync(resolve(resultsDir, PER_TOPIC_DIR), { recursive: true });
  writeFileSync(
    resolve(resultsDir, PER_TOPIC_DIR, `${reportStem(run.ts)}-${run.dataset}.tsv`),
    tsvBody(scores),
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
  after: readonly number[],
  latest: HistoryRow = later
): string => {
  const dir = tempResultsDir();
  writePerTopic(dir, row({}), paired(before));
  writePerTopic(dir, latest, paired(after));
  return dir;
};

const meanOf = (values: readonly number[]): number =>
  values.reduce((sum, value) => sum + value, 0) / values.length;

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
    const scores = readPerTopic(perTopicPath(dir, row({})) ?? '');
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

describe('pairedSignificance — treatment arms', () => {
  it('TESTS an adapter change and names the arm instead of refusing', () => {
    const arm = row({ ts: later.ts, gitSha: 'bbb2222', adapter: 'linear' });
    const dir = setup(NULL_BEFORE, NULL_AFTER, arm);
    const result = pairedSignificance({
      resultsDir: dir,
      previous: row({}),
      latest: arm,
      metric: 'ndcg10',
    });
    expect(result.kind).toBe('verdict');
    if (result.kind !== 'verdict') return;
    expect(result.arms?.map(change => change.field)).toEqual(['adapter']);
    expect(result.topics).toBe(12);
  });

  it('leaves `arms` unset for a like-for-like pair', () => {
    const dir = setup(NULL_BEFORE, NULL_AFTER);
    const result = pairedSignificance({
      resultsDir: dir,
      previous: row({}),
      latest: later,
      metric: 'ndcg10',
    });
    expect(result.kind).toBe('verdict');
    if (result.kind !== 'verdict') return;
    expect(result.arms).toBeUndefined();
  });

  it('still REFUSES when a scale field moved alongside the arm', () => {
    const dir = setup(NULL_BEFORE, NULL_AFTER);
    const result = pairedSignificance({
      resultsDir: dir,
      previous: row({}),
      latest: row({ ts: later.ts, gitSha: 'bbb2222', adapter: 'linear', depth: 300 }),
      metric: 'ndcg10',
    });
    expect(result.kind).toBe('provenance-changed');
    if (result.kind !== 'provenance-changed') return;
    expect(result.changed.map(change => change.field).sort()).toEqual(['adapter', 'depth']);
  });
});

describe('pairedSignificance — run attribution', () => {
  const ARM_AFTER = NULL_BEFORE.map(value => value - 0.043);

  it('pairs each arm against its OWN vector when two arms share a minute', () => {
    const dir = tempResultsDir();
    const fts5 = row({});
    const lancedb = row({ adapter: 'lancedb' });
    writePerTopic(dir, fts5, paired(NULL_BEFORE));
    writePerTopic(dir, lancedb, paired(ARM_AFTER));
    const result = pairedSignificance({
      resultsDir: dir,
      previous: fts5,
      latest: lancedb,
      metric: 'ndcg10',
    });
    expect(result.kind).toBe('verdict');
    if (result.kind !== 'verdict') return;
    expect(result.meanDifference).toBeCloseTo(meanOf(ARM_AFTER) - meanOf(NULL_BEFORE), 6);
    expect(result.pValue).toBeLessThan(1);
    expect(result.ciLow).not.toBe(result.ciHigh);
  });

  it('REFUSES a row that records no per-topic path rather than pairing it with a findable file', () => {
    const dir = tempResultsDir();
    const legacy = row({ perTopicPath: undefined });
    const legacyLater = row({ ts: later.ts, gitSha: later.gitSha, perTopicPath: undefined });
    writeLegacyPerTopic(dir, legacy, paired(NULL_BEFORE));
    writeLegacyPerTopic(dir, legacyLater, paired(NULL_AFTER));
    const result = pairedSignificance({
      resultsDir: dir,
      previous: legacy,
      latest: legacyLater,
      metric: 'ndcg10',
    });
    expect(result.kind).toBe('unattributable-run');
    if (result.kind !== 'unattributable-run') return;
    expect(result.runs).toEqual([
      `${legacy.ts} (fts5)`,
      `${legacyLater.ts} (fts5)`,
    ]);
  });

  it('REFUSES when only the LATEST row lacks a recorded path', () => {
    const dir = tempResultsDir();
    const legacyLater = row({ ts: later.ts, gitSha: later.gitSha, perTopicPath: undefined });
    writePerTopic(dir, row({}), paired(NULL_BEFORE));
    writeLegacyPerTopic(dir, legacyLater, paired(NULL_AFTER));
    const result = pairedSignificance({
      resultsDir: dir,
      previous: row({}),
      latest: legacyLater,
      metric: 'ndcg10',
    });
    expect(result.kind).toBe('unattributable-run');
    if (result.kind !== 'unattributable-run') return;
    expect(result.runs).toEqual([`${legacyLater.ts} (fts5)`]);
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

/** Build a `TopicScores` map directly — the shape a sweep cell holds in memory. */
const scoresOf = (
  entries: ReadonlyArray<readonly [string, number]>
): TopicScores =>
  new Map(
    entries.map(([id, value]) => [
      id,
      {
        ndcg10: value,
        recall10: 0.1,
        recall20: 0.15,
        recall100: 0.2,
        recall300: undefined,
        recall1000: undefined,
        mrr10: 0.3,
      },
    ])
  );

const EFFECT_AFTER = NULL_BEFORE.map(value => value + 0.05);

describe('pairedScores — the loaded-score seam', () => {
  it('returns a verdict for two already-loaded paired score sets', () => {
    const result = pairedScores(
      'sweep-cell',
      'ndcg10',
      scoresOf(paired(NULL_BEFORE)),
      scoresOf(paired(EFFECT_AFTER))
    );
    expect(result.kind).toBe('verdict');
    if (result.kind !== 'verdict') return;
    expect(result.dataset).toBe('sweep-cell');
    expect(result.topics).toBe(NULL_BEFORE.length);
    expect(result.meanDifference).toBeCloseTo(0.05, 12);
    expect(result.significant).toBe(true);
  });

  it('refuses rather than inner-joining two differing topic sets', () => {
    const before = scoresOf(paired(NULL_BEFORE));
    const after = scoresOf(paired(EFFECT_AFTER).slice(0, 10));
    const result = pairedScores('sweep-cell', 'ndcg10', before, after);
    expect(result.kind).toBe('topics-differ');
    if (result.kind !== 'topics-differ') return;
    expect(result.onlyInPrevious).toEqual(['q010', 'q011']);
    expect(result.onlyInLatest).toEqual([]);
  });

  it('produces the identical verdict pairedSignificance produces', () => {
    const dir = setup(NULL_BEFORE, EFFECT_AFTER);
    const viaRuns = pairedSignificance({
      resultsDir: dir,
      previous: row({}),
      latest: later,
      metric: 'ndcg10',
    });
    const before = readPerTopic(perTopicPath(dir, row({})) ?? '');
    const after = readPerTopic(perTopicPath(dir, later) ?? '');
    expect(before).toBeDefined();
    expect(after).toBeDefined();
    if (before === undefined || after === undefined) return;
    expect(pairedScores('bright-biology', 'ndcg10', before, after)).toEqual(viaRuns);
  });
});

// ------------------------------------------------ the added recall cutoffs

/** The header recorded TSVs on disk carry — five columns, no @20/@300/@1000. */
const LEGACY_HEADER = 'query_id\tndcg10\trecall10\trecall100\tmrr10';

const CURRENT_HEADER =
  'query_id\tndcg10\trecall10\trecall20\trecall100\trecall300\trecall1000\tmrr10';

const writeTsv = (body: string): string => {
  const path = resolve(tempResultsDir(), 'scores.tsv');
  writeFileSync(path, body, 'utf8');
  return path;
};

const legacyTsv = (values: readonly number[]): string =>
  [LEGACY_HEADER, ...values.map((v, i) => `q${i}\t${v.toFixed(4)}\t0.1000\t0.2000\t0.3000`), ''].join('\n');

const currentTsv = (values: readonly number[]): string =>
  [
    CURRENT_HEADER,
    ...values.map((v, i) => `q${i}\t${v.toFixed(4)}\t0.1000\t${v.toFixed(4)}\t0.2000\t\t\t0.3000`),
    '',
  ].join('\n');

describe('per-topic TSV parsed by COLUMN NAME', () => {
  it('still reads a legacy five-column file, with the new metrics undefined', () => {
    const scores = readPerTopic(writeTsv(legacyTsv(NULL_BEFORE)));
    expect(scores?.size).toBe(NULL_BEFORE.length);
    expect(scores?.get('q0')?.ndcg10).toBeCloseTo(0.4, 6);
    expect(scores?.get('q0')?.recall100).toBeCloseTo(0.2, 6);
    expect(scores?.get('q0')?.recall20).toBeUndefined();
    expect(scores?.get('q0')?.recall300).toBeUndefined();
  });

  it('reads the current header, and an EMPTY field is undefined rather than 0', () => {
    const scores = readPerTopic(writeTsv(currentTsv(NULL_BEFORE)));
    expect(scores?.get('q0')?.recall20).toBeCloseTo(0.4, 6);
    expect(scores?.get('q0')?.mrr10).toBeCloseTo(0.3, 6);
    expect(scores?.get('q0')?.recall300).toBeUndefined();
    expect(scores?.get('q0')?.recall1000).toBeUndefined();
  });
});

describe('a metric absent from a file is a REFUSAL, never a fabricated 0', () => {
  it('refuses a recall@20 test against a legacy file, and states why', () => {
    const before = readPerTopic(writeTsv(legacyTsv(NULL_BEFORE)));
    const after = readPerTopic(writeTsv(currentTsv(NULL_BEFORE.map(v => v + 0.05))));
    expect(before).toBeDefined();
    expect(after).toBeDefined();
    if (before === undefined || after === undefined) return;
    const result = pairedScores('bright-biology', 'recall20', before, after);
    expect(result.kind).toBe('metric-unavailable');
    if (result.kind !== 'metric-unavailable') return;
    expect(result.metric).toBe('recall20');
    expect(result.reason.length).toBeGreaterThan(0);
  });

  it('runs the test when BOTH files recorded the metric', () => {
    const before = readPerTopic(writeTsv(currentTsv(NULL_BEFORE)));
    const after = readPerTopic(writeTsv(currentTsv(NULL_BEFORE.map(v => v + 0.05))));
    expect(before).toBeDefined();
    expect(after).toBeDefined();
    if (before === undefined || after === undefined) return;
    const result = pairedScores('bright-biology', 'recall20', before, after);
    expect(result.kind).toBe('verdict');
    if (result.kind !== 'verdict') return;
    expect(result.meanDifference).toBeCloseTo(0.05, 6);
  });
});
