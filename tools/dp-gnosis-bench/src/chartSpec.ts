/**
 * The campaign's figures, declared as DATA.
 *
 * A chart script that names its runs in TypeScript is a second place where the
 * experiment lives, and the two drift. `charts.json` is the only place a
 * comparison is declared: a future session adds a figure by adding an entry,
 * never by editing a renderer.
 *
 * Every selector is the SAME selector `pair.ts` resolves — a unique substring of
 * a run's recorded `perTopicPath` — so a chart and a paired test can never name
 * two different runs by the same words.
 *
 * Parsing REFUSES rather than defaults. A misspelled metric, a missing field or
 * an unknown chart kind fails naming itself: a figure silently dropped from a
 * regenerated set reads exactly like a figure that was never asked for.
 */
import { readFileSync } from 'node:fs';

import { PER_TOPIC_METRIC_COLUMNS } from './report.js';
import type { MetricName } from './significance.js';

/** One horizontal bar: two runs, one measure, one delta with its interval. */
export interface DeltaComparisonSpec {
  readonly label: string;
  /** The baseline side — the delta is B − A. */
  readonly a: string;
  readonly b: string;
  readonly metric: MetricName;
}

/** One run to draw, named the way the figure should read. */
export interface RunRefSpec {
  readonly label: string;
  readonly selector: string;
}

export interface DeltaChartSpec {
  readonly kind: 'delta';
  readonly id: string;
  readonly title: string;
  readonly comparisons: readonly DeltaComparisonSpec[];
}

export interface RecallDepthChartSpec {
  readonly kind: 'recall-depth';
  readonly id: string;
  readonly title: string;
  readonly runs: readonly RunRefSpec[];
}

export interface ArmChartSpec {
  readonly kind: 'arms';
  readonly id: string;
  readonly title: string;
  readonly runs: readonly RunRefSpec[];
  readonly metrics: readonly MetricName[];
}

export type ChartSpec = DeltaChartSpec | RecallDepthChartSpec | ArmChartSpec;

/**
 * The whole figure set. `corpusDocuments` carries each dataset's document count
 * because the random-ranking floor is E[recall@k] = k/N — a number that is a
 * property of the CORPUS, not of any run, and therefore has nowhere else to be
 * declared honestly.
 */
export interface ChartsSpec {
  readonly corpusDocuments: Readonly<Record<string, number>>;
  readonly charts: readonly ChartSpec[];
}

const fail = (what: string): never => {
  throw new Error(`dp-gnosis-bench charts: ${what}`);
};

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const record = (value: unknown, where: string): Readonly<Record<string, unknown>> =>
  isRecord(value) ? value : fail(`${where} must be an object`);

const text = (
  source: Readonly<Record<string, unknown>>,
  key: string,
  where: string
): string => {
  const value = source[key];
  return typeof value === 'string' && value.length > 0
    ? value
    : fail(`${where}: "${key}" must be a non-empty string`);
};

const list = (
  source: Readonly<Record<string, unknown>>,
  key: string,
  where: string
): readonly unknown[] => {
  const value = source[key];
  return Array.isArray(value) && value.length > 0
    ? value
    : fail(`${where}: "${key}" must be a non-empty array`);
};

const metricOf = (value: unknown, where: string): MetricName => {
  const known = PER_TOPIC_METRIC_COLUMNS.find(name => name === value);
  return (
    known ??
    fail(
      `${where}: unknown metric ${JSON.stringify(value)} — ` +
        `known: ${PER_TOPIC_METRIC_COLUMNS.join(', ')}`
    )
  );
};

const comparisonOf = (value: unknown, where: string): DeltaComparisonSpec => {
  const source = record(value, where);
  return {
    label: text(source, 'label', where),
    a: text(source, 'a', where),
    b: text(source, 'b', where),
    metric: metricOf(source['metric'], where),
  };
};

const runRefOf = (value: unknown, where: string): RunRefSpec => {
  const source = record(value, where);
  return { label: text(source, 'label', where), selector: text(source, 'selector', where) };
};

const runsOf = (
  source: Readonly<Record<string, unknown>>,
  where: string
): readonly RunRefSpec[] =>
  list(source, 'runs', where).map((run, index) => runRefOf(run, `${where}.runs[${index}]`));

const headOf = (
  source: Readonly<Record<string, unknown>>,
  where: string
): { readonly id: string; readonly title: string } => ({
  id: text(source, 'id', where),
  title: text(source, 'title', where),
});

const deltaOf = (
  source: Readonly<Record<string, unknown>>,
  where: string
): DeltaChartSpec => ({
  kind: 'delta',
  ...headOf(source, where),
  comparisons: list(source, 'comparisons', where).map((one, index) =>
    comparisonOf(one, `${where}.comparisons[${index}]`)
  ),
});

const armsOf = (source: Readonly<Record<string, unknown>>, where: string): ArmChartSpec => ({
  kind: 'arms',
  ...headOf(source, where),
  runs: runsOf(source, where),
  metrics: list(source, 'metrics', where).map((one, index) =>
    metricOf(one, `${where}.metrics[${index}]`)
  ),
});

const chartOf = (value: unknown, index: number): ChartSpec => {
  const where = `charts[${index}]`;
  const source = record(value, where);
  const kind = text(source, 'kind', where);
  if (kind === 'delta') return deltaOf(source, where);
  if (kind === 'arms') return armsOf(source, where);
  if (kind === 'recall-depth') {
    return { kind, ...headOf(source, where), runs: runsOf(source, where) };
  }
  return fail(
    `${where}: unknown chart kind ${JSON.stringify(kind)} — known: delta, recall-depth, arms`
  );
};

const countOf = (value: unknown, dataset: string): number =>
  typeof value === 'number' && Number.isFinite(value) && value > 0
    ? value
    : fail(`corpusDocuments["${dataset}"] must be a positive document count`);

const corpusDocumentsOf = (value: unknown): Readonly<Record<string, number>> =>
  Object.fromEntries(
    Object.entries(record(value, '"corpusDocuments"')).map(
      ([dataset, count]) => [dataset, countOf(count, dataset)] as const
    )
  );

/** The spec, or the named reason it is not one. */
export const parseChartsSpec = (value: unknown): ChartsSpec => {
  const source = record(value, 'the charts spec');
  return {
    corpusDocuments: corpusDocumentsOf(source['corpusDocuments']),
    charts: list(source, 'charts', 'the charts spec').map(chartOf),
  };
};

export const readChartsSpec = (path: string): ChartsSpec => {
  const raw: unknown = JSON.parse(readFileSync(path, 'utf8'));
  return parseChartsSpec(raw);
};
