/**
 * The progress record: five artefacts per run, one of them append-only.
 *
 * | File | Why it exists |
 * |---|---|
 * | `<stem>-<sha>.md` | a human reads one row per dataset |
 * | `<stem>-<sha>.json` | the same numbers, machine-readable, for a later diff |
 * | `per-topic/<instant>-<adapter>-<dataset>.tsv` | per-topic scores, so a paired test can be run LATER without re-running the benchmark |
 * | `runs/<instant>-<adapter>-<dataset>.trec` | the per-topic RANKINGS, in the format an external evaluator already reads |
 * | `history.jsonl` | one line per (run, dataset) — the progress table `--compare` reads |
 *
 * The first three are written PER DATASET, as it completes (`recordDataset`);
 * only the `.md`/`.json` summary is a whole-run artefact (`writeRunSummary`).
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

import type { TopicFacets } from './beir.js';
import { countNonEmptyLines } from './lines.js';
import type { Metrics } from './metrics.js';
import type { AtomSpread, AxisStratum, TopicScore } from './score.js';

const DATE_CHARS = 10;
const TIME_CHARS = 5;
const METRIC_DIGITS = 4;

/** The append-only progress table, relative to the results directory. */
export const HISTORY_FILE = 'history.jsonl';

/** Per-topic TSVs live in their own subdirectory to keep the run files scannable. */
export const PER_TOPIC_DIR = 'per-topic';

/** TREC run files live in their own subdirectory — they are the bulky artefact. */
export const RUN_FILE_DIR = 'runs';

/** Facts true of the whole run — identical on every dataset's history row. */
export interface RunProvenance {
  /** ISO timestamp; the report stem is derived from it, so the two cannot drift. */
  readonly ts: string;
  readonly gitSha: string;
  readonly adapter: string;
  readonly depth: number;
  readonly rerank: boolean;
  /**
   * The rerank protocol BY NAME, and the EFFECTIVE weight it fused at — the
   * `--rerank-weight` override when one was given, else the preset's own. Both
   * absent on a run that did not rerank — there is no protocol to record for one
   * — and the weight is absent on a `replace` protocol, which has no weight term.
   */
  readonly rerankProfile?: string | undefined;
  readonly rerankWeight?: number | undefined;
  /**
   * The cross-encoder id the rerank arm scored with — absent for the same reason
   * the two fields above are, present and RESOLVED on every run that reranked.
   */
  readonly rerankModel?: string | undefined;
  /**
   * The FIRST-PASS pool the rerank arm actually scored over — `firstPassDepth`,
   * which floors the requested depth at the engine's `RERANK_K_INIT`. Recorded
   * separately from `depth` because they are two different quantities: `depth`
   * is the SCORING cutoff, this is the candidate pool, and a change to the
   * engine floor moves this one alone. Absent on a run that did not rerank —
   * there is no pool to record for one.
   */
  readonly rerankPool?: number | undefined;
  /**
   * WHAT the reranker was shown: how many characters of an atom body were sent,
   * and which part of it. Both are settable per run (`--rerank-doc-max-chars` /
   * `--rerank-extract`) and stamped EFFECTIVE, never as the engine constant —
   * a row reading 2000 while 4000 was scored is the provenance failure this pair
   * exists to prevent. Both decide the TEXT the cross-encoder scored rather than
   * the pool it scored over. Absent on a run that did not rerank — nothing was
   * extracted for one.
   */
  readonly rerankDocMaxChars?: number | undefined;
  readonly rerankExtract?: string | undefined;
  /**
   * The DENSE leg's weight in the hybrid route's LEG fusion. Absent on a run
   * that named none, which `compare.ts` reads as the shipped `HYBRID_FUSION`
   * weight — the value every recorded hybrid row was measured under.
   */
  readonly hybridWeight?: number | undefined;
  /**
   * What the CONSUMER received: the token cap applied to the presented ranking,
   * and how many top atoms it was charged over. Both absent on a run that named
   * no `--budget` — nothing was capped, so there is no window to record.
   */
  readonly tokenBudget?: number | undefined;
  readonly servedK?: number | undefined;
  /**
   * The encoder that produced this run's dense leg. Absent on a lexical route,
   * which embedded nothing at all.
   */
  readonly embedModel?: string | undefined;
  /**
   * The analysis chain the index was BUILT with. Required, unlike the rerank
   * fields: every run has an analyzer whether or not it named one, and a row that
   * omitted it could never be told apart from one measured on another chain.
   */
  readonly analyzer: string;
  /**
   * Whether the QUERY-SIDE adjacency treatment was applied. Required for the
   * reason `analyzer` is: every run either applied it or did not, and a row
   * omitting it could not be told apart from one measured under the other arm.
   */
  readonly queryAdjacency: boolean;
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
  /** Topics R-Precision was measurable on — the denominator behind its mean. */
  readonly rPrecisionTopics?: number | undefined;
  readonly perTopic: readonly TopicScore[];
  /**
   * Per-axis means over this dataset's topics — DESCRIPTIVE STRATA, never a
   * result. ABSENT on every dataset whose topics author no axis, so a run that
   * has none renders no section at all instead of one empty bucket.
   */
  readonly perAxisDescriptive?: readonly AxisStratum[] | undefined;
  /**
   * The document ranking per topic, in rank order — the run file's whole input.
   * Kept OUT of the JSON summary (`writeRunSummary`): the rankings are two orders
   * of magnitude bigger than the metrics, and the TREC run file is the format an
   * external evaluator already reads.
   */
  readonly rankings: ReadonlyMap<string, readonly string[]>;
}

