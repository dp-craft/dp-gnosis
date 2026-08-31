/**
 * The paired test between TWO NAMED RUNS — including two runs of different
 * datasets.
 *
 * `--compare` can only ever pair a dataset against its own previous run, so the
 * one comparison the arm datasets were built for could not be made at all: a
 * `vault-rephrased` run carries the SAME topic ids and the SAME judgments as its
 * `vault` base, with only the query text rewritten, and measuring that lever
 * means pairing two rows whose `dataset` fields differ. This CLI names both runs
 * explicitly and pairs them.
 *
 * It is a CALLER of `significance.ts`, never a second implementation: the
 * permutation p, the bootstrap interval, the seed and the iteration counts all
 * come from there unchanged, so a number printed here and a number printed by
 * `--compare` are the same statistic.
 *
 * The guards are the ones the rest of the suite already makes, reused rather
 * than re-stated:
 *
 * | Difference | Answer |
 * |---|---|
 * | a `SCALE_FIELDS` move (`compare.ts`) | REFUSE, naming the field — a changed measuring scale can never masquerade as a quality change |
 * | a `TREATMENT_FIELDS` move | tested, labelled `ARM COMPARISON` before any number |
 * | a different `dataset` | ALLOWED — it is what this tool exists for — with both ids printed in the header |
 * | different topic-id sets | REFUSE (`topics-differ`) — identical ids are the whole basis of the pairing |
 * | a metric one side never measured | REFUSE (`metric-unavailable`) — pairing on a substituted 0 reports a difference neither run measured |
 *
 * `--ids` restricts the test to a subset of query ids. About a third of the
 * English rephrased topics are byte-identical to their base BY DESIGN, so the
 * whole-set delta is diluted by guaranteed ties and the changed-topic subset has
 * to be reportable next to it.
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { flagValue, invokedDirectly, messageOf } from './cli/shared.js';
import { type ProvenanceChange, scaleChanges, treatmentChanges } from './compare.js';
import { assertKnownFlags, type FlagSpec } from './flags.js';
import {
  HISTORY_FILE,
  type HistoryRow,
  PER_TOPIC_METRIC_COLUMNS,
  readHistory
} from './report.js';
import { SUITE_ROOT } from './run.js';
import {
  CI_LEVEL,
  type MetricName,
  pairedScores,
  perTopicPath,
  readPerTopic,
  type Significance,
  type SignificanceVerdict,
  type TopicScores
} from './significance.js';

/** Every requested metric produced a verdict. */
export const PAIR_EXIT_OK = 0;

/** At least one metric was refused — the scale moved, topics differ, or a metric is unmeasured. */
export const PAIR_EXIT_REFUSED = 1;

/** The invocation itself is unusable: a bad flag, or a selector that names no unique run. */
export const PAIR_EXIT_USAGE = 2;

const DIGITS = 4;
const PERCENT = 100;

/** The parsed invocation. An empty `metrics` means "every metric both runs measured". */
export interface PairArgs {
  readonly a: string;
  readonly b: string;
  readonly metrics: readonly MetricName[];
  readonly idsPath: string | undefined;
  /**
   * Which results directory to resolve `history.jsonl` and every `perTopicPath`
   * against. Absent ⇒ the suite's own `results/`, so every existing invocation
   * is unchanged. It exists so a run recorded OUTSIDE the tracked history — an
   * external system's arm, which MUST NOT enter `results/history.jsonl` — can
   * still be paired by exactly the same test, against a copy of the gnosis row.
   */
  readonly resultsDir: string | undefined;
}

/** What the CLI prints, and how it exits. `reasons` is the stderr half. */
export interface PairReport {
  readonly lines: readonly string[];
  readonly reasons: readonly string[];
  readonly exitCode: number;
}

export interface PairRequest {
  readonly resultsDir: string;
  readonly history: readonly HistoryRow[];
  readonly args: PairArgs;
}

