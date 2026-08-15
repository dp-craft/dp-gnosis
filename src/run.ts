/**
 * The entry point: manifest → per dataset (load, ingest, index, retrieve,
 * score) → report → optional comparison against the recorded history.
 *
 * Three call-site duties live here, because no lower layer can discharge them:
 *
 * 1. **The rerank first pass is WIDENED, then sliced back.** The CLI reranks the
 *    top `RERANK_K_INIT` (`retrieveCommand.ts:308` — `Math.max(request.k,
 *    RERANK_K_INIT)`), and `engine.ts` deliberately does not replicate that. At
 *    a depth below 20 an un-widened first pass would hand the reranker fewer
 *    candidates than the shipped configuration ever sees, so the `--rerank` arm
 *    would measure a configuration that does not exist. The constant is
 *    IMPORTED from the engine's config, never restated, so the two cannot drift.
 * 2. **A dataset failure fails the RUN.** The other datasets still run and are
 *    still recorded — a fetch problem in one should not cost the rest — but the
 *    process exits non-zero, because a partial run silently reported as complete
 *    is the failure mode this suite exists to prevent.
 * 3. **Topics come from the qrels, not the query file.** A query with no
 *    judgments cannot be scored; including it would divide the mean by a topic
 *    that could only ever contribute 0.
 *
 * Datasets are processed one at a time on purpose: ingest is CPU-bound and each
 * dataset owns an exclusive work directory (`engine.ts` rule 3).
 */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  adapterError,
  type AdapterName,
  resolveAdapter
} from '../../dp-gnosis/src/cli/adapter.js';
import { ATOM_MAX_CHARS, RERANK_K_INIT } from '../../dp-gnosis/src/config.js';
import type { KnowledgePort } from '../../dp-gnosis/src/port.js';
import { type Qrel, readCorpus, readQrels, readQueries } from './beir.js';
import { compareAll, type Comparison, formatComparison } from './compare.js';
import {
  openPort,
  prepareDataset,
  type PreparedDataset,
  rerankIfRequested,
  retrieveDocs
} from './engine.js';
import { ensureBeirDataset } from './fetch/beirZip.js';
import { ensureBrightDataset, readExcluded } from './fetch/bright.js';
import { describeDerivation, ensureVaultDataset } from './fetch/vault.js';
import { type BeirDataset, type DatasetEntry, enabledDatasets, loadManifest } from './manifest.js';
import {
  corpusChecksum,
  currentGitSha,
  type DatasetResult,
  HISTORY_FILE,
  readHistory,
  type RunProvenance,
  writeRunReport
} from './report.js';
import { type DatasetScore, scoreDataset, toDocumentRanking } from './score.js';
import { type MetricName, pairedSignificance, type Significance } from './significance.js';
import { significanceLabel } from './sweepReport.js';

/** The suite directory; every other path here is resolved from it, never from `cwd`. */
export const SUITE_ROOT = resolve(fileURLToPath(import.meta.url), '../..');
export const MANIFEST_PATH = resolve(SUITE_ROOT, 'datasets.json');
const RESULTS_DIR = resolve(SUITE_ROOT, 'results');
const DATA_DIR = resolve(SUITE_ROOT, 'data');
const WORK_ROOT = resolve(DATA_DIR, 'work');
const CORPUS_FILE = 'corpus.jsonl';

/**
 * The adapter measured when `--adapter` is silent. NOT the engine CLI's default
 * (`linear`): the suite's recorded history is fts5, and moving the bench default
 * would silently re-base every comparison against it.
 */
export const BENCH_DEFAULT_ADAPTER: AdapterName = 'fts5';

const DEFAULT_DEPTH = 100;
const METRIC_DIGITS = 4;
const FAILURE_EXIT_CODE = 1;

/** The flags `bench.sh` forwards. */
export interface CliOptions {
  /** Dataset ids to run; empty means every enabled entry. */
  readonly only: readonly string[];
  readonly depth: number;
  readonly rerank: boolean;
  readonly compare: boolean;
  /** The adapter arm under measurement; recorded as provenance. */
  readonly adapter: AdapterName;
}

/** A scorable query: judged by the qrels, so it can contribute a non-zero mean. */
export interface Topic {
  readonly id: string;
  readonly text: string;
}

const flagValue = (argv: readonly string[], name: string): string | undefined => {
  const index = argv.indexOf(name);
  return index === -1 ? undefined : argv[index + 1];
};

const csv = (value: string | undefined): readonly string[] =>
  value === undefined ? [] : value.split(',').map(part => part.trim()).filter(part => part.length > 0);

