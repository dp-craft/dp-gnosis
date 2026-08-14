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
  corpusBytes: 4096,
  corpusLines: 5183,
  atomMaxChars: 4000,
  topics: 300,
  docCount: 5183,
  atomCount: 5202,
  ingestMs: 1200,
  queryMs: 340,
  metrics: { ndcg10: 0.6863, recall10: 0.8, recall100: 0.9177, mrr10: 0.66 },
  perTopic: [{ queryId: 'q1', metrics: { ndcg10: 1, recall10: 1, recall100: 1, mrr10: 1 } }],
};

describe('reportStem', () => {
  it('is YYYY-MM-DD-HHMM, matching the repo-wide stem convention', () => {
    expect(reportStem(provenance.ts)).toBe('2026-08-14-0930');
  });
});

describe('writeRunReport', () => {
  it('appends one history row per dataset carrying every provenance field', () => {
    const dir = tempResultsDir();
    writeRunReport({ resultsDir: dir, provenance, results: [result], perTopic: false });
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
        'gitSha',
        'ingestMs',
        'mrr10',
        'ndcg10',
        'queryMs',
        'recall10',
        'recall100',
        'rerank',
        'topics',
        'ts',
      ].sort()
    );
    expect(rows[0]?.corpusBytes).toBe(4096);
    expect(rows[0]?.ndcg10).toBeCloseTo(0.6863, 12);
    expect(rows[0]?.rerank).toBe(false);
  });

  it('writes the markdown, the json sidecar, and the per-topic tsv only when asked', () => {
    const dir = tempResultsDir();
    const written = writeRunReport({
      resultsDir: dir,
      provenance,
      results: [result],
      perTopic: true,
    });
    expect(written.markdownPath).toContain('2026-08-14-0930-abc1234.md');
    expect(written.jsonPath).toContain('2026-08-14-0930-abc1234.json');
    expect(readFileSync(written.markdownPath, 'utf8')).toContain('scifact');
    expect(written.perTopicPaths).toHaveLength(1);
    expect(readFileSync(written.perTopicPaths[0] ?? '', 'utf8')).toContain('q1');
  });

  it('keeps appending: a second run adds a row rather than replacing the record', () => {
    const dir = tempResultsDir();
    writeRunReport({ resultsDir: dir, provenance, results: [result], perTopic: false });
    writeRunReport({ resultsDir: dir, provenance, results: [result], perTopic: false });
    expect(readHistory(resolve(dir, HISTORY_FILE))).toHaveLength(2);
  });
});

describe('readHistory', () => {
  it('skips a malformed line instead of throwing — one bad row cannot brick the record', () => {
    const dir = tempResultsDir();
    writeRunReport({ resultsDir: dir, provenance, results: [result], perTopic: false });
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
