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
 *    is the failure mode this suite exists to prevent. For the same reason an
 *    unknown `--only` id, and any selection that measures nothing, exit 1 with a
 *    message on stderr before a single dataset is touched. Each dataset is
 *    RECORDED as it completes, so the same holds when the PROCESS dies rather
 *    than a dataset — the reason the buffered form was replaced.
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

import { fusesLegs } from '../../dp-gnosis/src/adapters/lanceDbDenseAdapter.js';
import {
  ADAPTER_NAMES,
  adapterError,
  type AdapterName,
  denseRouteOf,
  resolveAdapter
} from '../../dp-gnosis/src/cli/adapter.js';
import {
  ATOM_MAX_CHARS,
  DEFAULT_RERANK_PRESET,
  RERANK_K_INIT,
  RERANK_MODEL_ID,
  type RerankFusion } from '../../dp-gnosis/src/config.js';
import type { KnowledgePort } from '../../dp-gnosis/src/port.js';
import { type AnalyzerId, ANALYZERS, DEFAULT_ANALYZER } from '../../dp-gnosis/src/query.js';
import { resolveRerankFusion } from '../../dp-gnosis/src/rerank.js';
import { type Qrel, readCorpus, readQrels, readQueries } from './beir.js';
import { compareAll, type Comparison, formatComparison } from './compare.js';
import {
  assertRerankDiscriminates,
  openPort,
  prepareDataset,
  type PreparedDataset,
  probePortSoundness,
  rerankIfRequested,
  retrieveDocs
} from './engine.js';
import { ensureBeirDataset } from './fetch/beirZip.js';
import { ensureBrightDataset, readExcluded } from './fetch/bright.js';
import { describeDerivation, ensureVaultDataset } from './fetch/vault.js';
import {
  type BeirDataset,
  type DatasetEntry,
  datasetsInLayer,
  enabledDatasets,
  type LayerName,
  LAYERS_TEXT,
  loadManifest,
  resolveLayer
} from './manifest.js';
import {
  corpusChecksum,
  currentGitSha,
  type DatasetResult,
  HISTORY_FILE,
  readHistory,
  recordDataset,
  type RunProvenance,
  writeRunSummary
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
  /** The suite layer to run; `undefined` means "not filtered by layer". */
  readonly layer: LayerName | undefined;
  readonly depth: number;
  readonly rerank: boolean;
  readonly compare: boolean;
  /** The adapter arm under measurement; recorded as provenance. */
  readonly adapter: AdapterName;
  /**
   * The rerank protocol BY NAME — what the run records, and what a reader of
   * `history.jsonl` compares. The bench never restates the fusion rule itself.
   */
  readonly rerankProfile: string;
  /** A raw weight override on the named preset; `undefined` means the preset's own. */
  readonly rerankWeight: number | undefined;
  /**
   * The DENSE leg's weight in the HYBRID route's leg fusion — a different fusion
   * from `rerankWeight`'s, over different orders, so the two flags stay separate.
   * `undefined` means the engine's shipped `HYBRID_FUSION`, which is what every
   * recorded hybrid row was measured under.
   */
  readonly hybridWeight: number | undefined;
  /**
   * The cross-encoder MODEL the rerank arm scores with; `undefined` means the
   * engine's shipped `RERANK_MODEL_ID`, which every recorded run used. Recorded
   * as a treatment field, so two model arms can never be subtracted.
   */
  readonly rerankModel: string | undefined;
  /** The engine's resolution of that name, resolved ONCE so a bad one fails before any dataset. */
  readonly rerankFusion: RerankFusion;
  /**
   * The analysis chain the index is BUILT with — a treatment, recorded on every
   * row, because every run has one whether or not it named it.
   */
  readonly analyzer: AnalyzerId;
  /**
   * The QUERY-SIDE adjacency treatment: a multi-term raw token contributes its
   * phrase as an extra disjunct BESIDE its individual terms. Recorded on every
   * row like `analyzer`, because every run either applied it or did not.
   */
  readonly queryAdjacency: boolean;
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

/**
 * An unknown `--layer` THROWS, naming the valid ones, exactly as `--adapter`
 * does: silently running the whole suite instead of the layer asked for would
 * cost an hour and record a run nobody requested.
 */
const parseLayer = (value: string | undefined): LayerName | undefined => {
  if (value === undefined) return undefined;
  const layer = resolveLayer(value);
  if (layer === undefined) {
    throw new Error(`dp-gnosis-bench: unknown --layer "${value}" — use ${LAYERS_TEXT}`);
  }
  return layer;
};

const ANALYZER_IDS: readonly string[] = Object.keys(ANALYZERS);

const isAnalyzerId = (value: string): value is AnalyzerId => ANALYZER_IDS.includes(value);

/**
 * An unknown `--analyzer` THROWS, naming the valid chains, for the reason
 * `--adapter` does: the chain is not recoverable from the numbers afterwards, so
 * a silent fallback would publish a run under an analyzer label it never used.
 */
const parseAnalyzer = (value: string | undefined): AnalyzerId => {
  if (value === undefined) return DEFAULT_ANALYZER;
  if (isAnalyzerId(value)) return value;
  throw new Error(
    `dp-gnosis-bench: unknown --analyzer "${value}" — use ${ANALYZER_IDS.join(', ')}`
  );
};

/** The ONE adapter whose index build takes the named chain (`prepareDataset`). */
const ANALYZER_AWARE_ADAPTER: AdapterName = 'fts5';

/**
 * A named `--analyzer` on any other adapter REFUSES, before a dataset is
 * prepared. Those adapters analyse with their own hard-coded chain, so the run
 * would record `analyzer` — a TREATMENT field `compare.ts` labels an arm — under
 * a chain it never used. Only an EXPLICIT non-default value refuses: the default
 * describes what every adapter already does, so every legacy invocation stands.
 */
const checkAnalyzerAdapter = (adapter: AdapterName, analyzer: AnalyzerId): AnalyzerId => {
  if (analyzer === DEFAULT_ANALYZER || adapter === ANALYZER_AWARE_ADAPTER) return analyzer;
  throw new Error(
    `dp-gnosis-bench: adapter "${adapter}" does not honour --analyzer "${analyzer}" — ` +
      `only "${ANALYZER_AWARE_ADAPTER}" builds its index with the named chain`
  );
};

const QUERY_ADJACENCY_FLAG = '--query-adjacency';

/** The ONE adapter whose `retrieve` honours the adjacency option (`fts5Adapter.ts`). */
const ADJACENCY_AWARE_ADAPTER: AdapterName = 'fts5';

/**
 * `--query-adjacency` on any other adapter REFUSES, before a dataset is
 * prepared, exactly as `--analyzer` does: no other adapter reads the option, so
 * the row would record `queryAdjacency` — a TREATMENT field `compare.ts` labels
 * an arm — under a treatment the run never applied. The flagless invocation is
 * what every adapter already does, so every legacy invocation stands.
 */
const checkAdjacencyAdapter = (adapter: AdapterName, adjacency: boolean): boolean => {
  if (!adjacency || adapter === ADJACENCY_AWARE_ADAPTER) return adjacency;
  throw new Error(
    `dp-gnosis-bench: adapter "${adapter}" does not honour ${QUERY_ADJACENCY_FLAG} — ` +
      `only "${ADJACENCY_AWARE_ADAPTER}" applies the adjacency phrase at query time`
  );
};

/**
 * The adapters that fuse two legs, DERIVED from the engine's own route table and
 * its own `fusesLegs` rule — the bench states no adapter list of its own.
 */
const HYBRID_ADAPTERS: readonly AdapterName[] = ADAPTER_NAMES.filter(name => {
  const route = denseRouteOf(name);
  return route !== undefined && fusesLegs(route);
});

/** The two ends of the leg-fusion weight: pure lexical, and pure dense. */
const HYBRID_WEIGHT_MIN = 0;
const HYBRID_WEIGHT_MAX = 1;

const HYBRID_WEIGHT_FLAG = '--hybrid-weight';

const hybridRangeText = `${HYBRID_WEIGHT_MIN} (pure lexical) to ${HYBRID_WEIGHT_MAX} (pure dense)`;

/**
 * A weight outside `0…1` is a usage error, NOT something to clamp: a clamped
 * sweep point records the weight it was ASKED for while measuring another, so
 * two cells of one sweep would carry the same number under different labels.
 */
const parseHybridWeight = (value: string | undefined): number | undefined => {
  if (value === undefined) return undefined;
  const weight = Number(value);
  if (weight >= HYBRID_WEIGHT_MIN && weight <= HYBRID_WEIGHT_MAX) return weight;
  throw new Error(
    `dp-gnosis-bench: ${HYBRID_WEIGHT_FLAG} expects a number from ${hybridRangeText}, ` +
      `got "${value}"`
  );
};

/**
 * `--hybrid-weight` on an adapter that fuses no legs REFUSES, exactly as
 * `--analyzer` does off `fts5`: it is a TREATMENT field, so the row would name a
 * leg weight nothing ever fused with.
 */
const checkHybridWeightAdapter = (
  adapter: AdapterName,
  weight: number | undefined
): number | undefined => {
  if (weight === undefined || HYBRID_ADAPTERS.includes(adapter)) return weight;
  throw new Error(
    `dp-gnosis-bench: adapter "${adapter}" fuses no legs, so ${HYBRID_WEIGHT_FLAG} ` +
      `"${String(weight)}" would be recorded as a treatment it never applied — ` +
      `use ${HYBRID_ADAPTERS.join(' or ')}`
  );
};

/** A weight that is not a number would be measured as `NaN` and recorded as a run. */
const parseRerankWeight = (value: string | undefined): number | undefined => {
  if (value === undefined) return undefined;
  const weight = Number(value);
  if (Number.isFinite(weight)) return weight;
  throw new Error(`dp-gnosis-bench: --rerank-weight expects a number, got "${value}"`);
};

/**
 * The fusion rule the NAME selects, resolved by the ENGINE — the bench must not
 * reimplement fusion, or the suite would stop measuring the shipped path. An
 * unknown name (or a weight override on a preset with no weight term) refuses
 * here, before a single dataset is touched, exactly as `--adapter` does: a
 * fallback would publish a number under the wrong protocol label.
 */
const parseRerankFusion = (profile: string, rerankWeight: number | undefined): RerankFusion => {
  try {
    return resolveRerankFusion(profile, { rerankWeight });
  } catch (error) {
    throw new Error(`dp-gnosis-bench: ${messageOf(error)}`);
  }
};

/**
 * A `--rerank-model` without `--rerank` REFUSES. Nothing would rerank, yet the
 * row would carry the model id as its treatment — a run recorded under a model
 * that never scored a single document, which is exactly what naming the model
 * exists to prevent.
 */
const parseRerankModel = (value: string | undefined, rerank: boolean): string | undefined => {
  if (value === undefined) return undefined;
  if (rerank) return value;
  throw new Error(
    `dp-gnosis-bench: --rerank-model "${value}" requires --rerank — ` +
      'without it nothing reranks and the row would name a model that never ran'
  );
};

export const parseArgs = (argv: readonly string[]): CliOptions => {
  const rerankProfile = flagValue(argv, '--rerank-profile') ?? DEFAULT_RERANK_PRESET;
  const rerankWeight = parseRerankWeight(flagValue(argv, '--rerank-weight'));
  const adapter = parseAdapter(flagValue(argv, '--adapter'));
  const rerank = argv.includes('--rerank');
  return {
    only: csv(flagValue(argv, '--only')),
    layer: parseLayer(flagValue(argv, '--layer')),
    depth: Number(flagValue(argv, '--depth') ?? DEFAULT_DEPTH),
    rerank,
    compare: argv.includes('--compare'),
    adapter,
    rerankProfile,
    rerankWeight,
    rerankModel: parseRerankModel(flagValue(argv, '--rerank-model'), rerank),
    rerankFusion: parseRerankFusion(rerankProfile, rerankWeight),
    hybridWeight: checkHybridWeightAdapter(
      adapter,
      parseHybridWeight(flagValue(argv, HYBRID_WEIGHT_FLAG))
    ),
    analyzer: checkAnalyzerAdapter(adapter, parseAnalyzer(flagValue(argv, '--analyzer'))),
    queryAdjacency: checkAdjacencyAdapter(adapter, argv.includes(QUERY_ADJACENCY_FLAG)),
  };
};

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

/** The gold set as `metrics.ts` reads it: judged docs above grade 0, order-free. */
const relevantIdsOf = (qrel: Qrel): readonly string[] =>
  [...qrel.entries()]
    .filter(([, grade]) => grade > 0)
    .map(([docId]) => docId)
    .sort();

/**
 * A topic's identity UNDER THE RETRIEVAL ACTUALLY PERFORMED. The bench applies no
 * topic filter, so an authored `domain`/`type` filter is invisible here — only the
 * query text and the gold set can tell two topics apart.
 */
const topicSignature = (text: string, qrel: Qrel): string =>
  JSON.stringify([text.trim(), relevantIdsOf(qrel)]);

const bySignature = (
  topics: readonly Topic[],
  qrels: ReadonlyMap<string, Qrel>
): ReadonlyMap<string, readonly string[]> =>
  topics.reduce((groups, topic) => {
    const key = topicSignature(topic.text, qrels.get(topic.id) ?? new Map());
    return groups.set(key, [...(groups.get(key) ?? []), topic.id]);
  }, new Map<string, readonly string[]>());

const byFirstId = (a: readonly string[], b: readonly string[]): number =>
  (a[0] ?? '') < (b[0] ?? '') ? -1 : 1;

/**
 * Topic ids that are INDISTINGUISHABLE to this bench — same trimmed query text and
 * same gold set — in groups of two or more. Each group is one topic the macro
 * averages count once per member. Empty when every topic is distinct.
 */
export const collapsingTopicGroups = (
  queries: ReadonlyMap<string, string>,
  qrels: ReadonlyMap<string, Qrel>
): readonly (readonly string[])[] =>
  [...bySignature(topicsOf(queries, qrels), qrels).values()]
    .filter(ids => ids.length > 1)
    .map(ids => [...ids].sort())
    .sort(byFirstId);

/** Prefix of the collapsing-topics warning — a WARNING, not a refusal. */
export const COLLAPSING_TOPICS_WARNING = 'dp-gnosis-bench/collapsing-topics';

const collapsingMessage = (
  datasetId: string,
  groups: readonly (readonly string[])[]
): string =>
  `${COLLAPSING_TOPICS_WARNING}: ${datasetId} has ${groups.length} topic group(s) that this ` +
  `bench cannot tell apart — identical query text and identical gold set, and no topic filter ` +
  `is applied at retrieval: ${groups.map(ids => ids.join(' + ')).join(', ')}. ` +
  `Every member beyond the first is double-counted in every macro-average of this run.\n`;

/**
 * Warns, and lets the run proceed: the collapsing pair in the vault golden set is
 * deliberately authored, so refusing would block every `vault` run.
 */
export const warnCollapsingTopics = (
  datasetId: string,
  queries: ReadonlyMap<string, string>,
  qrels: ReadonlyMap<string, Qrel>
): void => {
  const groups = collapsingTopicGroups(queries, qrels);
  if (groups.length > 0) process.stderr.write(collapsingMessage(datasetId, groups));
};

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
  const atoms = await retrieveDocs(context.port, topic.text, depth, options.queryAdjacency);
  const ordered = await rerankIfRequested(topic.text, atoms, options.rerank, {
    fusion: options.rerankFusion,
    model: options.rerankModel,
  });
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

/**
 * What the run measured. `rankings` is carried through to the TREC run file and
 * NOWHERE else — `report.ts` keeps it out of the JSON summary, which stays the
 * one-row-per-dataset record it has always been.
 */
const measurementsOf = (
  queried: QueryOutcome,
  scored: DatasetScore
): Pick<
  DatasetResult,
  'queryMs' | 'queryP50Ms' | 'queryP95Ms' | 'metrics' | 'metricsSd' | 'perTopic' | 'rankings'
> => ({
  queryMs: queried.queryMs,
  queryP50Ms: queried.queryP50Ms,
  queryP95Ms: queried.queryP95Ms,
  metrics: scored.mean,
  metricsSd: scored.sd,
  perTopic: scored.perTopic,
  rankings: queried.rankings,
});

/** The treatments that decide what gets BUILT, as opposed to how it is queried. */
export interface PrepareArm {
  readonly adapter: AdapterName;
  /** Absent means the engine default — the chain `sweep.ts` and every legacy run used. */
  readonly analyzer?: AnalyzerId | undefined;
}

/**
 * The arm is passed DOWN, not assumed: `prepareDataset` builds the index that
 * arm reads, so an adapter can never be measured over an index another adapter
 * built, nor an analyzer over an index another chain stamped. `sweep.ts` passes
 * its own fixed `linear`.
 */
export const prepareOf = (
  entry: DatasetEntry,
  dir: string,
  arm: PrepareArm
): Promise<PreparedDataset> =>
  prepareDataset({
    id: entry.id,
    docs: readCorpus(dir),
    workRoot: WORK_ROOT,
    atomMaxChars: entry.atomMaxChars,
    adapter: arm.adapter,
    analyzer: arm.analyzer,
  });

/**
 * The post-open gate, then the measured loop, under ONE port lifetime. The probe
 * is inside the `finally` because a refusal must still close the port: the
 * previous form wrapped `queryDataset` alone, so anything failing before it
 * leaked the handle.
 */
const probeThenQuery = async (
  context: RankContext,
  datasetId: string,
  topics: readonly Topic[]
): Promise<QueryOutcome> => {
  const { port, options } = context;
  try {
    await probePortSoundness({
      port,
      datasetId,
      adapter: options.adapter,
      topicTexts: topics.map(topic => topic.text),
    });
    return await queryDataset(context, topics);
  } finally {
    port.close?.();
  }
};

/** The scorable topics, after warning about any this bench cannot tell apart. */
const topicsFor = (
  dir: string,
  datasetId: string,
  qrels: ReadonlyMap<string, Qrel>
): readonly Topic[] => {
  const queries = readQueries(dir);
  warnCollapsingTopics(datasetId, queries, qrels);
  return topicsOf(queries, qrels);
};

const runDataset = async (entry: DatasetEntry, options: CliOptions): Promise<DatasetResult> => {
  const dir = await ensureDataset(entry);
  const qrels = readQrels(dir, entry.format === 'bright' ? 'test' : entry.qrels);
  const topics = topicsFor(dir, entry.id, qrels);
  const prepared = await prepareOf(entry, dir, {
    adapter: options.adapter,
    analyzer: options.analyzer,
  });
  // Before the dataset's FIRST rerank call, and before the port exists — a
  // refusal here has nothing to close. It doubles as the cold-load warm-up.
  if (options.rerank) await assertRerankDiscriminates({ model: options.rerankModel });
  const port = openPort(prepared, {
    adapter: options.adapter,
    hybridWeight: options.hybridWeight,
  });
  const context = { port, options, excluded: readExcluded(dir) };
  const queried = await probeThenQuery(context, entry.id, topics);
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

/**
 * The two halves of one dataset's turn, injected so the loop below can be driven
 * with a failing dataset in a test — the property it guards (an earlier dataset
 * is already on disk when a later one dies) is unobservable from a whole-suite
 * call, which is precisely how it went unnoticed until an OOM cost 67.5 minutes
 * of measurement.
 */
export interface DatasetRun {
  readonly measure: (entry: DatasetEntry) => Promise<DatasetResult>;
  readonly record: (result: DatasetResult) => void;
}

/**
 * Recording happens INSIDE the try: a dataset that measured but could not be
 * written down has not been recorded, and the run's contract counts recorded
 * datasets, not measured ones.
 */
const attempt = async (
  entry: DatasetEntry,
  run: DatasetRun
): Promise<DatasetResult | undefined> => {
  try {
    const result = await run.measure(entry);
    process.stdout.write(`${summaryLine(result)}\n`);
    run.record(result);
    return result;
  } catch (error) {
    process.stderr.write(`${entry.id}: FAILED — ${messageOf(error)}\n`);
    return undefined;
  }
};

const isResult = (value: DatasetResult | undefined): value is DatasetResult => value !== undefined;

/**
 * Each dataset is recorded the moment it finishes, BEFORE the next one starts.
 * Buffering to the end made "a partial run must never look complete" true only
 * for a dataset failure: a process death (OOM, 2026-08-15, six datasets in) lost
 * every completed dataset because not one row had been written.
 */
export const measureAndRecordAll = async (
  entries: readonly DatasetEntry[],
  run: DatasetRun
): Promise<readonly DatasetResult[]> =>
  (
    await entries.reduce<Promise<readonly (DatasetResult | undefined)[]>>(
      async (pending, entry) => [...(await pending), await attempt(entry, run)],
      Promise.resolve([])
    )
  ).filter(isResult);

/** What the flags resolved to, the ids they could not resolve, and how they were asked. */
export interface Selection {
  readonly entries: readonly DatasetEntry[];
  readonly unknown: readonly string[];
  /** The flags that produced it, so an EMPTY selection can name what emptied it. */
  readonly criteria?: string | undefined;
}

/** `--layer` narrows the pool the ids are then matched against — an intersection. */
const poolOf = (
  all: readonly DatasetEntry[],
  layer: LayerName | undefined
): readonly DatasetEntry[] => (layer === undefined ? all : datasetsInLayer(all, layer));

/**
 * A bare run measures the DEFAULT suite; a named layer is an explicit request,
 * so it measures its whole membership, `enabled` or not — the same rule `--only`
 * follows.
 */
const withoutIds = (
  pool: readonly DatasetEntry[],
  layer: LayerName | undefined
): readonly DatasetEntry[] => (layer === undefined ? enabledDatasets(pool) : pool);

/** Named so an empty intersection reports the flags, never a bare "nothing". */
const criteriaOf = (only: readonly string[], layer: LayerName | undefined): string | undefined => {
  const parts = [
    ...(layer === undefined ? [] : [`--layer ${layer}`]),
    ...(only.length === 0 ? [] : [`--only ${only.join(',')}`]),
  ];
  return parts.length === 0 ? undefined : parts.join(' with ');
};

/**
 * `enabled` means "member of the DEFAULT suite", not "runnable". So `--only`
 * selects across the WHOLE manifest: an explicit id is a direct request, and the
 * arm datasets are disabled precisely so they do not change what a bare run
 * measures. Filtering the enabled set first made `--only <disabled-or-typo>`
 * measure nothing and say nothing.
 *
 * `--layer` composes with it as an INTERSECTION: an id outside the layer is a
 * known id that this run does not measure, so it is not "unknown" — it empties
 * the selection instead, and `selectionError` refuses the run by name.
 */
export const selectDatasets = (
  all: readonly DatasetEntry[],
  only: readonly string[],
  layer?: LayerName | undefined
): Selection => {
  const pool = poolOf(all, layer);
  const known = new Set(all.map(entry => entry.id));
  return {
    entries: only.length === 0 ? withoutIds(pool, layer) : pool.filter(e => only.includes(e.id)),
    unknown: only.filter(id => !known.has(id)),
    criteria: criteriaOf(only, layer),
  };
};

/**
 * Why the run cannot start, or `undefined`. A selection that measures nothing
 * MUST NOT exit 0 — the suite's contract is that a partial run never looks
 * complete, and measuring zero datasets is the emptiest partial run there is.
 * An empty `--layer`/`--only` intersection lands here too, naming both flags:
 * every id was known, so the "unknown id" message would be a lie.
 */
export const selectionError = (selection: Selection): string | undefined => {
  if (selection.unknown.length > 0) {
    return `dp-gnosis-bench: unknown dataset id(s): ${selection.unknown.join(', ')}`;
  }
  if (selection.entries.length > 0) return undefined;
  const asked = selection.criteria === undefined ? '' : ` by ${selection.criteria}`;
  return `dp-gnosis-bench: no datasets selected${asked} — nothing was measured`;
};

/**
 * The rerank protocol is recorded ONLY on a rerank run: a row that reranked
 * nothing has no protocol, and stamping the default on it would make every new
 * BM25 row differ from every legacy one on a treatment field it never used.
 *
 * The MODEL is resolved before it is recorded, never left `undefined` on a run
 * that reranked: the id that scored the documents is not recoverable from the
 * numbers afterwards, and two model arms with no id on the row read as one
 * treatment.
 *
 * Exported so a test can read the TREATMENT a flag set records without paying
 * for a measured run — the value is unrecoverable from the numbers, so what it
 * stamps is the property worth asserting.
 */
export const provenanceOf = (options: CliOptions, gitSha: string): RunProvenance => ({
  ts: new Date().toISOString(),
  gitSha,
  adapter: options.adapter,
  depth: options.depth,
  rerank: options.rerank,
  rerankProfile: options.rerank ? options.rerankProfile : undefined,
  rerankWeight: options.rerank ? options.rerankWeight : undefined,
  rerankModel: options.rerank ? (options.rerankModel ?? RERANK_MODEL_ID) : undefined,
  rerankPool: options.rerank ? firstPassDepth(options.depth, options.rerank) : undefined,
  hybridWeight: options.hybridWeight,
  analyzer: options.analyzer,
  queryAdjacency: options.queryAdjacency,
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

/**
 * The whole-run view, over exactly the datasets that ran. It adds no record —
 * every one of them was already written down as it finished.
 */
const summarize = (provenance: RunProvenance, results: readonly DatasetResult[]): void => {
  const written = writeRunSummary({ resultsDir: RESULTS_DIR, provenance, results });
  process.stdout.write(`\nwrote ${written.markdownPath}\n`);
};

/** Every selected dataset ran and was recorded, or the run failed. */
const exitCode = (recorded: number, selectedCount: number): number =>
  recorded === selectedCount ? 0 : FAILURE_EXIT_CODE;

/**
 * The provenance is stamped ONCE, before the first dataset: it names the
 * per-dataset artefact paths and the summary stem alike, so a suite that
 * completes leaves a summary whose stem matches the rows it describes.
 */
const runSelection = async (
  entries: readonly DatasetEntry[],
  options: CliOptions,
  gitSha: string
): Promise<number> => {
  const provenance = provenanceOf(options, gitSha);
  const results = await measureAndRecordAll(entries, {
    measure: entry => runDataset(entry, options),
    record: result => {
      recordDataset({ resultsDir: RESULTS_DIR, provenance, result });
    },
  });
  if (results.length > 0) summarize(provenance, results);
  if (options.compare) printComparison();
  return exitCode(results.length, entries.length);
};

export const main = async (argv: readonly string[], gitSha: string): Promise<number> => {
  const options = parseArgs(argv);
  const selection = selectDatasets(loadManifest(MANIFEST_PATH), options.only, options.layer);
  const problem = selectionError(selection);
  if (problem === undefined) return runSelection(selection.entries, options, gitSha);
  process.stderr.write(`${problem}\n`);
  return FAILURE_EXIT_CODE;
};

/** Guarded so the exported helpers stay importable from a test. */
const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  process.exitCode = await main(process.argv.slice(2), currentGitSha(SUITE_ROOT));
}
