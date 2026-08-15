/**
 * Every number a figure draws, resolved from recorded artefacts — and NOTHING
 * computed here.
 *
 * The delta bars' p-values and intervals come from `significance.pairedScores`
 * unchanged, the runs come from `pair.resolveRun`, the provenance guard comes
 * from `compare.scaleChanges`. A chart that recomputed a statistic could disagree
 * with the paired test it illustrates, which is the one thing a figure must never
 * do.
 *
 * Three refusals, all loud:
 *
 * | Situation | Answer |
 * |---|---|
 * | a selector matching no run, or more than one | THROW, naming it — the same contract `pair.ts` states |
 * | a moved measuring scale between the two sides | THROW, naming the field |
 * | a refused paired test (`topics-differ`, `metric-unavailable`, …) | THROW with the refusal kind — drawing a bar for a test that never ran is inventing a number |
 *
 * A cutoff a run never retrieved to is OMITTED from its curve. `recall300` is
 * `undefined` on a depth-100 run, and plotting that as 0 would draw a collapse
 * the run never measured.
 */
import { RERANK_K_INIT } from '../../dp-gnosis/src/config.js';
import type { ChartSpec, ChartsSpec, DeltaComparisonSpec, RunRefSpec } from './chartSpec.js';
import { scaleChanges } from './compare.js';
import { describeRun, resolveRun } from './pair.js';
import type { HistoryRow } from './report.js';
import {
  type MetricName,
  pairedScores,
  perTopicPath,
  readPerTopic,
  type SignificanceVerdict,
  type TopicScores
} from './significance.js';

/** The depths the suite records a recall at — the x-axis of the depth curve. */
export const CUTOFFS = [10, 20, 100, 300, 1000] as const;

/** The reranker's input window, read from the engine's own constant. */
export const RERANK_WINDOW = RERANK_K_INIT;

const CUTOFF_METRICS: readonly (readonly [number, MetricName])[] = [
  [10, 'recall10'],
  [20, 'recall20'],
  [100, 'recall100'],
  [300, 'recall300'],
  [1000, 'recall1000'],
];

/** Everything resolution needs: where the TSVs are, which runs exist, corpus sizes. */
export interface ChartContext {
  readonly resultsDir: string;
  readonly history: readonly HistoryRow[];
  readonly corpusDocuments: Readonly<Record<string, number>>;
}

export interface DeltaBar {
  readonly label: string;
  readonly metric: MetricName;
  readonly delta: number;
  readonly ciLow: number;
  readonly ciHigh: number;
  readonly pValue: number;
  readonly topics: number;
  /** The interval straddles 0 — the delta is INDISTINGUISHABLE from noise. */
  readonly crossesZero: boolean;
}

export interface DeltaChart {
  readonly kind: 'delta';
  readonly id: string;
  readonly title: string;
  readonly metricLabel: string;
  readonly bars: readonly DeltaBar[];
  readonly caption: string;
}

export interface RecallPoint {
  readonly cutoff: number;
  readonly recall: number;
}

export interface RecallLine {
  readonly label: string;
  readonly dataset: string;
  readonly points: readonly RecallPoint[];
}

export interface FloorLine {
  readonly dataset: string;
  readonly documents: number;
  readonly points: readonly RecallPoint[];
}

export interface RecallDepthChart {
  readonly kind: 'recall-depth';
  readonly id: string;
  readonly title: string;
  readonly lines: readonly RecallLine[];
  readonly floors: readonly FloorLine[];
  readonly caption: string;
}

export interface ArmBar {
  readonly metric: MetricName;
  readonly value: number;
}

export interface ArmGroup {
  readonly label: string;
  readonly bars: readonly ArmBar[];
}

export interface ArmChart {
  readonly kind: 'arms';
  readonly id: string;
  readonly title: string;
  readonly metrics: readonly MetricName[];
  readonly groups: readonly ArmGroup[];
  readonly caption: string;
}

export type Chart = DeltaChart | RecallDepthChart | ArmChart;

/** How each measure is named on an axis or in a legend. */
export const METRIC_LABELS: Readonly<Record<MetricName, string>> = {
  ndcg10: 'nDCG@10',
  recall10: 'R@10',
  recall20: 'R@20',
  recall100: 'R@100',
  recall300: 'R@300',
  recall1000: 'R@1000',
  mrr10: 'MRR@10',
};

const fail = (what: string): never => {
  throw new Error(`dp-gnosis-bench charts: ${what}`);
};

const runOf = (context: ChartContext, selector: string): HistoryRow => {
  const selection = resolveRun(context.history, selector);
  if (selection.kind === 'run') return selection.row;
  if (selection.kind === 'unmatched') {
    return fail(`selector "${selector}" matches no recorded run's perTopicPath`);
  }
  return fail(
    `selector "${selector}" is ambiguous, matching ${selection.matches.length} runs: ` +
      selection.matches.join(' | ')
  );
};

const scoresOf = (context: ChartContext, row: HistoryRow): TopicScores => {
  const path = perTopicPath(context.resultsDir, row);
  const scores = path === undefined ? undefined : readPerTopic(path);
  return scores ?? fail(`run records no readable per-topic scores: ${describeRun(row)}`);
};

/** One run, in the words a caption needs to trace the figure back to it. */
export const runCaption = (row: HistoryRow): string =>
  `${row.dataset} · ${row.adapter} · depth ${row.depth} · sha ${row.gitSha}`;

