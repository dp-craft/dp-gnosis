/**
 * The progress record: four artefacts per run, one of them append-only.
 *
 * | File | Why it exists |
 * |---|---|
 * | `<stem>-<sha>.md` | a human reads one row per dataset |
 * | `<stem>-<sha>.json` | the same numbers, machine-readable, for a later diff |
 * | `per-topic/<instant>-<adapter>-<dataset>.tsv` | per-topic scores, so a paired test can be run LATER without re-running the benchmark |
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

import { countNonEmptyLines } from './lines.js';
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
  /** Manifest report metadata, carried through so runs can be grouped by it. */
  readonly domain: string;
  readonly docShape: string;
  /** Absent on entries whose manifest does not describe the query form. */
  readonly queryShape?: string | undefined;
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
  /** Wall time of the whole query phase — kept next to the distribution. */
  readonly queryMs: number;
  readonly queryP50Ms: number;
  readonly queryP95Ms: number;
  readonly metrics: Metrics;
  /** Sample sd (n-1) of the per-topic values behind `metrics`. */
  readonly metricsSd: Metrics;
  readonly perTopic: readonly TopicScore[];
}

/**
 * One line of `history.jsonl`: the four metrics, flattened next to provenance.
 *
 * Every field added after the first recorded run is OPTIONAL, exactly as
 * `atomMaxChars` is nullable. `readHistory` drops a row it cannot recognise, so
 * requiring a late field would erase every earlier run from the progress log —
 * the one thing this append-only file exists to prevent.
 */