export const PAIR_HELP = [
  'gnosis:pair — the paired permutation test between two named runs.',
  '',
  'usage: npm run gnosis:pair -- --a <selector> --b <selector> [--metric <csv>] [--ids <path>]',
  '                              [--results-dir <path>]',
  '',
  '  --a / --b   a unique SUBSTRING of the run\'s recorded perTopicPath;',
  '              an ambiguous or unmatched selector fails loudly',
  '  --metric    which measures to test; default is every metric both runs measured',
  `              known: ${PER_TOPIC_METRIC_COLUMNS.join(', ')}`,
  '  --ids       a file of query ids, one per line — restricts the test to that subset',
  '  --results-dir  which results directory to read history and per-topic files from;',
  '              default `results/`. Use it to pair rows recorded OUTSIDE the tracked',
  '              history — an external system\'s arm MUST NOT enter `results/history.jsonl`',
  '',
  'exit codes:',
  `  ${PAIR_EXIT_OK}  every requested metric produced a verdict`,
  `  ${PAIR_EXIT_REFUSED}  at least one metric was refused (scale moved, topics differ, metric unmeasured)`,
  `  ${PAIR_EXIT_USAGE}  unusable invocation (unknown flag, unknown flag value, ambiguous or unmatched selector)`,
  '',
].join('\n');

const csv = (value: string | undefined): readonly string[] =>
  value === undefined
    ? []
    : value.split(',').map(part => part.trim()).filter(part => part.length > 0);

/** An unknown measure THROWS: silently dropping it would report a narrower test than asked for. */
const asMetric = (value: string): MetricName => {
  const known = PER_TOPIC_METRIC_COLUMNS.find(name => name === value);
  if (known === undefined) {
    throw new Error(
      `dp-gnosis-bench: unknown --metric "${value}" — known: ${PER_TOPIC_METRIC_COLUMNS.join(', ')}`
    );
  }
  return known;
};

const required = (argv: readonly string[], name: string): string => {
  const value = flagValue(argv, name);
  if (value === undefined || value.startsWith('--')) {
    throw new Error(`dp-gnosis-bench: ${name} <selector> is required`);
  }
  return value;
};

/**
 * Every flag this CLI reads. Declared ONCE beside its parser and asserted
 * against its call sites by `flags.test.ts`; an unknown one REFUSES with
 * `PAIR_EXIT_USAGE` instead of being dropped, which would report a narrower
 * test than the one asked for under the wider one's name.
 */
export const PAIR_FLAGS: FlagSpec = {
  value: ['--a', '--b', '--metric', '--ids', '--results-dir'],
  boolean: ['--help'],
};

export const parsePairArgs = (argv: readonly string[]): PairArgs => {
  assertKnownFlags(argv, PAIR_FLAGS);
  return {
    a: required(argv, '--a'),
    b: required(argv, '--b'),
    metrics: csv(flagValue(argv, '--metric')).map(asMetric),
    idsPath: flagValue(argv, '--ids'),
    resultsDir: flagValue(argv, '--results-dir'),
  };
};

/** A selector resolved against the history record, or the reason it was not. */
export type RunSelection =
  | { readonly kind: 'run'; readonly row: HistoryRow }
  | { readonly kind: 'unmatched'; readonly selector: string }
  | {
    readonly kind: 'ambiguous';
    readonly selector: string;
    readonly matches: readonly string[];
  };

/** One run, in the words a caller needs to disambiguate it. */
export const describeRun = (row: HistoryRow): string =>
  `${row.perTopicPath ?? '(no per-topic path)'} — dataset=${row.dataset} ` +
  `adapter=${row.adapter} depth=${row.depth} gitSha=${row.gitSha} ts=${row.ts}`;

/**
 * The one run whose recorded `perTopicPath` contains `selector`. Resolution goes
 * through the history ROW rather than a bare file path so the tool holds each
 * run's provenance — the guards below have nothing to check without it.
 */
export const resolveRun = (
  history: readonly HistoryRow[],
  selector: string
): RunSelection => {
  const matches = history.filter(row => row.perTopicPath?.includes(selector) === true);
  const first = matches[0];
  if (first === undefined) return { kind: 'unmatched', selector };
  return matches.length > 1
    ? { kind: 'ambiguous', selector, matches: matches.map(describeRun) }
    : { kind: 'run', row: first };
};

const isRun = (selection: RunSelection): selection is { kind: 'run'; row: HistoryRow } =>
  selection.kind === 'run';

const selectionFailure = (selection: RunSelection): readonly string[] => {
  if (selection.kind === 'run') return [];
  if (selection.kind === 'unmatched') {
    return [`NO PAIRED TEST — "${selection.selector}" matches no recorded run's perTopicPath.`];
  }
  return [
    `NO PAIRED TEST — "${selection.selector}" is ambiguous, matching ${selection.matches.length} runs:`,
    ...selection.matches.map(match => `  ${match}`),
  ];
};

