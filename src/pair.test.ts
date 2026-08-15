import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { PAIR_EXIT_REFUSED, PAIR_EXIT_USAGE, pairReport, parsePairArgs } from './pair.js';
import { type HistoryRow, PER_TOPIC_DIR } from './report.js';

const BASE_ROW: HistoryRow = {
  ts: '2026-08-15T01:00:00.000Z',
  gitSha: 'aaa1111',
  dataset: 'vault',
  corpusBytes: 4096,
  corpusLines: 5183,
  adapter: 'fts5',
  atomMaxChars: 2000,
  depth: 100,
  rerank: false,
  topics: 3,
  docCount: 100,
  atomCount: 200,
  ingestMs: 10,
  queryMs: 20,
  ndcg10: 0.3,
  recall10: 0.2,
  recall20: 0.35,
  recall100: 0.5,
  recall300: undefined,
  recall1000: undefined,
  mrr10: 0.25,
};

const row = (name: string, overrides: Partial<HistoryRow>): HistoryRow => ({
  ...BASE_ROW,
  ...overrides,
  perTopicPath: `${PER_TOPIC_DIR}/${name}.tsv`,
});

const HEADER = [
  'query_id',
  'ndcg10',
  'recall10',
  'recall20',
  'recall100',
  'recall300',
  'recall1000',
  'mrr10',
].join('\t');

/** One TSV row; `recall300` blank means the run never measured that cutoff. */
const line = (id: string, ndcg: number, recall300: string): string =>
  [id, ndcg.toFixed(4), '0.1000', '0.2000', '0.3000', recall300, '', '0.4000'].join('\t');

interface Fixture {
  readonly resultsDir: string;
  readonly write: (
    run: HistoryRow,
    scores: ReadonlyArray<readonly [string, number]>,
    recall300?: string
  ) => void;
}

const fixture = (): Fixture => {
  const resultsDir = mkdtempSync(resolve(tmpdir(), 'gnosis-bench-pair-'));
  mkdirSync(resolve(resultsDir, PER_TOPIC_DIR), { recursive: true });
  return {
    resultsDir,
    write: (run, scores, recall300 = '') => {
      const body = [HEADER, ...scores.map(([id, v]) => line(id, v, recall300)), ''].join('\n');
      writeFileSync(resolve(resultsDir, run.perTopicPath ?? ''), body, 'utf8');
    },
  };
};

const SCORES_A = [
  ['q1', 0.2],
  ['q2', 0.4],
  ['q3', 0.6],
] as const;

const SCORES_B = [
  ['q1', 0.5],
  ['q2', 0.7],
  ['q3', 0.6],
] as const;

const args = (overrides: Partial<ReturnType<typeof parsePairArgs>> = {}) => ({
  ...parsePairArgs(['--a', 'run-a', '--b', 'run-b']),
  ...overrides,
});

describe('parsePairArgs', () => {
  it('reads both selectors, a metric csv and an ids path', () => {
    const parsed = parsePairArgs([
      '--a', 'vault-base',
      '--b', 'vault-rephrased',
      '--metric', 'ndcg10, recall100',
      '--ids', '/tmp/ids.txt',
    ]);
    expect(parsed.a).toBe('vault-base');
    expect(parsed.b).toBe('vault-rephrased');
    expect(parsed.metrics).toEqual(['ndcg10', 'recall100']);
    expect(parsed.idsPath).toBe('/tmp/ids.txt');
  });

  it('rejects an unknown metric name loudly', () => {
    expect(() => parsePairArgs(['--a', 'x', '--b', 'y', '--metric', 'ndcg5'])).toThrow(/ndcg5/);
  });
});

describe('pairReport selector resolution', () => {
  it('refuses an ambiguous selector, listing every matching run', () => {
    const { resultsDir } = fixture();
    const history = [
      row('2026-08-15-0100-fts5-vault', {}),
      row('2026-08-15-0200-fts5-vault', { ts: '2026-08-15T02:00:00.000Z' }),
    ];
    const report = pairReport({ resultsDir, history, args: args({ a: 'fts5-vault', b: 'x' }) });
    expect(report.exitCode).toBe(PAIR_EXIT_USAGE);
    const text = report.lines.join('\n');
    expect(text).toMatch(/ambiguous/i);
    expect(text).toContain('2026-08-15-0100-fts5-vault');
    expect(text).toContain('2026-08-15-0200-fts5-vault');
  });

  it('refuses a selector that matches no recorded run', () => {
    const { resultsDir } = fixture();
    const history = [row('2026-08-15-0100-fts5-vault', {})];
    const report = pairReport({ resultsDir, history, args: args({ a: 'nope', b: 'fts5-vault' }) });
    expect(report.exitCode).toBe(PAIR_EXIT_USAGE);
    expect(report.lines.join('\n')).toMatch(/no recorded run/i);
  });
});

