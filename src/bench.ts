/**
 * The retrieval benchmark harness: every adapter, over the same golden set and
 * the same corpora, producing one comparable, persistable report.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * WARNING — TWO REGIMES, NEVER ONE HEADLINE NUMBER.
 *
 * (a) `cold-per-query`   — a port is opened and the index loaded for EVERY
 *                          query. Models a short-lived process that pays full
 *                          load per question.
 * (b) `warm-shared-index`— the index is loaded ONCE and then N queries run
 *                          against it, plus the cost of serving an already
 *                          cached answer. Models retrieval embedded in a
 *                          longer-lived caller.
 *
 * Regime (b) largely neutralizes the main handicap of a load-heavy adapter, so
 * WHICH REGIME YOU MEASURE CAN CHANGE WHICH ADAPTER WINS. Both are reported
 * side by side and MUST NOT be merged, averaged, or reduced to one figure.
 * ────────────────────────────────────────────────────────────────────────────
 *
 * This module reports NUMBERS. It does not, and must not, pick a winner: the
 * choice depends on the regime the caller actually runs in, and that is a human
 * judgement made from the report.
 *
 * Metrics are validated against the fake adapter, whose ranking is fixed and
 * hand-computable — see `bench/metrics.ts`.
 */
import { join } from 'node:path';

import type { AdapterCandidate, CorpusLocation, SkippedAdapter } from './bench/candidates.js';
import { isAvailable, skippedOf } from './bench/candidates.js';
import type { BenchCorpus } from './bench/corpora.js';
import { addUpdateProbe, removeUpdateProbe } from './bench/corpora.js';
import type { QueryAggregate, QueryMetric } from './bench/metrics.js';
import { aggregate, scoreQuery } from './bench/metrics.js';
import { mapSequential } from './bench/sequential.js';
import type { Thunk, TimingPolicy, TimingSample } from './bench/timing.js';
import { measureAll, timeValue } from './bench/timing.js';
import { ATOM_DOMAINS, ATOM_TYPES, type AtomDomain, type AtomType } from './config.js';
import type { GoldenQuery, GoldenSet, MinimumMeaningfulDifference } from './goldenSet.js';
import type { KnowledgePort, RetrievalResult, RetrieveOptions } from './port.js';

/** First ceiling rung: roughly 1.4x the seed corpus. */
export const SYNTHETIC_RUNG_SMALL = 1000;

/**
 * Second ceiling rung. The linear scan is EXPECTED to blow a 1–2 s budget here:
 * that is the reference line behaving correctly, not a defect to fix.
 */
export const SYNTHETIC_RUNG_LARGE = 10000;

/** Synthetic ceiling rungs, in atoms. The real seed corpus is measured too. */
export const SYNTHETIC_RUNGS: readonly number[] = [SYNTHETIC_RUNG_SMALL, SYNTHETIC_RUNG_LARGE];

/** Fixed so two runs on different machines generate the identical corpus. */
export const SYNTHETIC_SEED = 20260808;

/** Default depth. Recall and MRR are both reported AT this k. */
export const DEFAULT_BENCH_K = 5;

/** Conservative default: enough passes for a p95 that is not one sample. */
export const DEFAULT_TIMING: TimingPolicy = { warmupIterations: 2, measuredIterations: 5 };

export const COLD_REGIME = 'cold-per-query';
export const WARM_REGIME = 'warm-shared-index';

const COLD_DESCRIPTION =
  'a port is opened (index loaded) for every single query — models a short-lived process';
const WARM_DESCRIPTION =
  'index loaded once, then every query runs against it — models a longer-lived caller';

/** One regime's measured latency for one adapter on one corpus. */
export interface RegimeResult {
  readonly regime: string;
  readonly description: string;
  readonly latency: TimingSample;
  /** Serving an already-cached answer; present for the warm regime only. */
  readonly cacheHitP50Ms?: number;
}

/** Everything measured for one adapter over one corpus. */
export interface AdapterCorpusResult {
  readonly adapter: string;
  readonly corpus: string;
  readonly atomCount: number;
  /** Open + serve the first query: the full index-load cost, once. */
  readonly coldStartMs: number;
  readonly indexBuildMs: number;
  readonly indexSizeBytes: number;
  /** Rebuild cost after ONE atom changed — the incremental-update granularity. */
  readonly singleAtomUpdateMs: number;
  readonly regimes: readonly RegimeResult[];
  /** `undefined` on synthetic corpora, where the golden set names no atoms. */
  readonly metrics: QueryAggregate | undefined;
  readonly perQuery: readonly QueryMetric[];
}

/** The golden-set provenance a report must carry to be re-checkable. */
export interface GoldenSetProvenance {
  readonly path: string;
  readonly sha256: string;
  readonly frozenAt: string;
  readonly queryCount: number;
  readonly minimumMeaningfulDifference: MinimumMeaningfulDifference;
}

