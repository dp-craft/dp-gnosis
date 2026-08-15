import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  type DatasetResult,
  HISTORY_FILE,
  readHistory,
  reportStem,
  type RunProvenance,
  writeRunReport
} from './report.js';

const tempResultsDir = (): string => mkdtempSync(resolve(tmpdir(), 'gnosis-bench-report-'));

const provenance: RunProvenance = {
  ts: '2026-08-14T09:30:00.000Z',
  gitSha: 'abc1234',
  adapter: 'fts5',
  depth: 100,
  rerank: false,
};

const result: DatasetResult = {
  dataset: 'scifact',
  domain: 'scientific-claims',
  docShape: 'abstract',
  queryShape: 'claim',
  corpusBytes: 4096,
  corpusLines: 5183,
  atomMaxChars: 4000,
  topics: 300,
  docCount: 5183,
  atomCount: 5202,
  ingestMs: 1200,
  queryMs: 340,
  queryP50Ms: 11,
  queryP95Ms: 29,
  metrics: { ndcg10: 0.6863, recall10: 0.8, recall100: 0.9177, mrr10: 0.66 },
  metricsSd: { ndcg10: 0.31, recall10: 0.28, recall100: 0.19, mrr10: 0.36 },
  perTopic: [{ queryId: 'q1', metrics: { ndcg10: 1, recall10: 1, recall100: 1, mrr10: 1 } }],
};

/**
 * Copied VERBATIM from `results/history.jsonl` (run `cd7c4cf3`, 2026-08-14).
 * It predates `domain`/`docShape`/the sd and latency fields; if those are ever
 * made required on the read path, this row — and every other recorded run —
 * silently vanishes from the progress log.
 */
const OLD_FORMAT_ROW =
  '{"ts":"2026-08-14T08:34:25.205Z","gitSha":"cd7c4cf3","dataset":"scifact",' +
  '"corpusBytes":8106566,"corpusLines":5183,"adapter":"fts5","atomMaxChars":null,' +
  '"depth":100,"rerank":false,"topics":300,"docCount":5183,"atomCount":5202,' +
  '"ingestMs":1862,"queryMs":3800,"ndcg10":0.6857658517007484,' +
  '"recall10":0.8249444444444444,"recall100":0.9176666666666667,' +
  '"mrr10":0.6475515873015872}';

describe('reportStem', () => {
  it('is YYYY-MM-DD-HHMM, matching the repo-wide stem convention', () => {
    expect(reportStem(provenance.ts)).toBe('2026-08-14-0930');
  });
});