/** The ids named by `--ids`, or `undefined` when the whole topic set is tested. */
export const readIds = (path: string | undefined): readonly string[] | undefined => {
  if (path === undefined) return undefined;
  if (!existsSync(path)) throw new Error(`dp-gnosis-bench: --ids file not found: ${path}`);
  return readFileSync(path, 'utf8')
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.length > 0);
};

const restrict = (
  scores: TopicScores,
  ids: readonly string[] | undefined
): TopicScores =>
  ids === undefined ? scores : new Map([...scores].filter(([id]) => ids.includes(id)));

/** A metric is MEASURED when every topic carries it; one gap makes the vector unusable. */
const measuredMetrics = (scores: TopicScores): readonly MetricName[] =>
  PER_TOPIC_METRIC_COLUMNS.filter(metric =>
    [...scores.values()].every(topic => topic[metric] !== undefined)
  );

const defaultMetrics = (a: TopicScores, b: TopicScores): readonly MetricName[] => {
  const inB = measuredMetrics(b);
  return measuredMetrics(a).filter(metric => inB.includes(metric));
};

const metricsOf = (
  args: PairArgs,
  a: TopicScores,
  b: TopicScores
): readonly MetricName[] => (args.metrics.length > 0 ? args.metrics : defaultMetrics(a, b));

const number = (value: number): string => value.toFixed(DIGITS);

const signed = (value: number): string => `${value >= 0 ? '+' : ''}${number(value)}`;

const changeText = (change: ProvenanceChange): string =>
  `${change.field} ${JSON.stringify(change.previous)} → ${JSON.stringify(change.latest)}`;

const meanOf = (scores: TopicScores, metric: MetricName): number => {
  const values = [...scores.values()].map(topic => topic[metric] ?? 0);
  return values.reduce((sum, value) => sum + value, 0) / values.length;
};

interface Side {
  readonly row: HistoryRow;
  readonly scores: TopicScores;
}

const loadSide = (resultsDir: string, row: HistoryRow): Side | undefined => {
  const path = perTopicPath(resultsDir, row);
  const scores = path === undefined ? undefined : readPerTopic(path);
  return scores === undefined ? undefined : { row, scores };
};

/** The label carried on every verdict; a cross-dataset pair names both sides. */
const pairLabel = (a: HistoryRow, b: HistoryRow): string =>
  a.dataset === b.dataset ? a.dataset : `${a.dataset} → ${b.dataset}`;

const datasetLines = (a: HistoryRow, b: HistoryRow): readonly string[] =>
  a.dataset === b.dataset
    ? []
    : [
        `CROSS-DATASET PAIRING — "${a.dataset}" (A) vs "${b.dataset}" (B), ` +
          'paired by shared topic id',
      ];

const armLines = (arms: readonly ProvenanceChange[]): readonly string[] =>
  arms.length === 0
    ? []
    : [
        `ARM COMPARISON — ${arms.map(changeText).join(', ')} — two TREATMENTS, ` +
          'not a like-for-like delta',
      ];

const headerLines = (a: HistoryRow, b: HistoryRow): readonly string[] => [
  ...datasetLines(a, b),
  ...armLines(treatmentChanges(a, b)),
  `A: ${describeRun(a)}`,
  `B: ${describeRun(b)}`,
  '',
];

const verdictLine = (verdict: SignificanceVerdict, a: TopicScores, b: TopicScores): string =>
  `${verdict.metric}: n=${verdict.topics}  A ${number(meanOf(a, verdict.metric))}  ` +
  `B ${number(meanOf(b, verdict.metric))}  delta ${signed(verdict.meanDifference)}  ` +
  `p=${number(verdict.pValue)}  ${CI_LEVEL * PERCENT}% CI ` +
  `[${signed(verdict.ciLow)}, ${signed(verdict.ciHigh)}]  ` +
  `${verdict.significant ? 'significant' : 'not significant'}`;

const refusalDetail = (result: Significance): string => {
  if (result.kind === 'metric-unavailable') return ` — ${result.reason}`;
  if (result.kind === 'topics-differ') {
    return ` — only in A: [${result.onlyInPrevious.join(', ')}] ` +
      `| only in B: [${result.onlyInLatest.join(', ')}]`;
  }
  if (result.kind === 'missing-per-topic') return ` — ${result.paths.join(', ')}`;
  return '';
};

interface MetricOutcome {
  readonly metric: MetricName;
  readonly result: Significance;
}

