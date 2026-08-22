import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { DEFAULT_ANALYZER } from '../../dp-gnosis/src/query.js';
import { gateReport, parseGateArgs } from './gate.js';
import {
  DEFAULT_FIELD_WEIGHTS_TEXT,
  type HistoryRow,
  NO_TYPE_FILTER,
  PER_TOPIC_DIR,
  perTopicRelPath,
  type RunProvenance
} from './report.js';

const DATASET = 'vault';

const BASE_ROW: HistoryRow = {
  ts: '2026-08-18T09:00:00.000Z',
  gitSha: 'aaa1111',
  dataset: DATASET,
  corpusBytes: 4096,
  corpusLines: 454,
  adapter: 'fts5',
  atomMaxChars: null,
  depth: 100,
  rerank: false,
  topics: 8,
  docCount: 454,
  atomCount: 455,
  ingestMs: 1000,
  queryMs: 300,
  ndcg10: 0.7,
  recall10: 0.2,
  recall20: 0.35,
  recall100: 0.5,
  recall300: undefined,
  recall1000: undefined,
  mrr10: 0.25,
};

const asProvenance = (run: HistoryRow): RunProvenance => ({
  ...run,
  analyzer: run.analyzer ?? DEFAULT_ANALYZER,
  fieldWeights: run.fieldWeights ?? DEFAULT_FIELD_WEIGHTS_TEXT,
  queryAdjacency: run.queryAdjacency ?? false,
  prf: run.prf ?? false,
  typeFilter: run.typeFilter ?? NO_TYPE_FILTER,
});

const row = (overrides: Partial<HistoryRow>): HistoryRow => {
  const merged = { ...BASE_ROW, ...overrides };
  return { ...merged, perTopicPath: perTopicRelPath(asProvenance(merged), merged.dataset) };
};

const HEADER = 'query_id\tndcg10\trecall10\trecall100\tmrr10';

const writeScores = (resultsDir: string, run: HistoryRow, values: readonly number[]): void => {
  mkdirSync(resolve(resultsDir, PER_TOPIC_DIR), { recursive: true });
  const body = values
    .map((value, i) => `q${String(i).padStart(3, '0')}\t${value.toFixed(4)}\t0.1\t0.2\t0.3`)
    .join('\n');
  writeFileSync(resolve(resultsDir, run.perTopicPath ?? ''), `${HEADER}\n${body}\n`, 'utf8');
};

const BASELINE_SCORES = [0.7, 0.6, 0.8, 0.5, 0.75, 0.65, 0.55, 0.85];

const BASELINE = row({});
const LATEST = row({ ts: '2026-08-18T10:00:00.000Z', gitSha: 'bbb2222' });

const SELECTOR = '090000000';

const tempResults = (): string => mkdtempSync(resolve(tmpdir(), 'gnosis-bench-gate-'));

/** A results dir holding the baseline and the just-finished run, with scores. */
const setup = (latestScores: readonly number[], latest: HistoryRow = LATEST): string => {
  const dir = tempResults();
  writeScores(dir, BASELINE, BASELINE_SCORES);
  writeScores(dir, latest, latestScores);
  return dir;
};

const request = (dir: string, latest: HistoryRow = LATEST) => ({
  resultsDir: dir,
  history: [BASELINE, latest],
  datasets: [DATASET],
  options: { baseline: SELECTOR, failUnder: 0.01 },
});

describe('parseGateArgs — the flag pair', () => {
  it('is absent when neither flag is given, so no gate runs', () => {
    expect(parseGateArgs(['--layer', 'smoke', '--rerank'])).toBeUndefined();
  });

  it('parses both flags together', () => {
    expect(parseGateArgs(['--baseline', 'sel', '--fail-under', '0.01'])).toEqual({
      baseline: 'sel',
      failUnder: 0.01,
    });
  });

  it('REFUSES --baseline without --fail-under, naming both', () => {
    expect(() => parseGateArgs(['--baseline', 'sel'])).toThrow(/--baseline.*--fail-under/s);
  });

  it('REFUSES --fail-under without --baseline, naming both', () => {
    expect(() => parseGateArgs(['--fail-under', '0.01'])).toThrow(/--baseline.*--fail-under/s);
  });

  it('REFUSES a non-numeric or negative tolerance rather than clamping it', () => {
    expect(() => parseGateArgs(['--baseline', 's', '--fail-under', 'x'])).toThrow(/--fail-under/);
    expect(() => parseGateArgs(['--baseline', 's', '--fail-under', '-1'])).toThrow(/--fail-under/);
  });
});

describe('gateReport — the point estimate decides', () => {
  it('FAILS with exit 4 when the mean nDCG@10 drop exceeds the tolerance', () => {
    const dir = setup(BASELINE_SCORES.map(value => value - 0.05));
    const report = gateReport(request(dir));
    expect(report.exitCode).toBe(4);
    expect(report.lines.join('\n')).toContain('REGRESSION');
    expect(report.lines.join('\n')).toContain(DATASET);
  });

  it('PASSES a drop within tolerance, and prints the p-value and CI beside it', () => {
    const dir = setup(BASELINE_SCORES.map(value => value - 0.005));
    const report = gateReport(request(dir));
    expect(report.exitCode).toBe(0);
    expect(report.lines.join('\n')).toContain('p=');
    expect(report.lines.join('\n')).toContain('CI');
  });

  it('does NOT gate on significance — an insignificant drop past tolerance still fails', () => {
    const dir = setup(BASELINE_SCORES.map((value, i) => value - (i % 2 === 0 ? 0.3 : -0.1)));
    const report = gateReport(request(dir));
    expect(report.exitCode).toBe(4);
    expect(report.lines.join('\n')).toContain('not significant');
  });

  it('exits 4 as CANNOT COMPARE when a SCALE field moved — never as a pass', () => {
    const scaled = row({ ts: '2026-08-18T10:00:00.000Z', gitSha: 'bbb2222', depth: 20 });
    const dir = setup(BASELINE_SCORES, scaled);
    const report = gateReport(request(dir, scaled));
    expect(report.exitCode).toBe(4);
    expect(report.lines.join('\n')).toContain('CANNOT COMPARE');
    expect(report.lines.join('\n')).toContain('depth');
  });

  it('exits 4 naming the selector AND the dataset when nothing matches', () => {
    const dir = setup(BASELINE_SCORES);
    const report = gateReport({ ...request(dir), options: { baseline: 'nope', failUnder: 0.01 } });
    expect(report.exitCode).toBe(4);
    expect(report.lines.join('\n')).toContain('nope');
    expect(report.lines.join('\n')).toContain(DATASET);
  });

  it('exits 4 naming both when the selector is ambiguous within the dataset', () => {
    const dir = setup(BASELINE_SCORES);
    const report = gateReport({ ...request(dir), options: { baseline: 'fts5', failUnder: 0.01 } });
    expect(report.exitCode).toBe(4);
    expect(report.lines.join('\n')).toContain('ambiguous');
  });

  it('resolves the baseline PER DATASET, ignoring another dataset carrying the selector', () => {
    const other = row({ dataset: 'vault-hu' });
    const dir = setup(BASELINE_SCORES.map(value => value + 0.02));
    const report = gateReport({ ...request(dir), history: [other, BASELINE, LATEST] });
    expect(report.exitCode).toBe(0);
  });
});