const captionOf = (rows: readonly HistoryRow[]): string =>
  `runs drawn: ${[...new Set(rows.map(runCaption))].join('  |  ')}`;

const verdictOf = (
  comparison: DeltaComparisonSpec,
  context: ChartContext,
  sides: readonly [HistoryRow, HistoryRow]
): SignificanceVerdict => {
  const [a, b] = sides;
  const moved = scaleChanges(a, b);
  if (moved.length > 0) {
    return fail(
      `"${comparison.label}": the measuring scale moved (${moved.map(one => one.field).join(', ')})`
    );
  }
  const label = a.dataset === b.dataset ? a.dataset : `${a.dataset} → ${b.dataset}`;
  const result = pairedScores(label, comparison.metric, scoresOf(context, a), scoresOf(context, b));
  return result.kind === 'verdict'
    ? result
    : fail(`"${comparison.label}": the paired test was refused (${result.kind})`);
};

interface ComparedPair {
  readonly bar: DeltaBar;
  readonly rows: readonly HistoryRow[];
}

const comparedPair = (context: ChartContext, comparison: DeltaComparisonSpec): ComparedPair => {
  const sides = [runOf(context, comparison.a), runOf(context, comparison.b)] as const;
  const verdict = verdictOf(comparison, context, sides);
  return {
    rows: [...sides],
    bar: {
      label: comparison.label,
      metric: comparison.metric,
      delta: verdict.meanDifference,
      ciLow: verdict.ciLow,
      ciHigh: verdict.ciHigh,
      pValue: verdict.pValue,
      topics: verdict.topics,
      crossesZero: verdict.ciLow <= 0 && verdict.ciHigh >= 0,
    },
  };
};

const metricLabelOf = (bars: readonly DeltaBar[]): string =>
  [...new Set(bars.map(bar => METRIC_LABELS[bar.metric]))].join(' / ');

const buildDelta = (
  context: ChartContext,
  spec: Extract<ChartSpec, { kind: 'delta' }>
): DeltaChart => {
  const pairs = spec.comparisons.map(comparison => comparedPair(context, comparison));
  const bars = pairs.map(pair => pair.bar);
  return {
    kind: 'delta',
    id: spec.id,
    title: spec.title,
    metricLabel: metricLabelOf(bars),
    bars,
    caption: captionOf(pairs.flatMap(pair => pair.rows)),
  };
};

const pointsOf = (row: HistoryRow): readonly RecallPoint[] =>
  CUTOFF_METRICS.flatMap(([cutoff, metric]) => {
    const recall = row[metric];
    return recall === undefined ? [] : [{ cutoff, recall }];
  });

const documentsOf = (context: ChartContext, dataset: string): number =>
  context.corpusDocuments[dataset] ??
  fail(
    `dataset "${dataset}" has no corpusDocuments entry — ` +
      'the random-ranking floor E[recall@k] = k/N cannot be drawn without N'
  );

const floorOf = (context: ChartContext, dataset: string): FloorLine => {
  const documents = documentsOf(context, dataset);
  return {
    dataset,
    documents,
    points: CUTOFFS.map(cutoff => ({ cutoff, recall: Math.min(1, cutoff / documents) })),
  };
};

const lineOf = (context: ChartContext, ref: RunRefSpec): { row: HistoryRow; line: RecallLine } => {
  const row = runOf(context, ref.selector);
  return { row, line: { label: ref.label, dataset: row.dataset, points: pointsOf(row) } };
};

const buildRecallDepth = (
  context: ChartContext,
  spec: Extract<ChartSpec, { kind: 'recall-depth' }>
): RecallDepthChart => {
  const drawn = spec.runs.map(ref => lineOf(context, ref));
  const datasets = [...new Set(drawn.map(one => one.row.dataset))];
  return {
    kind: 'recall-depth',
    id: spec.id,
    title: spec.title,
    lines: drawn.map(one => one.line),
    floors: datasets.map(dataset => floorOf(context, dataset)),
    caption: captionOf(drawn.map(one => one.row)),
  };
};

const armBars = (row: HistoryRow, metrics: readonly MetricName[]): readonly ArmBar[] =>
  metrics.flatMap(metric => {
    const value = row[metric];
    return value === undefined ? [] : [{ metric, value }];
  });

const buildArms = (
  context: ChartContext,
  spec: Extract<ChartSpec, { kind: 'arms' }>
): ArmChart => {
  const rows = spec.runs.map(ref => ({ ref, row: runOf(context, ref.selector) }));
  return {
    kind: 'arms',
    id: spec.id,
    title: spec.title,
    metrics: spec.metrics,
    groups: rows.map(one => ({
      label: one.ref.label,
      bars: armBars(one.row, spec.metrics),
    })),
    caption: captionOf(rows.map(one => one.row)),
  };
};

/** One declared figure, with every value read off a recorded artefact. */
export const buildChart = (context: ChartContext, spec: ChartSpec): Chart => {
  if (spec.kind === 'delta') return buildDelta(context, spec);
  if (spec.kind === 'recall-depth') return buildRecallDepth(context, spec);
  return buildArms(context, spec);
};

export const buildCharts = (context: ChartContext, spec: ChartsSpec): readonly Chart[] =>
  spec.charts.map(chart => buildChart(context, chart));
