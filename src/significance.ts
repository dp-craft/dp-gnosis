/**
 * Is a delta distinguishable from noise? — the paired test the harness lacked.
 *
 * With per-topic sd around 0.20 over ~100 topics the standard error is ~0.02,
 * so a headline movement under ~0.04 on one split says nothing. Three of the
 * four recorded sweep results sit in exactly that band. This module answers the
 * question from artefacts that ALREADY exist: a per-topic TSV is written on every
 * run and its path is recorded on the run's history row, so a paired test costs
 * no re-run and each side is read from the file its OWN run wrote.
 *
 * Two statistics over ONE paired per-topic difference vector:
 *
 * | Statistic | Method | Answers |
 * |---|---|---|
 * | p-value | paired permutation (randomization), sign-flipping each topic's difference | how often noise alone produces a mean this large |
 * | CI | paired bootstrap, resampling topic PAIRS with replacement | how large the difference plausibly is |
 *
 * The permutation test is the IR standard (Smucker, Allan & Carterette 2007);
 * the bootstrap supplies the interval the permutation test does not.
 *
 * Three refusals are load-bearing:
 *
 * - A run whose history row records no per-topic path is REFUSED. Deriving the
 *   path from the timestamp lost the adapter and the second, so an arm
 *   comparison read one file twice and reported p=1 on a real delta.
 * - Provenance is delegated to `compare.ts` verbatim. A test between two runs
 *   whose measuring scale moved would put a significance stamp on the exact
 *   error that module exists to prevent, so the same guard governs both.
 * - Topic sets MUST match exactly. Silently inner-joining two runs drops
 *   whichever topics one arm failed on — usually the hard ones — and biases the
 *   estimate in the direction of the arm that failed.
 *
 * Randomization here is SEEDED. The benchmark reproduces to the last digit and
 * a randomized test must not be what breaks that, so the generator is a
 * counter-addressed mulberry32: the same inputs yield the same p-value and the
 * same interval, on every machine, forever.
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { type ProvenanceChange, provenanceChanges, scaleChanges, treatmentChanges } from './compare.js';
import type { Metrics } from './metrics.js';
import { type HistoryRow, PER_TOPIC_QUERY_COLUMN } from './report.js';

/** Fixed so a re-run reproduces the p-value exactly; any value works, this one is arbitrary-but-pinned. */
export const SIGNIFICANCE_SEED = 0x5eed_0d17;

/** The field standard for a randomization test — resolves p to ~1e-4, the floor a 10k test can report. */
export const PERMUTATION_ITERATIONS = 10_000;

/** Matched to the permutation count so neither statistic is the coarser one. */
export const BOOTSTRAP_ITERATIONS = 10_000;

/** Two-sided 95% — the level every published IR delta is read at. */
export const CI_LEVEL = 0.95;

/** The significance threshold implied by the interval level; no second knob. */
export const ALPHA = 1 - CI_LEVEL;

/** mulberry32's state increment; used as a stride so a counter addresses the stream directly. */
const MULBERRY_STRIDE = 0x6d2b79f5;

/** Sign-flipping reorders the float summation, so an exact tie needs a tolerance. */
const TIE_EPSILON = 1e-12;

/** Independent streams: the two statistics must not share draws. */
const PERMUTATION_STREAM = SIGNIFICANCE_SEED;
const BOOTSTRAP_STREAM = SIGNIFICANCE_SEED ^ 0x9e37_79b9;

/**
 * The column NAMES every per-topic TSV has carried since the first recorded run
 * — the header signature that says a file is ours. They are still always
 * EMITTED, so this detection is unchanged by a cutoff becoming unmeasurable.
 */
const HEADER_COLUMNS = ['ndcg10', 'recall10', 'recall100', 'mrr10'] as const;

/**
 * The columns whose VALUE must be present for a row to be a measurement. It is a
 * strict subset of `HEADER_COLUMNS`: a run below depth 100 emits the `recall100`
 * column with an EMPTY cell, and requiring a value there would reject every row
 * of that file and read the whole run as missing.
 */
const REQUIRED_VALUES = ['ndcg10', 'mrr10'] as const;