/** The persisted, diffable result of one benchmark run. */
export interface BenchReport {
  readonly generatedAt: string;
  readonly k: number;
  readonly timing: TimingPolicy;
  readonly goldenSet: GoldenSetProvenance;
  readonly adapters: readonly string[];
  readonly skippedAdapters: readonly SkippedAdapter[];
  readonly corpora: readonly BenchCorpus[];
  readonly results: readonly AdapterCorpusResult[];
}

export interface BenchOptions {
  readonly goldenSet: GoldenSet;
  readonly goldenSetPath: string;
  readonly goldenSetHash: string;
  readonly candidates: readonly AdapterCandidate[];
  readonly corpora: readonly BenchCorpus[];
  readonly workDir: string;
  readonly k: number;
  readonly timing: TimingPolicy;
  /** Injected so a report is reproducible in a test. */
  readonly now: Date;
}

/**
 * A membership test, never a cast: a golden query carries `domain` as a plain
 * string, and only a member of the closed vocabulary is a filter the port can
 * apply. A value outside it is a golden-set defect that `goldenSet.ts` refuses
 * at load time, so reaching here it can only be `null`.
 */
const asDomain = (value: string | null): AtomDomain | undefined =>
  value === null ? undefined : ATOM_DOMAINS.find(domain => domain === value);

/** Same membership test, on the closed `type` vocabulary. */
const asType = (value: string | null): AtomType | undefined =>
  value === null ? undefined : ATOM_TYPES.find(type => type === value);

// The two filters are INDEPENDENT: a query may carry both, either, or neither,
// and each is omitted rather than sent as `undefined` so an adapter cannot
// mistake "no filter asked for" for "filter on nothing".
const retrieveOptions = (query: GoldenQuery, k: number): RetrieveOptions => {
  const domain = asDomain(query.domain);
  const type = asType(query.type);
  return {
    k,
    ...(domain === undefined ? {} : { domain }),
    ...(type === undefined ? {} : { type }),
  };
};

/** One adapter × one corpus, with everything needed to measure it resolved. */
interface Pair {
  readonly candidate: AdapterCandidate;
  readonly corpus: BenchCorpus;
  readonly location: CorpusLocation;
  readonly options: BenchOptions;
}

const pairFor = (
  options: BenchOptions,
  candidate: AdapterCandidate,
  corpus: BenchCorpus
): Pair => ({
  candidate,
  corpus,
  options,
  location: {
    atomsDir: corpus.atomsDir,
    indexPath: join(options.workDir, `${candidate.name}-${corpus.label}.db`),
  },
});

const queriesOf = (pair: Pair): readonly GoldenQuery[] => pair.options.goldenSet.queries;

/** The ONE place a query reaches a port, so every regime asks the same thing. */
const askPort = (pair: Pair, port: KnowledgePort, query: GoldenQuery): Promise<RetrievalResult> =>
  port.retrieve(query.query, retrieveOptions(query, pair.options.k));

/**
 * A port MAY hold a resource open between calls, so every port this harness
 * opens is released — otherwise the cold regime, which opens one per query per
 * pass, would accumulate handles for the whole run and time a process it never
 * intends to model.
 */
const closePort = (port: KnowledgePort): void => port.close?.();

const askOnce = async (pair: Pair, query: GoldenQuery): Promise<RetrievalResult> => {
  const port = pair.candidate.open(pair.location);
  const result = await askPort(pair, port, query);
  closePort(port);
  return result;
};

const coldThunks = (pair: Pair): readonly Thunk[] =>
  queriesOf(pair).map(query => () => askOnce(pair, query));

const warmThunks = (pair: Pair, port: KnowledgePort): readonly Thunk[] =>
  queriesOf(pair).map(query => () => askPort(pair, port, query));

/**
 * Pre-populated, never mutated during measurement: the cache-hit regime must
 * time a LOOKUP, not a first miss that happens to fill a cache.
 */
const primeCache = async (
  pair: Pair,
  port: KnowledgePort
): Promise<ReadonlyMap<string, RetrievalResult>> =>
  new Map(
    await mapSequential(
      queriesOf(pair),
      async query => [query.id, await askPort(pair, port, query)] as const
    )
  );

const cacheHitThunks = (
  pair: Pair,
  cache: ReadonlyMap<string, RetrievalResult>
): readonly Thunk[] => queriesOf(pair).map(query => () => Promise.resolve(cache.get(query.id)));

const coldRegime = async (pair: Pair): Promise<RegimeResult> => ({
  regime: COLD_REGIME,
  description: COLD_DESCRIPTION,
  latency: await measureAll(coldThunks(pair), pair.options.timing),
});