/**
 * One line of `history.jsonl`: the four metrics, flattened next to provenance.
 *
 * Every field added after the first recorded run is OPTIONAL, exactly as
 * `atomMaxChars` is nullable. `readHistory` drops a row it cannot recognise, so
 * requiring a late field would erase every earlier run from the progress log —
 * the one thing this append-only file exists to prevent.
 */
type LateMetrics = Pick<
  Metrics,
  'precision5' | 'precision10' | 'allGoldInTop10' | 'map' | 'rPrecision' | 'rbpResidual'
>;

export interface HistoryRow extends Omit<Metrics, keyof LateMetrics>, Partial<LateMetrics> {
  readonly ts: string;
  readonly gitSha: string;
  readonly dataset: string;
  /** Descriptive, not provenance — absent on rows written before it existed. */
  readonly domain?: string;
  readonly docShape?: string;
  readonly queryShape?: string;
  /**
   * How many topics R-Precision was MEASURED on. Its cutoff is the topic's own
   * gold count, so measurability varies per topic and its mean covers a subset;
   * this is that subset's size. Deliberately NOT on `Metrics` — `MetricName` is
   * `keyof Metrics`, and a topic COUNT must never be offerable as a pairable
   * metric. Absent on rows written before it existed.
   */
  readonly rPrecisionTopics?: number | undefined;
  /** Sample sd (n-1) of the per-topic values; absent on older rows. */
  readonly ndcg10Sd?: number;
  readonly recall10Sd?: number | undefined;
  readonly recall100Sd?: number | undefined;
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
  /**
   * The run's OWN TREC run file, relative to the results directory, read by
   * `pytrec_eval` and by any later per-topic error analysis. Absent on rows
   * written before it existed, and resolution REFUSES such a row rather than
   * deriving a name — the same rule `perTopicPath` states above.
   */
  readonly runPath?: string;
  /** `null` only in rows written before the effective value was recorded. */
  readonly atomMaxChars: number | null;
  readonly depth: number;
  readonly rerank: boolean;
  /**
   * The rerank protocol this row was measured under, and the EFFECTIVE weight it
   * fused at. Both are TREATMENT provenance (`compare.ts`), so a fusion-rule
   * change is labelled an arm comparison instead of being subtracted. Absent on a
   * BM25-only row, and on every row recorded before the protocol was nameable;
   * an absent weight on an RRF row is read as the legacy 0.5 by `compare.ts`.
   */
  readonly rerankProfile?: string | undefined;
  readonly rerankWeight?: number | undefined;
  /**
   * The reranker MODEL this row was measured under — TREATMENT provenance
   * (`compare.ts`), so a model change is labelled an arm comparison instead of
   * being subtracted. Absent on a BM25-only row, and on every row recorded before
   * the model was selectable; those all used the engine's `RERANK_MODEL_ID`,
   * which is how `compare.ts` reads an absent one.
   */
  readonly rerankModel?: string | undefined;
  /**
   * The first-pass candidate POOL this row's rerank arm scored over — SCALE
   * provenance (`compare.ts`), because it changes WHAT was measured rather than
   * how it was treated, so a move REFUSES a subtraction. Absent on a BM25-only
   * row, and on every row recorded before the pool was stamped; those reranked
   * over the floor `RERANK_K_INIT` held at the time, which is how `compare.ts`
   * reads an absent one.
   */
  readonly rerankPool?: number | undefined;
  /**
   * The doc window this row's reranker read — how many characters of an atom
   * body, and which part. TREATMENT provenance (`compare.ts`), because they
   * change what the model was SHOWN, so a move is labelled an arm comparison
   * instead of being subtracted. Absent on a BM25-only row, and on every row
   * recorded before the two were stamped; those all extracted the head at 2000
   * characters, which is how `compare.ts` reads an absent one.
   */
  readonly rerankDocMaxChars?: number | undefined;
  readonly rerankExtract?: string | undefined;
  /**
   * The DENSE leg's weight this row's hybrid fusion ran at — TREATMENT
   * provenance (`compare.ts`), so a swept weight is labelled an arm comparison
   * instead of being subtracted. Absent on every row that named none; those all
   * fused at the engine's shipped `HYBRID_FUSION` weight, which is how
   * `compare.ts` reads an absent one.
   */
  readonly hybridWeight?: number | undefined;
  /**
   * The consumer cap this row was PRESENTED under, and the window it was charged
   * over — TREATMENT provenance (`compare.ts`), so a budget change is labelled an
   * arm comparison instead of being subtracted. Absent on every row that named no
   * `--budget`, and on every row recorded before the flag existed; none of those
   * capped anything, so absence is no cap rather than an unknown one.
   */
  readonly tokenBudget?: number | undefined;
  readonly servedK?: number | undefined;
  /**
   * The encoder behind this row's dense leg — TREATMENT provenance
   * (`compare.ts`). Absent on every row recorded before the field was stamped;
   * every recorded dense row was measured on the engine's `EMBED_MODEL_ID`,
   * which is how `compare.ts` reads an absent one.
   */
  readonly embedModel?: string | undefined;
  /**
   * The analysis chain this row was measured under — TREATMENT provenance
   * (`compare.ts`), so an analyzer change is labelled an arm comparison instead
   * of being subtracted. Absent on every row recorded before the chain was
   * selectable; those were all built by the engine's `DEFAULT_ANALYZER`, which is
   * how `compare.ts` reads an absent one.
   */
  readonly analyzer?: string;
  /**
   * Whether this row's queries carried the adjacency phrase — TREATMENT
   * provenance (`compare.ts`), so switching it on is labelled an arm comparison
   * instead of being subtracted. Absent on every row recorded before the flag
   * existed; none of those applied it, which is how `compare.ts` reads an absent
   * one.
   */
  readonly queryAdjacency?: boolean;
  readonly topics: number;
  readonly docCount: number;
  readonly atomCount: number;
  readonly ingestMs: number;
  readonly queryMs: number;
}