/** Which measure the test is run on; the caller names it. */
export type MetricName = keyof Metrics;

/**
 * The READ side of `Metrics`: a TSV recorded before a column existed carries no
 * cell for it, and a cutoff the run never retrieved to carries an empty one. Both
 * read as `undefined` — never as 0, which the paired test would subtract as a
 * measured difference.
 */
export type ParsedMetrics = { readonly [K in keyof Metrics]: number | undefined };

/** Per-topic scores for one run, keyed by `query_id`. */
export type TopicScores = ReadonlyMap<string, ParsedMetrics>;

/** The answer: a mean difference with the noise floor attached to it. */
export interface SignificanceVerdict {
  readonly kind: 'verdict';
  readonly dataset: string;
  readonly metric: MetricName;
  /** Paired topics — equal to both runs' topic counts, because they must match. */
  readonly topics: number;
  readonly meanDifference: number;
  /** Two-sided permutation p, floored at `1/(B+1)`: 10k draws cannot resolve below it. */
  readonly pValue: number;
  readonly ciLow: number;
  readonly ciHigh: number;
  /** `pValue < ALPHA`. An interval straddling 0 is the same statement, read visually. */
  readonly significant: boolean;
  /**
   * Present ONLY when the two runs differ by a treatment field: the verdict then
   * rates one arm against another, not one commit against the next. Absent for a
   * like-for-like pair, so a reader who sees it cannot miss the distinction.
   */
  readonly arms?: readonly ProvenanceChange[];
}

/** The scale moved between the runs — the same refusal `compare.ts` makes. */
export interface SignificanceProvenanceChanged {
  readonly kind: 'provenance-changed';
  readonly dataset: string;
  readonly changed: readonly ProvenanceChange[];
}

/** Unpairable: the runs scored different topics, named on both sides. */
export interface SignificanceTopicsDiffer {
  readonly kind: 'topics-differ';
  readonly dataset: string;
  readonly onlyInPrevious: readonly string[];
  readonly onlyInLatest: readonly string[];
}

/** A per-topic TSV was absent, malformed, or held no topics — the paths that failed. */
export interface SignificanceMissingPerTopic {
  readonly kind: 'missing-per-topic';
  readonly dataset: string;
  readonly paths: readonly string[];
}

/**
 * A run's history row records no per-topic path, so its OWN score vector cannot
 * be identified. Refusing is the whole point: the derivable name carries neither
 * the adapter nor the second, so falling back to it pairs an arm with whichever
 * run happened to write that file — usually itself, at p=1 and zero width.
 */
export interface SignificanceUnattributableRun {
  readonly kind: 'unattributable-run';
  readonly dataset: string;
  /** `<ts> (<adapter>)` for each row that cannot name its scores. */
  readonly runs: readonly string[];
}

/**
 * The requested measure is absent from at least one side's per-topic scores —
 * a legacy file that predates the metric, or a run whose retrieval depth never
 * reached the cutoff. Refusing is the point: pairing on a substituted 0 would
 * report a difference the runs never measured.
 */
export interface SignificanceMetricUnavailable {
  readonly kind: 'metric-unavailable';
  readonly dataset: string;
  readonly metric: MetricName;
  /** Why it cannot be paired, in the words a reader needs. */
  readonly reason: string;
}

export type Significance =
  | SignificanceVerdict
  | SignificanceProvenanceChanged
  | SignificanceTopicsDiffer
  | SignificanceMissingPerTopic
  | SignificanceUnattributableRun
  | SignificanceMetricUnavailable;

/** The two runs to pair, and the measure to test. */
export interface PairedSignificanceOptions {
  readonly resultsDir: string;
  readonly previous: HistoryRow;
  readonly latest: HistoryRow;
  readonly metric: MetricName;
}

/** mulberry32's avalanche, applied to a state the caller addresses by counter. */
const scramble = (state: number): number => {
  const a = Math.imul(state ^ (state >>> 15), 1 | state);
  const b = (a + Math.imul(a ^ (a >>> 7), 61 | a)) ^ a;
  return ((b ^ (b >>> 14)) >>> 0) / 0x1_0000_0000;
};