describe('writeRunReport', () => {
  it('appends one history row per dataset carrying every provenance field', () => {
    const dir = tempResultsDir();
    writeRunReport({ resultsDir: dir, provenance, results: [result] });
    const rows = readHistory(resolve(dir, HISTORY_FILE));
    expect(rows).toHaveLength(1);
    expect(Object.keys(rows[0] ?? {}).sort()).toEqual(
      [
        'adapter',
        'atomCount',
        'atomMaxChars',
        'corpusBytes',
        'corpusLines',
        'dataset',
        'depth',
        'docCount',
        'docShape',
        'domain',
        'gitSha',
        'ingestMs',
        'mrr10',
        'mrr10Sd',
        'ndcg10',
        'ndcg10Sd',
        'queryMs',
        'queryP50Ms',
        'queryP95Ms',
        'queryShape',
        'recall10',
        'recall100',
        'recall100Sd',
        'recall10Sd',
        'rerank',
        'perTopicPath',
        'topics',
        'ts',
      ].sort()
    );
    expect(rows[0]?.corpusBytes).toBe(4096);
    expect(rows[0]?.ndcg10).toBeCloseTo(0.6863, 12);
    expect(rows[0]?.rerank).toBe(false);
  });

  it('carries the dataset descriptors so runs can be grouped by domain', () => {
    const dir = tempResultsDir();
    writeRunReport({ resultsDir: dir, provenance, results: [result] });
    const row = readHistory(resolve(dir, HISTORY_FILE))[0];
    expect(row?.domain).toBe('scientific-claims');
    expect(row?.docShape).toBe('abstract');
    expect(row?.queryShape).toBe('claim');
  });

  it('records the per-topic sd and the query latency distribution next to the means', () => {
    const dir = tempResultsDir();
    writeRunReport({ resultsDir: dir, provenance, results: [result] });
    const row = readHistory(resolve(dir, HISTORY_FILE))[0];
    expect(row?.ndcg10Sd).toBeCloseTo(0.31, 12);
    expect(row?.recall10Sd).toBeCloseTo(0.28, 12);
    expect(row?.recall100Sd).toBeCloseTo(0.19, 12);
    expect(row?.mrr10Sd).toBeCloseTo(0.36, 12);
    expect(row?.queryP50Ms).toBe(11);
    expect(row?.queryP95Ms).toBe(29);
  });

  it('omits queryShape entirely when the manifest entry has none', () => {
    const dir = tempResultsDir();
    const { queryShape: _dropped, ...withoutShape } = result;
    writeRunReport({ resultsDir: dir, provenance, results: [withoutShape] });
    const row = readHistory(resolve(dir, HISTORY_FILE))[0];
    expect(row).toBeDefined();
    expect(Object.keys(row ?? {})).not.toContain('queryShape');
  });

  it('writes the markdown, the json sidecar, and the per-topic tsv unconditionally', () => {
    const dir = tempResultsDir();
    const written = writeRunReport({ resultsDir: dir, provenance, results: [result] });
    expect(written.markdownPath).toContain('2026-08-14-0930-abc1234.md');
    expect(written.jsonPath).toContain('2026-08-14-0930-abc1234.json');
    const markdown = readFileSync(written.markdownPath, 'utf8');
    expect(markdown).toContain('scifact');
    expect(markdown).toContain('scientific-claims');
    expect(markdown).toContain('abstract');
    expect(written.perTopicPaths).toHaveLength(1);
    expect(readFileSync(written.perTopicPaths[0] ?? '', 'utf8')).toContain('q1');
  });

  it('records on the row the per-topic file it just wrote, keyed by adapter and instant', () => {
    const dir = tempResultsDir();
    const written = writeRunReport({ resultsDir: dir, provenance, results: [result] });
    const row = readHistory(resolve(dir, HISTORY_FILE))[0];
    expect(row?.perTopicPath).toBe('per-topic/2026-08-14-093000000-fts5-scifact.tsv');
    expect(resolve(dir, row?.perTopicPath ?? '')).toBe(written.perTopicPaths[0]);
    expect(readFileSync(resolve(dir, row?.perTopicPath ?? ''), 'utf8')).toContain('q1');
  });

  it('gives two adapters run in the same minute their own per-topic files', () => {
    const dir = tempResultsDir();
    writeRunReport({ resultsDir: dir, provenance, results: [result] });
    writeRunReport({
      resultsDir: dir,
      provenance: { ...provenance, adapter: 'lancedb' },
      results: [result],
    });
    const rows = readHistory(resolve(dir, HISTORY_FILE));
    expect(rows[0]?.perTopicPath).not.toBe(rows[1]?.perTopicPath);
    expect(rows[1]?.perTopicPath).toContain('lancedb');
  });

  it('keeps appending: a second run adds a row rather than replacing the record', () => {
    const dir = tempResultsDir();
    writeRunReport({ resultsDir: dir, provenance, results: [result] });
    writeRunReport({ resultsDir: dir, provenance, results: [result] });
    expect(readHistory(resolve(dir, HISTORY_FILE))).toHaveLength(2);
  });
});

describe('readHistory', () => {
  it('still returns a row recorded BEFORE domain/sd/latency existed', () => {
    const dir = tempResultsDir();
    const path = resolve(dir, HISTORY_FILE);
    writeFileSync(path, `${OLD_FORMAT_ROW}\n`, 'utf8');
    const rows = readHistory(path);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.dataset).toBe('scifact');
    expect(rows[0]?.ndcg10).toBeCloseTo(0.6857658517007484, 12);
    expect(rows[0]?.domain).toBeUndefined();
    expect(rows[0]?.ndcg10Sd).toBeUndefined();
    expect(rows[0]?.queryP95Ms).toBeUndefined();
  });

  it('skips a malformed line instead of throwing — one bad row cannot brick the record', () => {
    const dir = tempResultsDir();
    writeRunReport({ resultsDir: dir, provenance, results: [result] });
    const path = resolve(dir, HISTORY_FILE);
    writeFileSync(path, `${readFileSync(path, 'utf8')}not json at all\n{"ts":"x"}\n`, 'utf8');
    const rows = readHistory(path);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.dataset).toBe('scifact');
  });

  it('returns nothing for a record that does not exist yet', () => {
    expect(readHistory(resolve(tempResultsDir(), HISTORY_FILE))).toEqual([]);
  });
});