/** The three artefacts recording ONE dataset produced, so the caller can name them. */
export interface RecordedDataset {
  readonly historyPath: string;
  readonly perTopicPath: string;
  readonly runPath: string;
}

/** Everything `recordDataset` needs: one run's provenance, one dataset's outcome. */
export interface DatasetRecordOptions {
  readonly resultsDir: string;
  readonly provenance: RunProvenance;
  readonly result: DatasetResult;
}

/** The end-of-run summary paths — the pair that shares a stem. */
export interface RunSummaryPaths {
  readonly markdownPath: string;
  readonly jsonPath: string;
}

/** Everything `writeRunSummary` needs: the datasets that actually ran. */
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

/**
 * `runs/<instant>-<adapter>-<dataset>.trec`, relative to the results dir.
 *
 * Millisecond instant and adapter for exactly the reason `perTopicRelPath` needs
 * both: a minute-resolution stem let two arms of one comparison overwrite each
 * other's artefacts with no error. The row records this exact string.
 */
export const runFileRelPath = (provenance: RunProvenance, dataset: string): string =>
  `${RUN_FILE_DIR}/${runStamp(provenance.ts)}-${provenance.adapter}-${dataset}.trec`;

/**
 * Where the run's TREC run file lives — READ off the row the writer recorded it
 * on, never derived. `undefined` for a row written before the field existed: a
 * derived name cannot tell two arms of one minute apart, so it would hand an
 * evaluator another run's rankings under this run's label.
 */