const outcomeLine = (outcome: MetricOutcome, a: TopicScores, b: TopicScores): string =>
  outcome.result.kind === 'verdict'
    ? verdictLine(outcome.result, a, b)
    : `${outcome.metric}: NOT TESTED (${outcome.result.kind})${refusalDetail(outcome.result)}`;

const refused = (outcomes: readonly MetricOutcome[]): readonly MetricOutcome[] =>
  outcomes.filter(outcome => outcome.result.kind !== 'verdict');

const emptyPairing = (what: string): PairReport => ({
  lines: [what],
  reasons: [what],
  exitCode: PAIR_EXIT_REFUSED,
});

const reportOf = (
  outcomes: readonly MetricOutcome[],
  a: Side,
  b: Side
): PairReport => {
  const lines = outcomes.map(outcome => outcomeLine(outcome, a.scores, b.scores));
  return {
    lines: [...headerLines(a.row, b.row), ...lines],
    reasons: refused(outcomes).map(outcome => outcomeLine(outcome, a.scores, b.scores)),
    exitCode: refused(outcomes).length === 0 ? PAIR_EXIT_OK : PAIR_EXIT_REFUSED,
  };
};

const compared = (args: PairArgs, a: Side, b: Side): PairReport => {
  const ids = readIds(args.idsPath);
  const sideA: Side = { row: a.row, scores: restrict(a.scores, ids) };
  const sideB: Side = { row: b.row, scores: restrict(b.scores, ids) };
  if (sideA.scores.size === 0 || sideB.scores.size === 0) {
    return emptyPairing('NO PAIRED TEST — the id filter selected no topic scored by both runs.');
  }
  const metrics = metricsOf(args, sideA.scores, sideB.scores);
  if (metrics.length === 0) {
    return emptyPairing('NO PAIRED TEST — the two runs share no metric they both measured.');
  }
  const label = pairLabel(a.row, b.row);
  return reportOf(
    metrics.map(metric => ({
      metric,
      result: pairedScores(label, metric, sideA.scores, sideB.scores),
    })),
    sideA,
    sideB
  );
};

const scaleRefusal = (changed: readonly ProvenanceChange[]): PairReport =>
  emptyPairing(
    `NO PAIRED TEST — the measuring scale moved: ${changed.map(changeText).join(', ')}. ` +
      'Re-run both arms under one provenance before reading these numbers as quality.'
  );

const pairRows = (request: PairRequest, a: HistoryRow, b: HistoryRow): PairReport => {
  const scale = scaleChanges(a, b);
  if (scale.length > 0) return scaleRefusal(scale);
  const sideA = loadSide(request.resultsDir, a);
  const sideB = loadSide(request.resultsDir, b);
  if (sideA === undefined || sideB === undefined) {
    return emptyPairing(
      'NO PAIRED TEST — a run records no readable per-topic scores: ' +
        `${describeRun(sideA === undefined ? a : b)}`
    );
  }
  return compared(request.args, sideA, sideB);
};

/**
 * The whole comparison as text plus an exit code — pure, so every guard is
 * assertable without a process.
 */
export const pairReport = (request: PairRequest): PairReport => {
  const a = resolveRun(request.history, request.args.a);
  const b = resolveRun(request.history, request.args.b);
  if (!isRun(a) || !isRun(b)) {
    const lines = [...selectionFailure(a), ...selectionFailure(b)];
    return { lines, reasons: lines, exitCode: PAIR_EXIT_USAGE };
  }
  return pairRows(request, a.row, b.row);
};

const emit = (report: PairReport): number => {
  process.stdout.write(`${report.lines.join('\n')}\n`);
  if (report.reasons.length > 0) process.stderr.write(`${report.reasons.join('\n')}\n`);
  return report.exitCode;
};

export const main = (argv: readonly string[], resultsDir: string): number => {
  if (argv.includes('--help')) {
    process.stdout.write(PAIR_HELP);
    return PAIR_EXIT_OK;
  }
  try {
    const args = parsePairArgs(argv);
    const dir = args.resultsDir === undefined ? resultsDir : resolve(args.resultsDir);
    const history = readHistory(resolve(dir, HISTORY_FILE));
    return emit(pairReport({ resultsDir: dir, history, args }));
  } catch (error) {
    process.stderr.write(`${messageOf(error)}\n`);
    return PAIR_EXIT_USAGE;
  }
};

/** Guarded so the exported helpers stay importable from a test. */
if (invokedDirectly(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2), resolve(SUITE_ROOT, 'results'));
}
