/**
 * The progress record: four artefacts per run, one of them append-only.
 *
 * | File | Why it exists |
 * |---|---|
 * | `<stem>-<sha>.md` | a human reads one row per dataset |
 * | `<stem>-<sha>.json` | the same numbers, machine-readable, for a later diff |
 * | `per-topic/<stem>-<dataset>.tsv` | per-topic scores, so a paired test can be run LATER without re-running the benchmark |
 * | `history.jsonl` | one line per (run, dataset) — the progress table `--compare` reads |
 *
 * The history row carries PROVENANCE next to the metrics, and that is the whole
 * point of the file. Commit `0ee258ea` changed the measuring scale and the
 * numbers were chained across it anyway, because nothing recorded what the
 * scale had been. `corpusBytes`/`corpusLines` are the cheap dataset checksum:
 * a re-downloaded or re-labelled corpus changes them, so `compare.ts` can
 * refuse to subtract two numbers that were never comparable.
 *
 * The stem convention (`YYYY-MM-DD-HHMM`) is the repo's, from
 * `tools/dp-gnosis/src/bench/report.ts:26`.
 *
 * `readHistory` NEVER throws. The file is append-only and hand-inspectable; a
 * truncated or hand-edited line must cost one row, not the entire record.
 */
import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import type { Metrics } from './metrics.js';
import type { TopicScore } from './score.js';

const DATE_CHARS = 10;
const TIME_CHARS = 5;
const METRIC_DIGITS = 4;

/** The append-only progress table, relative to the results directory. */
export const HISTORY_FILE = 'history.jsonl';

/** Per-topic TSVs live in their own subdirectory to keep the run files scannable. */
export const PER_TOPIC_DIR = 'per-topic';

/** Facts true of the whole run — identical on every dataset's history row. */
export interface RunProvenance {
  /** ISO timestamp; the report stem is derived from it, so the two cannot drift. */
  readonly ts: string;
  readonly gitSha: string;
  readonly adapter: string;
  readonly depth: number;
  readonly rerank: boolean;
}

/** One dataset's outcome plus the provenance that is specific to that dataset. */
export interface DatasetResult {
  readonly dataset: string;
  /** Byte size of the dataset's `corpus.jsonl` — half the cheap checksum. */
  readonly corpusBytes: number;
  /** Non-empty line count of the dataset's `corpus.jsonl` — the other half. */
  readonly corpusLines: number;
  /**
   * The EFFECTIVE atom cap the run used — the manifest's value, or the engine
   * default resolved by the caller when the manifest is silent. Never `null`:
   * two runs straddling a change to that default would both record `null` and
   * `compare.ts` would subtract numbers taken on different scales.
   */
  readonly atomMaxChars: number;
  readonly topics: number;
  readonly docCount: number;
  readonly atomCount: number;
  readonly ingestMs: number;
  readonly queryMs: number;
  readonly metrics: Metrics;
  readonly perTopic: readonly TopicScore[];
}

/** One line of `history.jsonl`: the four metrics, flattened next to provenance. */
export interface HistoryRow extends Metrics {
  readonly ts: string;
  readonly gitSha: string;
  readonly dataset: string;
  readonly corpusBytes: number;
  readonly corpusLines: number;
  readonly adapter: string;
  /** `null` only in rows written before the effective value was recorded. */
  readonly atomMaxChars: number | null;
  readonly depth: number;
  readonly rerank: boolean;
  readonly topics: number;
  readonly docCount: number;
  readonly atomCount: number;
  readonly ingestMs: number;
  readonly queryMs: number;
}

/** What one run wrote, so the caller can name the files it just produced. */
export interface WrittenReport {
  readonly markdownPath: string;
  readonly jsonPath: string;
  readonly historyPath: string;
  readonly perTopicPaths: readonly string[];
}

/** Everything `writeRunReport` needs; `perTopic` gates the TSVs only. */
export interface RunReportOptions {
  readonly resultsDir: string;
  readonly provenance: RunProvenance;
  readonly results: readonly DatasetResult[];
  readonly perTopic: boolean;
}

/** The cheap dataset checksum — byte size and line count of `corpus.jsonl`. */
export interface CorpusChecksum {
  readonly corpusBytes: number;
  readonly corpusLines: number;
}

/** `2026-08-14T09:30:00.000Z` → `2026-08-14-0930`. */
export const reportStem = (generatedAt: string): string => {
  const date = generatedAt.slice(0, DATE_CHARS);
  const time = generatedAt.slice(DATE_CHARS + 1, DATE_CHARS + 1 + TIME_CHARS).replace(':', '');
  return `${date}-${time}`;
};

/** Recorded when the tree is not a git checkout — never silently omitted. */
export const UNKNOWN_SHA = 'unknown';

/**
 * The short sha the run is attributed to. A failure to read it yields
 * `UNKNOWN_SHA` rather than throwing: an unattributable run is still worth
 * recording, and `compare.ts` does not gate on the sha.
 */
export const currentGitSha = (cwd: string): string => {
  try {
    return execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd, encoding: 'utf8' }).trim();
  } catch {
    return UNKNOWN_SHA;
  }
};

/**
 * Byte size and non-empty line count of a corpus file. Cheap enough to run on
 * every dataset of every run, and it changes whenever the corpus does — which
 * is exactly the condition under which two runs must not be subtracted.
 */
export const corpusChecksum = (corpusPath: string): CorpusChecksum => ({
  corpusBytes: statSync(corpusPath).size,
  corpusLines: readFileSync(corpusPath, 'utf8')
    .split('\n')
    .filter(line => line.trim().length > 0).length,
});