export const runFilePath = (resultsDir: string, run: HistoryRow): string | undefined =>
  run.runPath === undefined ? undefined : resolve(resultsDir, run.runPath);

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
  runPath: runFileRelPath(provenance, result.dataset),
  atomMaxChars: result.atomMaxChars,
  depth: provenance.depth,
  rerank: provenance.rerank,
  rerankProfile: provenance.rerankProfile,
  rerankWeight: provenance.rerankWeight,
  rerankModel: provenance.rerankModel,
  rerankPool: provenance.rerankPool,
  rerankDocMaxChars: provenance.rerankDocMaxChars,
  rerankExtract: provenance.rerankExtract,
  hybridWeight: provenance.hybridWeight,
  tokenBudget: provenance.tokenBudget,
  servedK: provenance.servedK,
  embedModel: provenance.embedModel,
  analyzer: provenance.analyzer,
  queryAdjacency: provenance.queryAdjacency,
  ...descriptorFields(result),
  ...costFields(result),
  rPrecisionTopics: result.rPrecisionTopics,
  ...result.metrics,
  ...sdFields(result.metricsSd),
});

const STRING_FIELDS: readonly string[] = ['ts', 'gitSha', 'dataset', 'adapter'];

/**
 * The fields whose NUMBER a row must carry to be recognised. The recall cutoffs
 * are NOT among them: `JSON.stringify` drops an `undefined`, so a run below
 * depth 100 writes no `recall100` key at all, and requiring it would make
 * `readHistory` DISCARD the row — erasing the run from an append-only progress
 * log. The consumer metrics are absent for the same reason in the other
 * direction: every row recorded before they existed lacks them.
 */
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
 * R@20 is in the human table because it is the HEAD of the reranked order — the
 * window a caller actually reads. It is no longer the reranker's input bound:
 * that pool is `RERANK_K_INIT` wide and has moved, so recall anywhere inside the
 * pool is reachable and only recall that lands in the head buys anything
 * downstream. R@300/@1000 stay in the JSON and the per-topic TSV: they exist for
 * the depth curve, and a nine-metric row is unreadable. The consumer metrics
 * (P@5, P@10, all-gold, MAP, R-Prec, RBP residual) stay out of this table for
 * that same reason, and are read off the TSV and the JSON summary.
 */
const markdownRow = (result: DatasetResult): string =>
  `| ${result.dataset} | ${result.domain} | ${result.docShape} | ${result.topics} | ` +
  `${metric(result.metrics.ndcg10)} | ${metric(result.metricsSd.ndcg10)} | ` +
  `${optionalMetric(result.metrics.recall10)} | ${optionalMetric(result.metrics.recall20)} | ` +
  `${optionalMetric(result.metrics.recall100)} | ` +
  `${metric(result.metrics.mrr10)} | ${result.queryP50Ms} | ${result.queryP95Ms} |`;