/**
 * An unknown `--adapter` THROWS. Falling back to the default would record a run
 * whose provenance says one engine path while another was measured — the exact
 * confusion `compare.ts` refuses to subtract across.
 */
const parseAdapter = (value: string | undefined): AdapterName => {
  if (value === undefined) return BENCH_DEFAULT_ADAPTER;
  const adapter = resolveAdapter(value);
  if (adapter === undefined) throw new Error(`dp-gnosis-bench: ${adapterError(value)}`);
  return adapter;
};

export const parseArgs = (argv: readonly string[]): CliOptions => ({
  only: csv(flagValue(argv, '--only')),
  depth: Number(flagValue(argv, '--depth') ?? DEFAULT_DEPTH),
  rerank: argv.includes('--rerank'),
  compare: argv.includes('--compare'),
  adapter: parseAdapter(flagValue(argv, '--adapter')),
});

/**
 * Where a dataset's BEIR files are. `beir-local` points at a directory that
 * already exists; every other format is materialised into `data/<id>` by its
 * fetcher, so a missing directory names the fetcher that has to run first.
 */
export const datasetDir = (entry: DatasetEntry): string => {
  const dir =
    entry.format === 'beir-local' ? resolve(SUITE_ROOT, entry.source) : resolve(DATA_DIR, entry.id);
  if (existsSync(resolve(dir, CORPUS_FILE))) return dir;
  throw new Error(
    `dp-gnosis-bench: dataset "${entry.id}" has no ${CORPUS_FILE} at ${dir} — ` +
      `fetch it first (format "${entry.format}"), or disable the entry in datasets.json`
  );
};

/**
 * A `beir-local` entry carrying `derive` is built from the repo's own atoms and
 * golden set on EVERY run — the inputs are local files, so a cache could only
 * make the run measure a vault that has since changed. The unreachable-gold
 * count is printed rather than returned: it caps recall for the dataset, and a
 * ceiling that is not visible next to the number it bounds gets read as quality.
 */
const deriveVault = (entry: BeirDataset): void => {
  const derived = ensureVaultDataset(entry, SUITE_ROOT);
  process.stdout.write(`${describeDerivation(entry.id, derived)}\n`);
};

/**
 * Fetch the dataset if its fetcher has not already put it on disk, then verify
 * the layout. `beir-local` points at a directory the repo already carries, so
 * there is nothing to fetch and a missing one is an error, not a download.
 */
export const ensureDataset = async (entry: DatasetEntry): Promise<string> => {
  if (entry.format === 'bright') await ensureBrightDataset(entry, DATA_DIR);
  if (entry.format === 'beir-zip') await ensureBeirDataset(entry, DATA_DIR);
  if (entry.format === 'beir-local' && entry.derive !== undefined) deriveVault(entry);
  return datasetDir(entry);
};

/**
 * The atom cap the run ACTUALLY used. A silent manifest means the engine
 * default, and that number is recorded rather than `null`: two runs straddling
 * a change to `ATOM_MAX_CHARS` would otherwise both read `null`, and
 * `compare.ts` would report a delta across two different measuring scales.
 */
export const effectiveAtomMaxChars = (entry: DatasetEntry): number =>
  entry.atomMaxChars ?? ATOM_MAX_CHARS;

/** Only queries the dataset actually judged; an unjudged topic is not scorable. */
export const topicsOf = (
  queries: ReadonlyMap<string, string>,
  qrels: ReadonlyMap<string, Qrel>
): readonly Topic[] =>
  [...qrels.keys()]
    .map(id => ({ id, text: queries.get(id) ?? '' }))
    .filter(topic => topic.text.length > 0);

/** The CLI's `k_init` handling, which `engine.ts` leaves to its caller. */
export const firstPassDepth = (depth: number, rerank: boolean): number =>
  rerank ? Math.max(depth, RERANK_K_INIT) : depth;

/**
 * One dataset's query-time context. `excluded` is per QUERY, because BRIGHT
 * ships per-query exclusions and scoring a document the dataset told us to drop
 * makes the number wrong in both directions (`score.ts`).
 */
export interface RankContext {
  readonly port: KnowledgePort;
  readonly options: CliOptions;
  readonly excluded: ReadonlyMap<string, readonly string[]>;
}

const rankTopic = async (context: RankContext, topic: Topic): Promise<readonly string[]> => {
  const { options } = context;
  const depth = firstPassDepth(options.depth, options.rerank);
  const atoms = await retrieveDocs(context.port, topic.text, depth);
  const ordered = await rerankIfRequested(topic.text, atoms, options.rerank);
  return toDocumentRanking(ordered.slice(0, options.depth), context.excluded.get(topic.id) ?? []);
};