const toHistoryRow = (provenance: RunProvenance, result: DatasetResult): HistoryRow => ({
  ts: provenance.ts,
  gitSha: provenance.gitSha,
  dataset: result.dataset,
  corpusBytes: result.corpusBytes,
  corpusLines: result.corpusLines,
  adapter: provenance.adapter,
  atomMaxChars: result.atomMaxChars,
  depth: provenance.depth,
  rerank: provenance.rerank,
  topics: result.topics,
  docCount: result.docCount,
  atomCount: result.atomCount,
  ingestMs: result.ingestMs,
  queryMs: result.queryMs,
  ...result.metrics,
});

const STRING_FIELDS: readonly string[] = ['ts', 'gitSha', 'dataset', 'adapter'];

const NUMBER_FIELDS: readonly string[] = [
  'corpusBytes',
  'corpusLines',
  'depth',
  'topics',
  'docCount',
  'atomCount',
  'ingestMs',
  'queryMs',
  'ndcg10',
  'recall10',
  'recall100',
  'mrr10',
];

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isHistoryRow = (value: unknown): value is HistoryRow =>
  isRecord(value) &&
  typeof value['rerank'] === 'boolean' &&
  STRING_FIELDS.every(field => typeof value[field] === 'string') &&
  NUMBER_FIELDS.every(field => typeof value[field] === 'number');

/** A line that is not valid JSON, or not a complete row, yields nothing. */
const parseHistoryLine = (line: string): HistoryRow | undefined => {
  try {
    const parsed: unknown = JSON.parse(line);
    return isHistoryRow(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
};

const isRow = (row: HistoryRow | undefined): row is HistoryRow => row !== undefined;

/** Every well-formed row, oldest first. A missing file is an empty record. */
export const readHistory = (historyPath: string): readonly HistoryRow[] =>
  existsSync(historyPath)
    ? readFileSync(historyPath, 'utf8')
        .split('\n')
        .filter(line => line.trim().length > 0)
        .map(parseHistoryLine)
        .filter(isRow)
    : [];

/** Append, never rewrite: the record's value is that older rows cannot move. */
export const appendHistory = (historyPath: string, rows: readonly HistoryRow[]): void => {
  mkdirSync(dirname(historyPath), { recursive: true });
  appendFileSync(historyPath, rows.map(row => `${JSON.stringify(row)}\n`).join(''), 'utf8');
};

const metric = (value: number): string => value.toFixed(METRIC_DIGITS);

const markdownRow = (result: DatasetResult): string =>
  `| ${result.dataset} | ${result.topics} | ${metric(result.metrics.ndcg10)} | ` +
  `${metric(result.metrics.recall10)} | ${metric(result.metrics.recall100)} | ` +
  `${metric(result.metrics.mrr10)} |`;

const markdownHeader = (provenance: RunProvenance): readonly string[] => [
  '# dp-gnosis-bench run',
  '',
  `- generated at: \`${provenance.ts}\``,
  `- git sha: \`${provenance.gitSha}\``,
  `- adapter: \`${provenance.adapter}\`, depth: ${provenance.depth}, rerank: ${provenance.rerank}`,
  '',
  '> Scores are DOCUMENT-level: atoms are rolled up to their origin document before',
  '> scoring, so they stay comparable across chunker changes.',
  '',
  '| dataset | topics | nDCG@10 | R@10 | R@100 | MRR@10 |',
  '|---|---|---|---|---|---|',
];

const renderMarkdown = (provenance: RunProvenance, results: readonly DatasetResult[]): string =>
  [...markdownHeader(provenance), ...results.map(markdownRow), ''].join('\n');

const TSV_HEADER = 'query_id\tndcg10\trecall10\trecall100\tmrr10';

const tsvRow = (topic: TopicScore): string =>
  [
    topic.queryId,
    metric(topic.metrics.ndcg10),
    metric(topic.metrics.recall10),
    metric(topic.metrics.recall100),
    metric(topic.metrics.mrr10),
  ].join('\t');

const renderPerTopicTsv = (result: DatasetResult): string =>
  [TSV_HEADER, ...result.perTopic.map(tsvRow), ''].join('\n');

const writePerTopic = (
  resultsDir: string,
  stem: string,
  result: DatasetResult
): string => {
  const path = resolve(resultsDir, PER_TOPIC_DIR, `${stem}-${result.dataset}.tsv`);
  writeFileSync(path, renderPerTopicTsv(result), 'utf8');
  return path;
};

const writePerTopicFiles = (options: RunReportOptions, stem: string): readonly string[] => {
  if (!options.perTopic) return [];
  mkdirSync(resolve(options.resultsDir, PER_TOPIC_DIR), { recursive: true });
  return options.results.map(result => writePerTopic(options.resultsDir, stem, result));
};

/**
 * Write the run's four artefacts. The markdown and the JSON share a stem so a
 * summary can never be separated from the record it was rendered from.
 */
export const writeRunReport = (options: RunReportOptions): WrittenReport => {
  const stem = reportStem(options.provenance.ts);
  const base = resolve(options.resultsDir, `${stem}-${options.provenance.gitSha}`);
  mkdirSync(options.resultsDir, { recursive: true });
  writeFileSync(`${base}.md`, renderMarkdown(options.provenance, options.results), 'utf8');
  const record = { provenance: options.provenance, results: options.results };
  writeFileSync(`${base}.json`, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
  const historyPath = resolve(options.resultsDir, HISTORY_FILE);
  appendHistory(historyPath, options.results.map(r => toHistoryRow(options.provenance, r)));
  return {
    markdownPath: `${base}.md`,
    jsonPath: `${base}.json`,
    historyPath,
    perTopicPaths: writePerTopicFiles(options, stem),
  };
};