/**
 * The reranker id is printed ONLY when one scored: a BM25 run has no reranker,
 * so naming a model on its header would attribute the numbers to a model that
 * never saw them.
 */
const rerankModelText = (provenance: RunProvenance): string =>
  provenance.rerankModel === undefined ? '' : `, rerank model: \`${provenance.rerankModel}\``;

const markdownHeader = (provenance: RunProvenance): readonly string[] => [
  '# dp-gnosis-bench run',
  '',
  `- generated at: \`${provenance.ts}\``,
  `- git sha: \`${provenance.gitSha}\``,
  `- adapter: \`${provenance.adapter}\`, analyzer: \`${provenance.analyzer}\`, ` +
    `depth: ${provenance.depth}, rerank: ${provenance.rerank}` +
    rerankModelText(provenance),
  '',
  '> Scores are DOCUMENT-level: atoms are rolled up to their origin document before',
  '> scoring, so they stay comparable across chunker changes.',
  '',
  '| dataset | domain | docShape | topics | nDCG@10 | nDCG@10 sd | R@10 | R@20 | R@100 | ' +
    'MRR@10 | q p50 ms | q p95 ms |',
  '|---|---|---|---|---|---|---|---|---|---|---|---|',
];

/**
 * The per-axis block's own header, stating what the numbers are NOT. It is not
 * decoration: the largest English stratum is 13 topics against a whole-corpus
 * MDE of ~0.015 at 60, so a stratum can support no inference at all. No
 * p-value, interval or verdict is rendered here, and none may be added.
 */
const PER_AXIS_HEADER: readonly string[] = [
  '',
  '## Per-axis means — DESCRIPTIVE STRATA, not results',
  '',
  '> These numbers are DESCRIPTIVE ONLY: each axis holds a handful of topics, far below',
  '> the corpus-wide detectable effect, so no p-value, interval or verdict is computed for',
  '> one and a per-axis delta MUST NOT be quoted as a result. They say what a change looks',
  '> like per query shape. The headline stays the macro mean over ALL topics above.',
  '',
  '| dataset | axis | topics | nDCG@10 | R@10 | R@100 | MRR@10 |',
  '|---|---|---|---|---|---|---|',
];

const axisRow = (dataset: string, stratum: AxisStratum): string =>
  `| ${dataset} | ${stratum.axis} | ${stratum.topics} | ${metric(stratum.ndcg10)} | ` +
  `${optionalMetric(stratum.recall10)} | ${optionalMetric(stratum.recall100)} | ` +
  `${metric(stratum.mrr10)} |`;

const axisRows = (results: readonly DatasetResult[]): readonly string[] =>
  results.flatMap(result =>
    (result.perAxisDescriptive ?? []).map(stratum => axisRow(result.dataset, stratum))
  );

/** No dataset authored an axis → NO section, rather than an empty table. */
const perAxisSection = (results: readonly DatasetResult[]): readonly string[] => {
  const rows = axisRows(results);
  return rows.length === 0 ? [] : [...PER_AXIS_HEADER, ...rows];
};

const renderMarkdown = (provenance: RunProvenance, results: readonly DatasetResult[]): string =>
  [...markdownHeader(provenance), ...results.map(markdownRow), ...perAxisSection(results), ''].join(
    '\n'
  );

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
  'precision5',
  'precision10',
  'allGoldInTop10',
  'map',
  'rPrecision',
  'rbpResidual',
] as const satisfies readonly (keyof Metrics)[];

/**
 * The PRESENTATION-diversity columns, appended AFTER the metrics and emitted
 * ONLY when a run measured them. They are not metrics: `significance.ts` reads
 * columns by name, a sweep cell carries none, and every legacy file is still the
 * header above — so a render with no spread MUST stay byte-identical.
 */
export const PER_TOPIC_SPREAD_COLUMNS = [
  'distinctDocs5',
  'distinctDocs10',
  'sameDocRuns10',
] as const satisfies readonly (keyof AtomSpread)[];