/** One topic's ranking and the wall time the retrieve+rerank+rollup path took. */
interface TimedTopic {
  readonly id: string;
  readonly ranking: readonly string[];
  readonly ms: number;
}

const timeTopic = async (context: RankContext, topic: Topic): Promise<TimedTopic> => {
  const startedAt = Date.now();
  const ranking = await rankTopic(context, topic);
  return { id: topic.id, ranking, ms: Date.now() - startedAt };
};

/** Sequential by design: one port, one index, one CPU-bound query at a time. */
const rankAllTopics = async (
  context: RankContext,
  topics: readonly Topic[]
): Promise<readonly TimedTopic[]> =>
  topics.reduce<Promise<readonly TimedTopic[]>>(
    async (pending, topic) => [...(await pending), await timeTopic(context, topic)],
    Promise.resolve([])
  );

/**
 * Nearest-rank percentile over the timings, sorted ascending. No timing means
 * no query ran, which is reported as 0 rather than `NaN`.
 */
export const percentileMs = (values: readonly number[], fraction: number): number => {
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil(fraction * sorted.length) - 1;
  const index = Math.min(Math.max(rank, 0), sorted.length - 1);
  return sorted[index] ?? 0;
};

const P50 = 0.5;
const P95 = 0.95;

/** The query phase: rankings by topic, total wall time, and its distribution. */
export interface QueryOutcome {
  readonly rankings: ReadonlyMap<string, readonly string[]>;
  readonly queryMs: number;
  readonly queryP50Ms: number;
  readonly queryP95Ms: number;
}

/**
 * Exported so `sweep.ts` measures its grid points through the SAME query path a
 * recorded run uses — a second loop there would be a second measurement.
 */
export const queryDataset = async (
  context: RankContext,
  topics: readonly Topic[]
): Promise<QueryOutcome> => {
  const startedAt = Date.now();
  const timed = await rankAllTopics(context, topics);
  const perQueryMs = timed.map(entry => entry.ms);
  return {
    rankings: new Map(timed.map(entry => [entry.id, entry.ranking])),
    queryMs: Date.now() - startedAt,
    queryP50Ms: percentileMs(perQueryMs, P50),
    queryP95Ms: percentileMs(perQueryMs, P95),
  };
};

/** Who the dataset is: its manifest descriptors plus the corpus checksum. */
const descriptorOf = (
  entry: DatasetEntry,
  dir: string
): Pick<
  DatasetResult,
  'dataset' | 'domain' | 'docShape' | 'queryShape' | 'corpusBytes' | 'corpusLines' | 'atomMaxChars'
> => ({
  dataset: entry.id,
  domain: entry.domain,
  docShape: entry.docShape,
  queryShape: entry.queryShape,
  ...corpusChecksum(resolve(dir, CORPUS_FILE)),
  atomMaxChars: effectiveAtomMaxChars(entry),
});

/** What the run measured. `rankings` stays out: the JSON report is a summary. */
const measurementsOf = (
  queried: QueryOutcome,
  scored: DatasetScore
): Pick<
  DatasetResult,
  'queryMs' | 'queryP50Ms' | 'queryP95Ms' | 'metrics' | 'metricsSd' | 'perTopic'
> => ({
  queryMs: queried.queryMs,
  queryP50Ms: queried.queryP50Ms,
  queryP95Ms: queried.queryP95Ms,
  metrics: scored.mean,
  metricsSd: scored.sd,
  perTopic: scored.perTopic,
});

/**
 * The arm is passed DOWN, not assumed: `prepareDataset` builds the index that
 * arm reads, so an adapter can never be measured over an index another adapter
 * built. `sweep.ts` passes its own fixed `linear`.
 */
export const prepareOf = (
  entry: DatasetEntry,
  dir: string,
  adapter: AdapterName
): Promise<PreparedDataset> =>
  prepareDataset({
    id: entry.id,
    docs: readCorpus(dir),
    workRoot: WORK_ROOT,
    atomMaxChars: entry.atomMaxChars,
    adapter,
  });

const runDataset = async (entry: DatasetEntry, options: CliOptions): Promise<DatasetResult> => {
  const dir = await ensureDataset(entry);
  const qrels = readQrels(dir, entry.format === 'bright' ? 'test' : entry.qrels);
  const topics = topicsOf(readQueries(dir), qrels);
  const prepared = await prepareOf(entry, dir, options.adapter);
  const port = openPort(prepared, { adapter: options.adapter });
  const context = { port, options, excluded: readExcluded(dir) };
  const queried = await queryDataset(context, topics).finally(() => port.close?.());
  return {
    ...descriptorOf(entry, dir),
    topics: topics.length,
    docCount: prepared.docCount,
    atomCount: prepared.atomCount,
    ingestMs: prepared.ingestMs,
    ...measurementsOf(queried, scoreDataset(queried.rankings, qrels, options.depth)),
  };
};