export interface HistoryRow extends Metrics {
  readonly ts: string;
  readonly gitSha: string;
  readonly dataset: string;
  /** Descriptive, not provenance — absent on rows written before it existed. */
  readonly domain?: string;
  readonly docShape?: string;
  readonly queryShape?: string;
  /** Sample sd (n-1) of the per-topic values; absent on older rows. */
  readonly ndcg10Sd?: number;
  readonly recall10Sd?: number;
  readonly recall100Sd?: number;
  readonly mrr10Sd?: number;
  /** Per-query latency distribution; absent on older rows. */
  readonly queryP50Ms?: number;
  readonly queryP95Ms?: number;
  readonly corpusBytes: number;
  readonly corpusLines: number;
  readonly adapter: string;
  /**
   * The run's OWN per-topic TSV, relative to the results directory. Absent on
   * rows written before it existed, and a paired test REFUSES such a row rather
   * than deriving a path: a derived name cannot tell two arms recorded in the
   * same minute apart, so the derivation silently pairs a run with itself.
   */
  readonly perTopicPath?: string;
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

/** Everything `writeRunReport` needs. The per-topic TSVs are not optional. */
export interface RunReportOptions {
  readonly resultsDir: string;
  readonly provenance: RunProvenance;
  readonly results: readonly DatasetResult[];
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

/** Through the milliseconds: `2026-08-14T09:30:12.345Z` → `2026-08-14-093012345`. */
const RUN_STAMP_CHARS = 23;

/**
 * The run instant at millisecond resolution — the report stem's minute cannot
 * separate two runs launched in the same minute.
 */
export const runStamp = (generatedAt: string): string =>
  generatedAt.slice(0, RUN_STAMP_CHARS).replace('T', '-').replace(/[:.]/g, '');

/**
 * `per-topic/<instant>-<adapter>-<dataset>.tsv`, relative to the results dir.
 *
 * Adapter and instant are BOTH in the name because either alone still collides:
 * two arms of one comparison share a minute, and two runs of one arm share an
 * adapter. The row records this exact string, so a reader never re-derives it.
 */
export const perTopicRelPath = (provenance: RunProvenance, dataset: string): string =>
  `${PER_TOPIC_DIR}/${runStamp(provenance.ts)}-${provenance.adapter}-${dataset}.tsv`;

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
 *
 * The count streams (`lines.ts`) because a corpus above Node's ~0.5 GB
 * single-string cap cannot be read into one string; the counted line set is
 * unchanged, and `lines.test.ts` pins it against the old expression.
 */
export const corpusChecksum = (corpusPath: string): CorpusChecksum => ({
  corpusBytes: statSync(corpusPath).size,
  corpusLines: countNonEmptyLines(corpusPath),
});

type DescriptorFields = Pick<HistoryRow, 'domain' | 'docShape' | 'queryShape'>;
type SdFields = Pick<HistoryRow, 'ndcg10Sd' | 'recall10Sd' | 'recall100Sd' | 'mrr10Sd'>;
type CostFields = Pick<
  HistoryRow,
  'topics' | 'docCount' | 'atomCount' | 'ingestMs' | 'queryMs' | 'queryP50Ms' | 'queryP95Ms'
>;

/** `queryShape` is optional on the manifest, so an absent one writes no key. */
const descriptorFields = (result: DatasetResult): DescriptorFields => ({
  domain: result.domain,
  docShape: result.docShape,
  ...(result.queryShape === undefined ? {} : { queryShape: result.queryShape }),
});

const sdFields = (sd: Metrics): SdFields => ({
  ndcg10Sd: sd.ndcg10,
  recall10Sd: sd.recall10,
  recall100Sd: sd.recall100,
  mrr10Sd: sd.mrr10,
});

const costFields = (result: DatasetResult): CostFields => ({
  topics: result.topics,
  docCount: result.docCount,
  atomCount: result.atomCount,
  ingestMs: result.ingestMs,
  queryMs: result.queryMs,
  queryP50Ms: result.queryP50Ms,
  queryP95Ms: result.queryP95Ms,
});

const toHistoryRow = (provenance: RunProvenance, result: DatasetResult): HistoryRow => ({
  ts: provenance.ts,
  gitSha: provenance.gitSha,
  dataset: result.dataset,
  corpusBytes: result.corpusBytes,
  corpusLines: result.corpusLines,
  adapter: provenance.adapter,
  perTopicPath: perTopicRelPath(provenance, result.dataset),
  atomMaxChars: result.atomMaxChars,
  depth: provenance.depth,
  rerank: provenance.rerank,
  ...descriptorFields(result),
  ...costFields(result),
  ...result.metrics,
  ...sdFields(result.metricsSd),
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

/** An unmeasurable cutoff reads as absent, not as a number. */
const optionalMetric = (value: number | undefined): string =>
  value === undefined ? '—' : metric(value);

/**
 * R@20 is in the human table because it is the RERANKER's objective — it reads
 * `RERANK_K_INIT`=20 candidates, so a gain that misses R@20 buys nothing
 * downstream. R@300/@1000 stay in the JSON and the per-topic TSV: they exist for
 * the depth curve, and a nine-metric row is unreadable.
 */
const markdownRow = (result: DatasetResult): string =>
  `| ${result.dataset} | ${result.domain} | ${result.docShape} | ${result.topics} | ` +
  `${metric(result.metrics.ndcg10)} | ${metric(result.metricsSd.ndcg10)} | ` +
  `${metric(result.metrics.recall10)} | ${optionalMetric(result.metrics.recall20)} | ` +
  `${metric(result.metrics.recall100)} | ` +
  `${metric(result.metrics.mrr10)} | ${result.queryP50Ms} | ${result.queryP95Ms} |`;

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
  '| dataset | domain | docShape | topics | nDCG@10 | nDCG@10 sd | R@10 | R@20 | R@100 | ' +
    'MRR@10 | q p50 ms | q p95 ms |',
  '|---|---|---|---|---|---|---|---|---|---|---|---|',
];

const renderMarkdown = (provenance: RunProvenance, results: readonly DatasetResult[]): string =>
  [...markdownHeader(provenance), ...results.map(markdownRow), ''].join('\n');

/** The per-topic TSV's key column; a file not starting with it is not ours. */
export const PER_TOPIC_QUERY_COLUMN = 'query_id';

/**
 * The metric columns, in file order. `significance.ts` reads a TSV by these
 * NAMES off its header line, never by position: files recorded before the recall
 * cutoffs existed carry the shorter header and must still parse.
 */
export const PER_TOPIC_METRIC_COLUMNS = [
  'ndcg10',
  'recall10',
  'recall20',
  'recall100',
  'recall300',
  'recall1000',
  'mrr10',
] as const satisfies readonly (keyof Metrics)[];

const TSV_HEADER = [PER_TOPIC_QUERY_COLUMN, ...PER_TOPIC_METRIC_COLUMNS].join('\t');

/** An unmeasurable cutoff is an EMPTY field — 0 would read as "measured, none". */
const tsvCell = (value: number | undefined): string => (value === undefined ? '' : metric(value));

const tsvRow = (topic: TopicScore): string =>
  [
    topic.queryId,
    ...PER_TOPIC_METRIC_COLUMNS.map(column => tsvCell(topic.metrics[column])),
  ].join('\t');

/**
 * The per-topic TSV body — the ONE serializer for this format. The BM25 sweep
 * writes its cells through it too, so `significance.readPerTopic` parses a run
 * and a sweep cell with the same parser and neither can drift from the other.
 */
export const renderPerTopicTsv = (perTopic: readonly TopicScore[]): string =>
  [TSV_HEADER, ...perTopic.map(tsvRow), ''].join('\n');

const writePerTopic = (
  resultsDir: string,
  provenance: RunProvenance,
  result: DatasetResult
): string => {
  const path = resolve(resultsDir, perTopicRelPath(provenance, result.dataset));
  writeFileSync(path, renderPerTopicTsv(result.perTopic), 'utf8');
  return path;
};

/**
 * ALWAYS written: without the per-topic scores a recorded run cannot be
 * re-analysed later (a paired test, a required-sample-size estimate) without
 * paying for the whole benchmark again.
 */
const writePerTopicFiles = (options: RunReportOptions): readonly string[] => {
  mkdirSync(resolve(options.resultsDir, PER_TOPIC_DIR), { recursive: true });
  return options.results.map(result =>
    writePerTopic(options.resultsDir, options.provenance, result)
  );
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
    perTopicPaths: writePerTopicFiles(options),
  };
};