/**
 * The authored REPORTING facets, appended AFTER the spread columns and emitted
 * ONLY when at least one topic carries an AXIS — a BEIR or BRIGHT run authors
 * none, so its file MUST stay byte-identical to the header above. They are
 * labels, not measures: nothing averages them and nothing filters on them.
 */
export const PER_TOPIC_FACET_COLUMNS = [
  'axis',
  'domain',
  'type',
] as const satisfies readonly (keyof TopicFacets)[];

/** An unmeasurable cutoff is an EMPTY field — 0 would read as "measured, none". */
const tsvCell = (value: number | undefined): string => (value === undefined ? '' : metric(value));

/** What the per-topic file carries beyond the metrics — each column set, or not. */
interface TsvColumns {
  readonly spread: boolean;
  readonly facets: boolean;
}

const headerOf = (columns: TsvColumns): string =>
  [
    PER_TOPIC_QUERY_COLUMN,
    ...PER_TOPIC_METRIC_COLUMNS,
    ...(columns.spread ? PER_TOPIC_SPREAD_COLUMNS : []),
    ...(columns.facets ? PER_TOPIC_FACET_COLUMNS : []),
  ].join('\t');

/**
 * A COUNT, not a measure in [0,1]: the 4-decimal form belongs to the metric
 * family, and `5.0000` beside `ndcg10` reads as one and invites averaging it as
 * one. Unmeasurable stays the empty field `tsvCell` writes.
 */
const spreadCell = (value: number | undefined): string =>
  value === undefined ? '' : String(value);

const spreadCells = (topic: TopicScore): readonly string[] =>
  PER_TOPIC_SPREAD_COLUMNS.map(column => spreadCell(topic.spread?.[column]));

/** An unauthored facet is an EMPTY field, like an unmeasurable cutoff. */
const facetCells = (topic: TopicScore): readonly string[] =>
  PER_TOPIC_FACET_COLUMNS.map(column => topic.facets?.[column] ?? '');

const tsvRow = (topic: TopicScore, columns: TsvColumns): string =>
  [
    topic.queryId,
    ...PER_TOPIC_METRIC_COLUMNS.map(column => tsvCell(topic.metrics[column])),
    ...(columns.spread ? spreadCells(topic) : []),
    ...(columns.facets ? facetCells(topic) : []),
  ].join('\t');

/**
 * The per-topic TSV body — the ONE serializer for this format. The BM25 sweep
 * writes its cells through it too, so `significance.readPerTopic` parses a run
 * and a sweep cell with the same parser and neither can drift from the other.
 */
export const renderPerTopicTsv = (perTopic: readonly TopicScore[]): string => {
  const columns: TsvColumns = {
    spread: perTopic.some(topic => topic.spread !== undefined),
    facets: perTopic.some(topic => topic.facets?.axis !== undefined),
  };
  return [headerOf(columns), ...perTopic.map(topic => tsvRow(topic, columns)), ''].join('\n');
};

const writePerTopic = (
  resultsDir: string,
  provenance: RunProvenance,
  result: DatasetResult
): string => {
  const path = resolve(resultsDir, perTopicRelPath(provenance, result.dataset));
  writeFileSync(path, renderPerTopicTsv(result.perTopic), 'utf8');
  return path;
};

/** The TREC run format's second column: the unused iteration field, fixed. */
const TREC_ITERATION = 'Q0';

/**
 * The run's label in the run file's last column — the adapter, and the arm when
 * one is on. `trec_eval` prints it back, so a mislabelled file is a mis-attributed
 * measurement; there is no other column that says WHICH configuration ran.
 */
export const runTag = (provenance: RunProvenance): string =>
  provenance.rerank ? `${provenance.adapter}-rerank` : provenance.adapter;

/**
 * The score column is DERIVED from the rank, because this suite carries an ORDER
 * and not a score vector. It must be strictly decreasing: `trec_eval` and
 * `pytrec_eval` re-sort each topic by score and break ties by document id, so a
 * constant (or repeating) score silently replaces the measured ranking with an
 * alphabetical one. `length - index` is exact at every depth.
 */
