import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { DEFAULT_ANALYZER } from '../../dp-gnosis/src/query.js';
import {
  type DatasetResult,
  HISTORY_FILE,
  type HistoryRow,
  readHistory,
  recordDataset,
  renderTrecRun,
  reportStem,
  runFilePath,
  runFileRelPath,
  type RunProvenance,
  type RunReportOptions,
  runTag,
  writeRunSummary
} from './report.js';

const tempResultsDir = (): string => mkdtempSync(resolve(tmpdir(), 'gnosis-bench-report-'));

interface WrittenReport {
  readonly markdownPath: string;
  readonly jsonPath: string;
  readonly perTopicPaths: readonly string[];
  readonly runPaths: readonly string[];
}

/**
 * A whole suite that finishes normally, in the order `run.ts` produces it: every
 * dataset recorded as it completes, then the one end-of-run summary.
 */
const writeRunReport = (options: RunReportOptions): WrittenReport => {
  const recorded = options.results.map(result =>
    recordDataset({ resultsDir: options.resultsDir, provenance: options.provenance, result })
  );
  return {
    ...writeRunSummary(options),
    perTopicPaths: recorded.map(entry => entry.perTopicPath),
    runPaths: recorded.map(entry => entry.runPath),
  };
};

const provenance: RunProvenance = {
  ts: '2026-08-14T09:30:00.000Z',
  gitSha: 'abc1234',
  adapter: 'fts5',
  depth: 100,
  rerank: false,
  analyzer: DEFAULT_ANALYZER,
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
  metrics: {
    ndcg10: 0.6863,
    recall10: 0.8,
    recall20: 0.85,
    recall100: 0.9177,
    recall300: undefined,
    recall1000: undefined,
    mrr10: 0.66,
  },
  metricsSd: {
    ndcg10: 0.31,
    recall10: 0.28,
    recall20: 0.26,
    recall100: 0.19,
    recall300: undefined,
    recall1000: undefined,
    mrr10: 0.36,
  },
  rankings: new Map([['q1', ['doc-a', 'doc-b']]]),
  perTopic: [
    {
      queryId: 'q1',
      metrics: {
        ndcg10: 1,
        recall10: 1,
        recall20: 1,
        recall100: 1,
        recall300: undefined,
        recall1000: undefined,
        mrr10: 1,
      },
    },
  ],
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
        'analyzer',
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
        'recall20',
        'recall100',
        'recall100Sd',
        'recall10Sd',
        'rerank',
        'perTopicPath',
        'runPath',
        'topics',
        'ts',
      ].sort()
    );
    expect(rows[0]?.corpusBytes).toBe(4096);
    expect(rows[0]?.ndcg10).toBeCloseTo(0.6863, 12);
    expect(rows[0]?.rerank).toBe(false);
  });

  it('records the analysis chain on the row, so --compare can see an analyzer change', () => {
    const dir = tempResultsDir();
    writeRunReport({ resultsDir: dir, provenance, results: [result] });
    expect(readHistory(resolve(dir, HISTORY_FILE))[0]?.analyzer).toBe(DEFAULT_ANALYZER);
  });

  it('records a NON-default analysis chain under its own name', () => {
    const dir = tempResultsDir();
    writeRunReport({
      resultsDir: dir,
      provenance: { ...provenance, analyzer: 'nostem-fold' },
      results: [result],
    });
    expect(readHistory(resolve(dir, HISTORY_FILE))[0]?.analyzer).toBe('nostem-fold');
  });

  it('records the rerank protocol on the row, so --compare can see a fusion change', () => {
    const dir = tempResultsDir();
    writeRunReport({
      resultsDir: dir,
      provenance: { ...provenance, rerank: true, rerankProfile: 'beir-ce' },
      results: [result],
    });
    const row = readHistory(resolve(dir, HISTORY_FILE))[0];
    expect(row?.rerankProfile).toBe('beir-ce');
    expect(row?.rerankWeight).toBeUndefined();
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

  it('names the analysis chain in the markdown header, so an arm cannot read as the baseline', () => {
    const dir = tempResultsDir();
    const written = writeRunReport({
      resultsDir: dir,
      provenance: { ...provenance, analyzer: 'nostem-fold' },
      results: [result],
    });
    expect(readFileSync(written.markdownPath, 'utf8')).toContain('analyzer: `nostem-fold`');
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

describe('renderTrecRun', () => {
  const lines = (body: string): readonly string[] =>
    body.split('\n').filter(line => line.length > 0);

  it('renders qid Q0 docid rank score tag, with a 1-based rank', () => {
    const body = renderTrecRun(new Map([['q1', ['doc-a', 'doc-b']]]), 'fts5');
    expect(lines(body)).toEqual(['q1 Q0 doc-a 1 2 fts5', 'q1 Q0 doc-b 2 1 fts5']);
  });

  it('never ties two scores in one topic — trec_eval re-sorts by score, not by our order', () => {
    const ranking = ['a', 'b', 'c', 'd'];
    const scores = lines(renderTrecRun(new Map([['q1', ranking]]), 'fts5')).map(line =>
      Number(line.split(' ')[4])
    );
    expect(new Set(scores).size).toBe(ranking.length);
    expect([...scores].sort((x, y) => y - x)).toEqual(scores);
  });

  it('writes no line for a topic that retrieved nothing, and an empty body for no topics', () => {
    const withEmptyTopic = new Map<string, readonly string[]>([
      ['q1', []],
      ['q2', ['doc-a']],
    ]);
    expect(renderTrecRun(withEmptyTopic, 'fts5')).toBe('q2 Q0 doc-a 1 1 fts5\n');
    expect(renderTrecRun(new Map(), 'fts5')).toBe('');
  });

  it('tags the run with the adapter, and names the rerank arm apart from it', () => {
    expect(runTag(provenance)).toBe('fts5');
    expect(runTag({ ...provenance, rerank: true })).toBe('fts5-rerank');
  });
});

describe('runFileRelPath', () => {
  it('keys the file by millisecond instant, adapter and dataset', () => {
    expect(runFileRelPath(provenance, 'scifact')).toBe(
      'runs/2026-08-14-093000000-fts5-scifact.trec'
    );
  });

  it('separates two adapters that differ in nothing but the arm', () => {
    expect(runFileRelPath(provenance, 'scifact')).not.toBe(
      runFileRelPath({ ...provenance, adapter: 'lancedb' }, 'scifact')
    );
  });
});

describe('runFilePath', () => {
  it('resolves the recorded field, never a reconstructed name', () => {
    const dir = tempResultsDir();
    const written = writeRunReport({ resultsDir: dir, provenance, results: [result] });
    const row = readHistory(resolve(dir, HISTORY_FILE))[0];
    expect(row?.runPath).toBe('runs/2026-08-14-093000000-fts5-scifact.trec');
    expect(runFilePath(dir, row as HistoryRow)).toBe(written.runPaths[0]);
  });

  it('reports NOT AVAILABLE for a legacy row that records no run path', () => {
    const legacy = JSON.parse(OLD_FORMAT_ROW) as HistoryRow;
    expect(legacy.runPath).toBeUndefined();
    expect(runFilePath('/results', legacy)).toBeUndefined();
  });
});

describe('the TREC run file', () => {
  it('is written unconditionally, one per dataset, from the run rankings', () => {
    const dir = tempResultsDir();
    const written = writeRunReport({ resultsDir: dir, provenance, results: [result] });
    expect(written.runPaths).toHaveLength(1);
    expect(readFileSync(written.runPaths[0] ?? '', 'utf8')).toBe(
      'q1 Q0 doc-a 1 2 fts5\nq1 Q0 doc-b 2 1 fts5\n'
    );
  });

  it('keeps the rankings out of the JSON summary — the run file owns them', () => {
    const dir = tempResultsDir();
    const written = writeRunReport({ resultsDir: dir, provenance, results: [result] });
    expect(readFileSync(written.jsonPath, 'utf8')).not.toContain('rankings');
  });
});

describe('the new recall cutoffs', () => {
  const readPerTopicTsv = (dir: string): readonly string[] =>
    readFileSync(
      writeRunReport({ resultsDir: dir, provenance, results: [result] }).perTopicPaths[0] ?? '',
      'utf8'
    ).split('\n');

  it('names every cutoff in the per-topic TSV header', () => {
    expect(readPerTopicTsv(tempResultsDir())[0]).toBe(
      'query_id\tndcg10\trecall10\trecall20\trecall100\trecall300\trecall1000\tmrr10'
    );
  });

  it('writes an unmeasurable cutoff as an EMPTY field, never as 0', () => {
    const header = readPerTopicTsv(tempResultsDir())[0]?.split('\t') ?? [];
    const row = readPerTopicTsv(tempResultsDir())[1]?.split('\t') ?? [];
    expect(row[header.indexOf('recall20')]).toBe('1.0000');
    expect(row[header.indexOf('recall300')]).toBe('');
    expect(row[header.indexOf('recall1000')]).toBe('');
  });

  it('records a measured recall@20 on the history row and OMITS the unmeasurable ones', () => {
    const dir = tempResultsDir();
    writeRunReport({ resultsDir: dir, provenance, results: [result] });
    const row = readHistory(resolve(dir, HISTORY_FILE))[0];
    expect(row?.recall20).toBeCloseTo(0.85, 12);
    expect(Object.keys(row ?? {})).not.toContain('recall300');
    expect(Object.keys(row ?? {})).not.toContain('recall1000');
  });

  it('shows R@20 in the human table — the reranker objective — but not @300/@1000', () => {
    const dir = tempResultsDir();
    const markdown = readFileSync(
      writeRunReport({ resultsDir: dir, provenance, results: [result] }).markdownPath,
      'utf8'
    );
    expect(markdown).toContain('| R@20 |');
    expect(markdown).not.toContain('R@300');
    expect(markdown).not.toContain('R@1000');
    expect(markdown).toContain('0.8500');
  });
});