/**
 * The `counter`-th draw of the mulberry32 stream seeded with `seed`, in [0,1).
 *
 * Counter-addressed rather than stateful: every draw is a pure function of
 * (seed, counter), so no iteration order and no mutable generator can make two
 * runs disagree.
 */
export const unitRandom = (seed: number, counter: number): number =>
  scramble((seed + Math.imul(counter, MULBERRY_STRIDE)) | 0);

const meanOf = (values: readonly number[]): number =>
  values.reduce((sum, value) => sum + value, 0) / values.length;

/** One randomization draw: each topic's difference keeps or flips its sign. */
const permutedMean = (differences: readonly number[], iteration: number): number =>
  meanOf(
    differences.map((difference, topic) =>
      unitRandom(PERMUTATION_STREAM, iteration * differences.length + topic) < 0.5
        ? -difference
        : difference
    )
  );

/**
 * Two-sided p under the sharp null that each topic's difference is as likely to
 * have carried the opposite sign. The `+1` on both terms counts the observed
 * assignment, which is itself one of the permutations.
 */
const permutationPValue = (differences: readonly number[]): number => {
  const observed = Math.abs(meanOf(differences)) - TIE_EPSILON;
  const atLeastAsExtreme = Array.from(
    { length: PERMUTATION_ITERATIONS },
    (_unused, iteration) => permutedMean(differences, iteration)
  ).filter(mean => Math.abs(mean) >= observed).length;
  return (atLeastAsExtreme + 1) / (PERMUTATION_ITERATIONS + 1);
};

/** Index `u ∈ [0,1)` into `values`; the clamp guards only float edge cases. */
const pick = (values: readonly number[], u: number): number =>
  values[Math.min(values.length - 1, Math.floor(u * values.length))] ?? 0;

/** One bootstrap replicate: `n` topic PAIRS drawn with replacement. */
const resampledMean = (differences: readonly number[], iteration: number): number =>
  meanOf(
    differences.map((_unused, topic) =>
      pick(
        differences,
        unitRandom(BOOTSTRAP_STREAM, iteration * differences.length + topic)
      )
    )
  );

const quantile = (sorted: readonly number[], q: number): number =>
  sorted[Math.min(sorted.length - 1, Math.max(0, Math.round(q * (sorted.length - 1))))] ?? 0;

/** Percentile interval on the mean paired difference. */
const bootstrapInterval = (
  differences: readonly number[]
): { readonly low: number; readonly high: number } => {
  const means = Array.from({ length: BOOTSTRAP_ITERATIONS }, (_unused, iteration) =>
    resampledMean(differences, iteration)
  ).sort((a, b) => a - b);
  const tail = ALPHA / 2;
  return { low: quantile(means, tail), high: quantile(means, 1 - tail) };
};

/** An empty or non-numeric field is ABSENT, which is not the number 0. */
const cellValue = (raw: string | undefined): number | undefined => {
  const value = raw === undefined || raw.trim().length === 0 ? Number.NaN : Number(raw);
  return Number.isFinite(value) ? value : undefined;
};

type CellsByColumn = ReadonlyMap<string, number | undefined>;

const metricsFrom = (cells: CellsByColumn): ParsedMetrics => ({
  ndcg10: cells.get('ndcg10'),
  recall10: cells.get('recall10'),
  recall20: cells.get('recall20'),
  recall100: cells.get('recall100'),
  recall300: cells.get('recall300'),
  recall1000: cells.get('recall1000'),
  mrr10: cells.get('mrr10'),
  precision5: cells.get('precision5'),
  precision10: cells.get('precision10'),
  allGoldInTop10: cells.get('allGoldInTop10'),
  map: cells.get('map'),
  rPrecision: cells.get('rPrecision'),
  rbpResidual: cells.get('rbpResidual'),
});

const parseMetrics = (cells: CellsByColumn): ParsedMetrics | undefined => {
  const present = REQUIRED_VALUES.filter(column => cells.get(column) !== undefined);
  return present.length < REQUIRED_VALUES.length ? undefined : metricsFrom(cells);
};