const metric = (value: number): string => value.toFixed(METRIC_DIGITS);

const summaryLine = (result: DatasetResult): string =>
  `${result.dataset}: nDCG@10 ${metric(result.metrics.ndcg10)}  ` +
  `R@10 ${metric(result.metrics.recall10)}  R@100 ${metric(result.metrics.recall100)}  ` +
  `MRR@10 ${metric(result.metrics.mrr10)}  ` +
  `(${result.topics} topics, ${result.atomCount} atoms, ${result.ingestMs}ms ingest, ` +
  `${result.queryMs}ms query)`;

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const attempt = async (
  entry: DatasetEntry,
  options: CliOptions
): Promise<DatasetResult | undefined> => {
  try {
    const result = await runDataset(entry, options);
    process.stdout.write(`${summaryLine(result)}\n`);
    return result;
  } catch (error) {
    process.stderr.write(`${entry.id}: FAILED — ${messageOf(error)}\n`);
    return undefined;
  }
};

const isResult = (value: DatasetResult | undefined): value is DatasetResult => value !== undefined;

const runAll = async (
  entries: readonly DatasetEntry[],
  options: CliOptions
): Promise<readonly (DatasetResult | undefined)[]> =>
  entries.reduce<Promise<readonly (DatasetResult | undefined)[]>>(
    async (pending, entry) => [...(await pending), await attempt(entry, options)],
    Promise.resolve([])
  );

const selected = (options: CliOptions): readonly DatasetEntry[] => {
  const entries = enabledDatasets(loadManifest(MANIFEST_PATH));
  return options.only.length === 0
    ? entries
    : entries.filter(entry => options.only.includes(entry.id));
};

const provenanceOf = (options: CliOptions, gitSha: string): RunProvenance => ({
  ts: new Date().toISOString(),
  gitSha,
  adapter: options.adapter,
  depth: options.depth,
  rerank: options.rerank,
});

/** The headline; the other three metrics are read off the delta line above it. */
const SIGNIFICANCE_METRIC: MetricName = 'ndcg10';

/** An arm comparison says so on its OWN line — a p-value read alone must not mislead. */
const armPrefix = (result: Significance): string =>
  result.kind === 'verdict' && result.arms !== undefined ? 'ARM COMPARISON — ' : '';

/**
 * The paired permutation p and bootstrap interval for the pair just compared,
 * from `significance.ts` — the same statistic the sweep rates its cells with.
 * A comparison that produced no delta (refused, or too little history) gets no
 * line: there is nothing to rate.
 */
const significanceLines = (comparison: Comparison): readonly string[] => {
  if (comparison.kind !== 'delta' && comparison.kind !== 'arm-delta') return [];
  const result = pairedSignificance({
    resultsDir: RESULTS_DIR,
    previous: comparison.previous,
    latest: comparison.latest,
    metric: SIGNIFICANCE_METRIC,
  });
  return [`  nDCG@10: ${armPrefix(result)}${significanceLabel(result)}`];
};

const comparisonLines = (comparison: Comparison): readonly string[] => [
  formatComparison(comparison),
  ...significanceLines(comparison),
];

const printComparison = (): void => {
  const history = readHistory(resolve(RESULTS_DIR, HISTORY_FILE));
  process.stdout.write('\n-- compare (last two runs per dataset) --\n');
  process.stdout.write(`${compareAll(history).flatMap(comparisonLines).join('\n')}\n`);
};

const record = (results: readonly DatasetResult[], options: CliOptions, sha: string): void => {
  const written = writeRunReport({
    resultsDir: RESULTS_DIR,
    provenance: provenanceOf(options, sha),
    results,
  });
  process.stdout.write(`\nwrote ${written.markdownPath}\n`);
};

export const main = async (argv: readonly string[], gitSha: string): Promise<number> => {
  const options = parseArgs(argv);
  const entries = selected(options);
  const outcomes = await runAll(entries, options);
  const results = outcomes.filter(isResult);
  if (results.length > 0) record(results, options, gitSha);
  if (options.compare) printComparison();
  return results.length === entries.length && entries.length > 0 ? 0 : FAILURE_EXIT_CODE;
};

/** Guarded so the exported helpers stay importable from a test. */
const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  process.exitCode = await main(process.argv.slice(2), currentGitSha(SUITE_ROOT));
}
