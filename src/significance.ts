/**
 * Is a delta distinguishable from noise? — the paired test the harness lacked.
 *
 * With per-topic sd around 0.20 over ~100 topics the standard error is ~0.02,
 * so a headline movement under ~0.04 on one split says nothing. Three of the
 * four recorded sweep results sit in exactly that band. This module answers the
 * question from artefacts that ALREADY exist: `results/per-topic/<stem>-<dataset>.tsv`
 * is written on every run, so a paired test costs no re-run.
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
 * Two refusals are load-bearing:
 *
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

import { type ProvenanceChange, provenanceChanges } from './compare.js';
import type { Metrics } from './metrics.js';
import { type HistoryRow, PER_TOPIC_DIR, reportStem } from './report.js';

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

/** `report.ts`'s TSV header, verbatim — a file that does not start with it is not ours. */
const TSV_HEADER = 'query_id\tndcg10\trecall10\trecall100\tmrr10';

const TSV_COLUMNS = 5;

/** Which of the four measures the test is run on; the caller names it. */
export type MetricName = keyof Metrics;

/** Per-topic scores for one run, keyed by `query_id`. */
export type TopicScores = ReadonlyMap<string, Metrics>;

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

export type Significance =
  | SignificanceVerdict
  | SignificanceProvenanceChanged
  | SignificanceTopicsDiffer
  | SignificanceMissingPerTopic;

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

const parseMetrics = (columns: readonly string[]): Metrics | undefined => {
  const values = columns.slice(1).map(Number);
  return values.length === TSV_COLUMNS - 1 && values.every(Number.isFinite)
    ? { ndcg10: values[0] ?? 0, recall10: values[1] ?? 0, recall100: values[2] ?? 0, mrr10: values[3] ?? 0 }
    : undefined;
};

const parseRow = (line: string): readonly [string, Metrics] | undefined => {
  const columns = line.split('\t');
  const metrics = columns.length === TSV_COLUMNS ? parseMetrics(columns) : undefined;
  return metrics === undefined || columns[0] === undefined || columns[0].length === 0
    ? undefined
    : [columns[0], metrics];
};

const isEntry = (
  entry: readonly [string, Metrics] | undefined
): entry is readonly [string, Metrics] => entry !== undefined;

const parseTsv = (text: string): TopicScores | undefined => {
  const lines = text.split('\n').filter(line => line.trim().length > 0);
  const entries = lines.slice(1).map(parseRow).filter(isEntry);
  return lines[0] === TSV_HEADER && entries.length > 0 ? new Map(entries) : undefined;
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
 * Where the run's per-topic TSV lives. The stem is derived from `ts` by the
 * same `reportStem` the writer used, so the two cannot drift.
 */
export const perTopicPath = (resultsDir: string, run: HistoryRow): string =>
  resolve(resultsDir, PER_TOPIC_DIR, `${reportStem(run.ts)}-${run.dataset}.tsv`);

const missingFrom = (left: TopicScores, right: TopicScores): readonly string[] =>
  [...left.keys()].filter(id => !right.has(id)).sort();

/** Defined for every id by the time this runs — the topic sets were matched first. */
const scoreOf = (scores: TopicScores, id: string, metric: MetricName): number =>
  scores.get(id)?.[metric] ?? 0;

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
  const differences = [...before.keys()]
    .sort()
    .map(id => scoreOf(after, id, metric) - scoreOf(before, id, metric));
  return verdictOf(dataset, metric, differences);
};

interface LoadedRun {
  readonly path: string;
  readonly scores: TopicScores | undefined;
}

const loadRun = (resultsDir: string, run: HistoryRow): LoadedRun => {
  const path = perTopicPath(resultsDir, run);
  return { path, scores: readPerTopic(path) };
};

const unreadable = (dataset: string, runs: readonly LoadedRun[]): SignificanceMissingPerTopic => ({
  kind: 'missing-per-topic',
  dataset,
  paths: runs.filter(run => run.scores === undefined).map(run => run.path),
});

/**
 * Whether `latest` beat `previous` on `metric` by more than noise, with the
 * interval that says by how much — or the reason the two runs cannot be paired.
 */
export const pairedSignificance = (options: PairedSignificanceOptions): Significance => {
  const { dataset } = options.previous;
  const changed = provenanceChanges(options.previous, options.latest);
  if (changed.length > 0) return { kind: 'provenance-changed', dataset, changed };
  const before = loadRun(options.resultsDir, options.previous);
  const after = loadRun(options.resultsDir, options.latest);
  return before.scores === undefined || after.scores === undefined
    ? unreadable(dataset, [before, after])
    : pairedScores(dataset, options.metric, before.scores, after.scores);
};