describe('pairReport provenance guards', () => {
  it('refuses to subtract when a SCALE field moved, naming the field', () => {
    const f = fixture();
    const a = row('a-depth100', {});
    const b = row('b-depth10', { depth: 10 });
    f.write(a, SCORES_A);
    f.write(b, SCORES_B);
    const report = pairReport({
      resultsDir: f.resultsDir,
      history: [a, b],
      args: args({ a: 'a-depth100', b: 'b-depth10' }),
    });
    expect(report.exitCode).toBe(PAIR_EXIT_REFUSED);
    const text = report.lines.join('\n');
    expect(text).toContain('depth');
    expect(text).not.toMatch(/p=/);
  });

  it('labels a differing TREATMENT field ARM COMPARISON before any number', () => {
    const f = fixture();
    const a = row('a-fts5', {});
    const b = row('b-linear', { adapter: 'linear' });
    f.write(a, SCORES_A);
    f.write(b, SCORES_B);
    const report = pairReport({
      resultsDir: f.resultsDir,
      history: [a, b],
      args: args({ a: 'a-fts5', b: 'b-linear' }),
    });
    expect(report.exitCode).toBe(0);
    const text = report.lines.join('\n');
    expect(text).toContain('ARM COMPARISON');
    expect(text.indexOf('ARM COMPARISON')).toBeLessThan(text.indexOf('p='));
    expect(text).toContain('adapter');
  });

  it('pairs across two DIFFERENT datasets and prints both ids', () => {
    const f = fixture();
    const a = row('a-vault', {});
    const b = row('b-rephrased', { dataset: 'vault-rephrased' });
    f.write(a, SCORES_A);
    f.write(b, SCORES_B);
    const report = pairReport({
      resultsDir: f.resultsDir,
      history: [a, b],
      args: args({ a: 'a-vault', b: 'b-rephrased' }),
    });
    expect(report.exitCode).toBe(0);
    const text = report.lines.join('\n');
    expect(text).toContain('vault');
    expect(text).toContain('vault-rephrased');
    expect(text).toMatch(/ndcg10.*n=3/);
    expect(text).toMatch(/p=/);
  });

  it('refuses when the two runs scored different topic ids', () => {
    const f = fixture();
    const a = row('a-vault', {});
    const b = row('b-rephrased', { dataset: 'vault-rephrased' });
    f.write(a, SCORES_A);
    f.write(b, [['q1', 0.5], ['q2', 0.7], ['q9', 0.6]]);
    const report = pairReport({
      resultsDir: f.resultsDir,
      history: [a, b],
      args: args({ a: 'a-vault', b: 'b-rephrased' }),
    });
    expect(report.exitCode).toBe(PAIR_EXIT_REFUSED);
    expect(report.lines.join('\n')).toContain('topics-differ');
  });
});

describe('pairReport metric selection', () => {
  it('restricts the paired test to the ids listed in --ids', () => {
    const f = fixture();
    const a = row('a-vault', {});
    const b = row('b-rephrased', { dataset: 'vault-rephrased' });
    f.write(a, SCORES_A);
    f.write(b, SCORES_B);
    const idsPath = resolve(f.resultsDir, 'ids.txt');
    writeFileSync(idsPath, 'q1\nq2\n\n', 'utf8');
    const report = pairReport({
      resultsDir: f.resultsDir,
      history: [a, b],
      args: args({ a: 'a-vault', b: 'b-rephrased', idsPath }),
    });
    expect(report.exitCode).toBe(0);
    expect(report.lines.join('\n')).toMatch(/ndcg10.*n=2/);
  });

  it('reports metric-unavailable when a requested metric is absent on one side', () => {
    const f = fixture();
    const a = row('a-vault', {});
    const b = row('b-rephrased', { dataset: 'vault-rephrased' });
    f.write(a, SCORES_A, '0.9000');
    f.write(b, SCORES_B);
    const report = pairReport({
      resultsDir: f.resultsDir,
      history: [a, b],
      args: args({ a: 'a-vault', b: 'b-rephrased', metrics: ['recall300'] }),
    });
    expect(report.exitCode).toBe(PAIR_EXIT_REFUSED);
    expect(report.lines.join('\n')).toContain('metric-unavailable');
  });

  it('defaults to every metric both runs measured', () => {
    const f = fixture();
    const a = row('a-vault', {});
    const b = row('b-rephrased', { dataset: 'vault-rephrased' });
    f.write(a, SCORES_A);
    f.write(b, SCORES_B);
    const report = pairReport({
      resultsDir: f.resultsDir,
      history: [a, b],
      args: args({ a: 'a-vault', b: 'b-rephrased' }),
    });
    const text = report.lines.join('\n');
    expect(text).toContain('ndcg10');
    expect(text).toContain('recall100');
    expect(text).toContain('mrr10');
    expect(text).not.toContain('recall1000');
  });
});