const warmRegime = async (pair: Pair): Promise<RegimeResult> => {
  const port = pair.candidate.open(pair.location);
  const latency = await measureAll(warmThunks(pair, port), pair.options.timing);
  const cache = await primeCache(pair, port);
  const hits = await measureAll(cacheHitThunks(pair, cache), pair.options.timing);
  closePort(port);
  return { regime: WARM_REGIME, description: WARM_DESCRIPTION, latency, cacheHitP50Ms: hits.p50Ms };
};

const FALLBACK_QUERY = '';

/**
 * Cold start is measured ONCE, as open + first query. It is an in-process
 * proxy for a fresh process: module load and V8 warmup are already paid, so
 * this bounds the index-load component from BELOW, never the whole startup.
 */
const coldStart = async (pair: Pair): Promise<number> => {
  const first = queriesOf(pair)[0];
  const port = pair.candidate.open(pair.location);
  const measured = await timeValue(() =>
    port.retrieve(first?.query ?? FALLBACK_QUERY, { k: pair.options.k })
  );
  closePort(port);
  return measured.ms;
};

/**
 * Cost of making ONE changed atom retrievable. Safe because the corpus is a
 * working copy the bench owns; the probe is removed and the index rebuilt
 * afterwards, so the next measurement sees the corpus it was given.
 */
const singleAtomUpdate = async (pair: Pair): Promise<number> => {
  await addUpdateProbe(pair.corpus);
  const measured = await timeValue(() => pair.candidate.index(pair.location));
  await removeUpdateProbe(pair.corpus);
  await pair.candidate.index(pair.location);
  return measured.ms;
};

const scoreOne = async (
  pair: Pair,
  port: KnowledgePort,
  query: GoldenQuery
): Promise<QueryMetric> => {
  const result = await askPort(pair, port, query);
  return scoreQuery(query, result.atoms.map(atom => atom.id), pair.options.k);
};

const scoreCorpus = async (pair: Pair): Promise<readonly QueryMetric[]> => {
  const port = pair.candidate.open(pair.location);
  const metrics = await mapSequential(queriesOf(pair), query => scoreOne(pair, port, query));
  closePort(port);
  return metrics;
};

/** Synthetic corpora score nothing: the golden set names atoms they do not hold. */
const qualityOf = async (pair: Pair): Promise<readonly QueryMetric[]> =>
  pair.corpus.scoresMetrics ? await scoreCorpus(pair) : [];

/** The one-shot costs, kept apart so `measurePair` stays an assembly step. */
interface PairCosts {
  readonly coldStartMs: number;
  readonly indexBuildMs: number;
  readonly indexSizeBytes: number;
  readonly singleAtomUpdateMs: number;
}

/** Builds the index FIRST — every later measurement reads what this produced. */
const costsOf = async (pair: Pair): Promise<PairCosts> => {
  const built = await timeValue(() => pair.candidate.index(pair.location));
  return {
    indexBuildMs: built.ms,
    indexSizeBytes: built.value,
    coldStartMs: await coldStart(pair),
    singleAtomUpdateMs: await singleAtomUpdate(pair),
  };
};

const measurePair = async (pair: Pair): Promise<AdapterCorpusResult> => {
  const costs = await costsOf(pair);
  const perQuery = await qualityOf(pair);
  return {
    adapter: pair.candidate.name,
    corpus: pair.corpus.label,
    atomCount: pair.corpus.atomCount,
    ...costs,
    regimes: [await coldRegime(pair), await warmRegime(pair)],
    metrics: pair.corpus.scoresMetrics ? aggregate(pair.options.k, perQuery) : undefined,
    perQuery,
  };
};

const pairsOf = (options: BenchOptions): readonly Pair[] =>
  options.candidates
    .filter(isAvailable)
    .flatMap(candidate => options.corpora.map(corpus => pairFor(options, candidate, corpus)));

const provenanceOf = (options: BenchOptions): GoldenSetProvenance => ({
  path: options.goldenSetPath,
  sha256: options.goldenSetHash,
  frozenAt: options.goldenSet.frozenAt,
  queryCount: options.goldenSet.queries.length,
  minimumMeaningfulDifference: options.goldenSet.minimumMeaningfulDifference,
});

/**
 * Measure every AVAILABLE adapter over every corpus, in both regimes. An
 * unavailable adapter is not measured and IS listed in `skippedAdapters`.
 */
export const runBenchmark = async (options: BenchOptions): Promise<BenchReport> => ({
  generatedAt: options.now.toISOString(),
  k: options.k,
  timing: options.timing,
  goldenSet: provenanceOf(options),
  adapters: options.candidates.filter(isAvailable).map(candidate => candidate.name),
  skippedAdapters: skippedOf(options.candidates),
  corpora: options.corpora,
  results: await mapSequential(pairsOf(options), measurePair),
});
