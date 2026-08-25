/**
 * The regression gate: does the run that just finished still score what the
 * recorded champion scored?
 *
 * Three decisions are pinned here, and each exists because the obvious
 * alternative reports a green it has not earned:
 *
 * 1. **The gate is per DATASET, not per run.** One `--layer smoke` invocation
 *    measures several datasets, and a champion selector names a run of ONE of
 *    them. So the baseline is resolved inside each dataset's own rows —
 *    `resolveRun`'s semantics, applied to the dataset's slice — and a selector
 *    that matches nothing, or two runs, refuses NAMING BOTH the selector and the
 *    dataset.
 * 2. **It gates on the POINT ESTIMATE, never on significance.** `vault-hu`'s
 *    minimum detectable effect is 0.05–0.07 (`GNOSIS-GUIDE.md` § Known harness
 *    gaps), so requiring `p < ALPHA` before failing would wave a real 0.04
 *    regression through on the corpus least able to detect one. The p-value and
 *    the bootstrap interval are PRINTED beside the verdict — they say how well
 *    the drop is resolved — but the decision is `meanDifference < -failUnder`.
 * 3. **A refusal is a FAILURE, never a pass.** A moved `SCALE_FIELDS` value, a
 *    missing per-topic file, differing topic sets: the pairing refuses, and a
 *    gate that cannot compare has not verified anything. Both outcomes exit 4
 *    and the MESSAGE distinguishes them, because the caller's question ("may
 *    this merge?") has the same answer either way.
 *
 * The statistic itself is `significance.ts`, called and never re-implemented.
 */
import type { ProvenanceChange } from './compare.js';
import { BASELINE_FLAG, FAIL_UNDER_FLAG } from './flags.js';
import { resolveRun, type RunSelection } from './pair.js';
import type { HistoryRow } from './report.js';
import { type MetricName, pairedSignificance, type Significance } from './significance.js';
import { significanceLabel } from './sweepReport.js';

/**
 * Regression OR cannot-compare. One code for both: they answer the caller's
 * question identically, and the existing codes keep their meaning (0 = every
 * selected dataset ran and was recorded, 1 = at least one dataset failed).
 */
export const GATE_EXIT_CODE = 4;

/** The headline measure, the same one `--compare` rates a run on. */
const GATE_METRIC: MetricName = 'ndcg10';

const DIGITS = 4;

/** The reference run and the drop tolerated against it. */
export interface GateOptions {
  /** A substring of the baseline run's recorded `perTopicPath` — `pair.ts` semantics. */
  readonly baseline: string;
  /** The tolerated DROP in nDCG@10; a fall below `-failUnder` fails the run. */
  readonly failUnder: number;
}

/** One gate evaluation: the datasets that ran, against the recorded history. */
export interface GateRequest {
  readonly resultsDir: string;
  readonly history: readonly HistoryRow[];
  /** The dataset ids that ran and were recorded. */
  readonly datasets: readonly string[];
  readonly options: GateOptions;
}

/** What to print, and what to exit with. */
export interface GateReport {
  readonly lines: readonly string[];
  readonly exitCode: number;
}

const flagValue = (argv: readonly string[], name: string): string | undefined => {
  const index = argv.indexOf(name);
  return index === -1 ? undefined : argv[index + 1];
};

/**
 * A fractional tolerance is the point; a negative one is not. `--fail-under -1`
 * would demand an IMPROVEMENT of 1.0 under a flag whose name promises a
 * tolerated drop, so it is a usage error rather than something to reinterpret.
 */
const parseFailUnder = (value: string): number => {
  const tolerance = Number(value);
  if (Number.isFinite(tolerance) && tolerance >= 0) return tolerance;
  throw new Error(
    `dp-gnosis-bench: ${FAIL_UNDER_FLAG} expects a non-negative number, got "${value}"`
  );
};

/** Neither flag alone means anything, so half a pair REFUSES naming both. */
const halfPair = (): never => {
  throw new Error(
    `dp-gnosis-bench: ${BASELINE_FLAG} and ${FAIL_UNDER_FLAG} are given together or not at all — ` +
      'a baseline with no tolerance gates nothing, and a tolerance with no baseline has nothing to compare'
  );
};