const trecLines = (queryId: string, ranking: readonly string[], tag: string): readonly string[] =>
  ranking.map((docId, index) =>
    [queryId, TREC_ITERATION, docId, index + 1, ranking.length - index, tag].join(' ')
  );

/**
 * The TREC run file body — `qid Q0 docid rank score tag`, rank 1-based. Pure: a
 * topic that retrieved nothing contributes no line, which is what an evaluator
 * reads as "this topic scored zero", and no topics at all yield an empty file.
 */
export const renderTrecRun = (
  rankings: ReadonlyMap<string, readonly string[]>,
  tag: string
): string =>
  [...rankings]
    .flatMap(([queryId, ranking]) => trecLines(queryId, ranking, tag))
    .map(line => `${line}\n`)
    .join('');

const writeTrecRun = (
  resultsDir: string,
  provenance: RunProvenance,
  result: DatasetResult
): string => {
  const path = resolve(resultsDir, runFileRelPath(provenance, result.dataset));
  writeFileSync(path, renderTrecRun(result.rankings, runTag(provenance)), 'utf8');
  return path;
};

/**
 * Record ONE dataset, the moment it finishes: its per-topic TSV, its TREC run
 * file, and its history row. Called per dataset rather than once per run because
 * a run that dies mid-suite (measured 2026-08-15: an OOM 67.5 minutes and six
 * completed datasets in) previously wrote NOTHING — every completed dataset's
 * numbers were lost, and "a partial run must never look complete" held only for
 * a dataset failure, never for a process death.
 *
 * The artefacts are written BEFORE the history row is appended: a row names its
 * `perTopicPath`/`runPath` and resolution reads only those fields, so a crash
 * between the two must leave an unreferenced file (harmless) rather than a row
 * pointing at a file that does not exist.
 *
 * Both artefacts are ALWAYS written: without the per-topic scores a recorded run
 * cannot be re-analysed later without paying for the benchmark again, and the
 * rankings cannot be recovered from the metrics at all.
 */
export const recordDataset = (options: DatasetRecordOptions): RecordedDataset => {
  const { resultsDir, provenance, result } = options;
  mkdirSync(resolve(resultsDir, PER_TOPIC_DIR), { recursive: true });
  mkdirSync(resolve(resultsDir, RUN_FILE_DIR), { recursive: true });
  const perTopicPath = writePerTopic(resultsDir, provenance, result);
  const runPath = writeTrecRun(resultsDir, provenance, result);
  const historyPath = resolve(resultsDir, HISTORY_FILE);
  appendHistory(historyPath, [toHistoryRow(provenance, result)]);
  return { historyPath, perTopicPath, runPath };
};

const RANKINGS_KEY = 'rankings';

/** The JSON sidecar is a SUMMARY: the rankings live in the run file, once. */
const summaryOf = (result: DatasetResult): Readonly<Record<string, unknown>> =>
  Object.fromEntries(Object.entries(result).filter(([key]) => key !== RANKINGS_KEY));

const jsonRecord = (options: RunReportOptions): unknown => ({
  provenance: options.provenance,
  results: options.results.map(summaryOf),
});

/**
 * The end-of-run summary: markdown and JSON over the datasets that ACTUALLY
 * ran, sharing a stem so a summary can never be separated from the record it
 * was rendered from. It writes nothing `recordDataset` has not already put on
 * disk — it is the view a suite that finished normally leaves behind.
 */
export const writeRunSummary = (options: RunReportOptions): RunSummaryPaths => {
  const stem = reportStem(options.provenance.ts);
  const base = resolve(options.resultsDir, `${stem}-${options.provenance.gitSha}`);
  mkdirSync(options.resultsDir, { recursive: true });
  writeFileSync(`${base}.md`, renderMarkdown(options.provenance, options.results), 'utf8');
  writeFileSync(`${base}.json`, `${JSON.stringify(jsonRecord(options), null, 2)}\n`, 'utf8');
  return { markdownPath: `${base}.md`, jsonPath: `${base}.json` };
};