/** Fields addressed by the header's column NAMES, so a legacy file still reads. */
const cellsOf = (header: readonly string[], columns: readonly string[]): CellsByColumn =>
  new Map(header.map((name, index) => [name, cellValue(columns[index])] as const));

const parseRow = (
  header: readonly string[],
  line: string
): readonly [string, ParsedMetrics] | undefined => {
  const columns = line.split('\t');
  const queryId = columns[0];
  if (queryId === undefined || queryId.length === 0 || columns.length !== header.length) {
    return undefined;
  }
  const metrics = parseMetrics(cellsOf(header, columns));
  return metrics === undefined ? undefined : [queryId, metrics];
};

const isEntry = (
  entry: readonly [string, ParsedMetrics] | undefined
): entry is readonly [string, ParsedMetrics] => entry !== undefined;

/** Ours when it is keyed by `query_id` and names every metric a run has always had. */
const headerOf = (line: string | undefined): readonly string[] | undefined => {
  const columns = line === undefined ? [] : line.split('\t');
  return columns[0] === PER_TOPIC_QUERY_COLUMN &&
    HEADER_COLUMNS.every(column => columns.includes(column))
    ? columns
    : undefined;
};

const parseTsv = (text: string): TopicScores | undefined => {
  const lines = text.split('\n').filter(line => line.trim().length > 0);
  const header = headerOf(lines[0]);
  if (header === undefined) return undefined;
  const entries = lines.slice(1).map(line => parseRow(header, line)).filter(isEntry);
  return entries.length > 0 ? new Map(entries) : undefined;
};

/**
 * Per-topic scores from one run's TSV, or `undefined` when the file is absent,
 * unreadable, not one of ours, or holds no topics. Like `readHistory`, this
 * NEVER throws — an unpairable file is a named refusal, not a crash.
 */
export const readPerTopic = (path: string): TopicScores | undefined => {
  if (!existsSync(path)) return undefined;
  try {
    return parseTsv(readFileSync(path, 'utf8'));
  } catch {
    return undefined;
  }
};

/**
 * Where the run's per-topic TSV lives — READ off the row the writer recorded it
 * on, never derived. `undefined` for a row written before the field existed:
 * a derived path is unattributable across adapters and across two runs of the
 * same minute, and an unattributable path is what pairs a run with itself.
 */
export const perTopicPath = (resultsDir: string, run: HistoryRow): string | undefined =>
  run.perTopicPath === undefined ? undefined : resolve(resultsDir, run.perTopicPath);

const missingFrom = (left: TopicScores, right: TopicScores): readonly string[] =>
  [...left.keys()].filter(id => !right.has(id)).sort();

const isMeasured = (value: number | undefined): value is number => value !== undefined;

/**
 * Every topic's value for `metric`, or `undefined` when ANY topic lacks it. A
 * partial vector is not a measurement: filling the gaps with 0 invents a
 * difference, and dropping those topics biases the estimate.
 */
const measuredValues = (
  scores: TopicScores,
  ids: readonly string[],
  metric: MetricName
): readonly number[] | undefined => {
  const values = ids.map(id => scores.get(id)?.[metric]).filter(isMeasured);
  return values.length === ids.length ? values : undefined;
};

const metricUnavailable = (
  dataset: string,
  metric: MetricName
): SignificanceMetricUnavailable => ({
  kind: 'metric-unavailable',
  dataset,
  metric,
  reason:
    `${metric} is absent from at least one run's per-topic scores — the file predates ` +
    'the metric, or the run never retrieved to that cutoff. A paired test on a ' +
    'substituted 0 would report a difference neither run measured.',
});

const verdictOf = (
  dataset: string,
  metric: MetricName,
  differences: readonly number[]
): SignificanceVerdict => {
  const pValue = permutationPValue(differences);
  const interval = bootstrapInterval(differences);
  return {
    kind: 'verdict',
    dataset,
    metric,
    topics: differences.length,
    meanDifference: meanOf(differences),
    pValue,
    ciLow: interval.low,
    ciHigh: interval.high,
    significant: pValue < ALPHA,
  };
};