/**
 * The gate's options, or `undefined` when no gate was asked for — the flags
 * absent leaves the run byte-identical to what every recorded row was measured
 * under.
 */
export const parseGateArgs = (argv: readonly string[]): GateOptions | undefined => {
  const baseline = flagValue(argv, BASELINE_FLAG);
  const failUnder = flagValue(argv, FAIL_UNDER_FLAG);
  if (baseline === undefined && failUnder === undefined) return undefined;
  if (baseline === undefined || failUnder === undefined) return halfPair();
  return { baseline, failUnder: parseFailUnder(failUnder) };
};

/** One dataset's verdict: whether it passes, and the line that says why. */
interface GateOutcome {
  readonly ok: boolean;
  readonly line: string;
}

const signed = (value: number): string =>
  `${value >= 0 ? '+' : ''}${value.toFixed(DIGITS)}`;

const cannotCompare = (dataset: string, reason: string): GateOutcome => ({
  ok: false,
  line: `${dataset}: CANNOT COMPARE — ${reason}`,
});

const changeText = (change: ProvenanceChange): string =>
  `${change.field} ${JSON.stringify(change.previous)} → ${JSON.stringify(change.latest)}`;

/** The refusal in the reader's words, naming the moved field when one moved. */
const refusalReason = (result: Significance): string =>
  result.kind === 'provenance-changed'
    ? `the measuring scale moved — ${result.changed.map(changeText).join(', ')}`
    : significanceLabel(result);

/** Why the selector produced no single baseline, naming it AND the dataset. */
const selectorReason = (
  selection: Exclude<RunSelection, { kind: 'run' }>,
  dataset: string
): string => {
  if (selection.kind === 'unmatched') {
    return `${BASELINE_FLAG} "${selection.selector}" matches no recorded run of ${dataset}`;
  }
  return (
    `${BASELINE_FLAG} "${selection.selector}" is ambiguous for ${dataset}, ` +
    `matching ${selection.matches.length} runs: ${selection.matches.join('; ')}`
  );
};

const verdictOutcome = (
  dataset: string,
  result: Extract<Significance, { kind: 'verdict' }>,
  failUnder: number
): GateOutcome => {
  const ok = result.meanDifference >= -failUnder;
  return {
    ok,
    line:
      `${dataset}: ${ok ? 'ok' : 'REGRESSION'} — nDCG@10 ${signed(result.meanDifference)} ` +
      `over ${result.topics} topics (tolerated drop ${failUnder.toFixed(DIGITS)}) — ` +
      significanceLabel(result),
  };
};

const outcomeOf = (dataset: string, result: Significance, failUnder: number): GateOutcome =>
  result.kind === 'verdict'
    ? verdictOutcome(dataset, result, failUnder)
    : cannotCompare(dataset, refusalReason(result));

/** The run just recorded for this dataset — history is appended in run order. */
const latestOf = (rows: readonly HistoryRow[]): HistoryRow | undefined => rows[rows.length - 1];

const gateDataset = (request: GateRequest, dataset: string): GateOutcome => {
  const rows = request.history.filter(row => row.dataset === dataset);
  const latest = latestOf(rows);
  if (latest === undefined) return cannotCompare(dataset, 'the run recorded no history row');
  const selection = resolveRun(rows, request.options.baseline);
  if (selection.kind !== 'run') return cannotCompare(dataset, selectorReason(selection, dataset));
  const previous = selection.row;
  return outcomeOf(
    dataset,
    pairedSignificance({ resultsDir: request.resultsDir, previous, latest, metric: GATE_METRIC }),
    request.options.failUnder
  );
};

/**
 * Every measured dataset rated against its own baseline row. One failure fails
 * the run: the gate answers a single question for the whole invocation.
 */
export const gateReport = (request: GateRequest): GateReport => {
  const outcomes = request.datasets.map(dataset => gateDataset(request, dataset));
  return {
    lines: outcomes.map(outcome => outcome.line),
    exitCode: outcomes.every(outcome => outcome.ok) ? 0 : GATE_EXIT_CODE,
  };
};