/**
 * The paired test over two ALREADY-LOADED per-topic score sets — the one
 * implementation of the statistic, and the entry point for any caller whose
 * scores did not come from a `HistoryRow` pair (a sweep cell carries its own
 * `perTopicPath` and is not a bench run). `pairedSignificance` is this function
 * plus run resolution and the provenance guard, so the two can never diverge.
 *
 * Topic sets MUST match exactly here too: an inner join would drop whichever
 * topics one arm failed on and bias the estimate toward that arm.
 */
export const pairedScores = (
  dataset: string,
  metric: MetricName,
  before: TopicScores,
  after: TopicScores
): Significance => {
  const onlyInPrevious = missingFrom(before, after);
  const onlyInLatest = missingFrom(after, before);
  if (onlyInPrevious.length + onlyInLatest.length > 0) {
    return { kind: 'topics-differ', dataset, onlyInPrevious, onlyInLatest };
  }
  const ids = [...before.keys()].sort();
  const beforeValues = measuredValues(before, ids, metric);
  const afterValues = measuredValues(after, ids, metric);
  if (beforeValues === undefined || afterValues === undefined) {
    return metricUnavailable(dataset, metric);
  }
  return verdictOf(dataset, metric, afterValues.map((value, i) => value - (beforeValues[i] ?? 0)));
};

interface LoadedRun {
  readonly row: HistoryRow;
  /** `undefined` when the row records no path — the run is unattributable. */
  readonly path: string | undefined;
  readonly scores: TopicScores | undefined;
}

const loadRun = (resultsDir: string, row: HistoryRow): LoadedRun => {
  const path = perTopicPath(resultsDir, row);
  return { row, path, scores: path === undefined ? undefined : readPerTopic(path) };
};

const unreadable = (dataset: string, runs: readonly LoadedRun[]): SignificanceMissingPerTopic => ({
  kind: 'missing-per-topic',
  dataset,
  paths: runs.flatMap(run => (run.scores === undefined && run.path !== undefined ? [run.path] : [])),
});

const unattributable = (
  dataset: string,
  runs: readonly LoadedRun[]
): SignificanceUnattributableRun => ({
  kind: 'unattributable-run',
  dataset,
  runs: runs
    .filter(run => run.path === undefined)
    .map(run => `${run.row.ts} (${run.row.adapter})`),
});

/**
 * The test, or the refusal that precedes it. Attribution is checked BEFORE
 * readability: a row that cannot name its scores has no path to report missing.
 */
const pairedRuns = (
  dataset: string,
  metric: MetricName,
  runs: readonly [LoadedRun, LoadedRun]
): Significance => {
  const [before, after] = runs;
  if (before.path === undefined || after.path === undefined) {
    return unattributable(dataset, runs);
  }
  return before.scores === undefined || after.scores === undefined
    ? unreadable(dataset, runs)
    : pairedScores(dataset, metric, before.scores, after.scores);
};

/** The arms carried onto the verdict, so a p-value never travels unlabelled. */
const withArms = (
  result: Significance,
  arms: readonly ProvenanceChange[]
): Significance =>
  result.kind === 'verdict' && arms.length > 0 ? { ...result, arms } : result;

/**
 * Whether `latest` beat `previous` on `metric` by more than noise, with the
 * interval that says by how much — or the reason the two runs cannot be paired.
 *
 * A moved measuring SCALE still refuses, unchanged. A moved TREATMENT is tested
 * and the arms ride along on the verdict: refusing there would have made the
 * one comparison the harness exists to support impossible to state.
 */
export const pairedSignificance = (options: PairedSignificanceOptions): Significance => {
  const { dataset } = options.previous;
  if (scaleChanges(options.previous, options.latest).length > 0) {
    return {
      kind: 'provenance-changed',
      dataset,
      changed: provenanceChanges(options.previous, options.latest),
    };
  }
  const runs = [
    loadRun(options.resultsDir, options.previous),
    loadRun(options.resultsDir, options.latest),
  ] as const;
  return withArms(
    pairedRuns(dataset, options.metric, runs),
    treatmentChanges(options.previous, options.latest)
  );
};
