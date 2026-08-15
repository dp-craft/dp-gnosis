/**
 * The `0ee258ea` lesson, encoded as a refusal.
 *
 * That commit changed atom ids — the measuring scale — and the before/after
 * nDCG numbers were chained anyway, because nothing in the tooling knew the
 * scale had moved. So this module does NOT subtract two runs whose provenance
 * differs. It names the field that changed instead, and a changed measuring
 * scale can never again masquerade as a quality change.
 *
 * A guarded field is one of two kinds, and the two demand OPPOSITE answers:
 *
 * | Kind | Field | What a change means |
 * |---|---|---|
 * | measuring scale | `atomMaxChars` | a different chunking, so a different ranking unit |
 * | measuring scale | `depth` | a different retrieval cut, which moves recall mechanically |
 * | measuring scale | `corpusBytes` / `corpusLines` | a different corpus — the cheap checksum |
 * | treatment | `adapter` | a different engine path — the thing an A/B run exists to compare |
 * | treatment | `rerank` | a second-stage model in the loop, or not |
 *
 * A moved SCALE is still refused: the two numbers are not on one axis and no
 * label can rescue them. A moved TREATMENT is the experiment, so it is compared
 * — but reported as an ARM COMPARISON, never as a like-for-like delta, because
 * the two arms differ by construction rather than by a regression.
 *
 * `gitSha` and `ts` are deliberately NOT guarded: a changed engine commit is
 * precisely the thing a delta is supposed to measure.
 */
import type { HistoryRow } from './report.js';

const DELTA_DIGITS = 4;

/** Fields that change WHAT is measured; a move invalidates any subtraction. */
export const SCALE_FIELDS = [
  'atomMaxChars',
  'depth',
  'corpusBytes',
  'corpusLines',
] as const;

/** Fields that name the TREATMENT under measurement; a move IS the experiment. */
export const TREATMENT_FIELDS = ['adapter', 'rerank'] as const;

export type ScaleField = (typeof SCALE_FIELDS)[number];
export type TreatmentField = (typeof TREATMENT_FIELDS)[number];
export type ProvenanceField = ScaleField | TreatmentField;

/** Every guarded field. Derived from the two kinds so neither can drift. */
export const PROVENANCE_FIELDS: readonly ProvenanceField[] = [
  ...SCALE_FIELDS,
  ...TREATMENT_FIELDS,
];

/** A guarded field that moved between the two runs, with both of its values. */
export interface ProvenanceChange {
  readonly field: ProvenanceField;
  readonly previous: HistoryRow[ProvenanceField];
  readonly latest: HistoryRow[ProvenanceField];
}

/** The signed metric movement from the older run to the newer one. */
export interface MetricDelta {
  readonly ndcg10: number;
  readonly recall10: number;
  readonly recall100: number;
  readonly mrr10: number;
}

/** A comparable pair: the delta is meaningful because provenance held still. */
export interface ComparisonDelta {
  readonly kind: 'delta';
  readonly dataset: string;
  readonly previous: HistoryRow;
  readonly latest: HistoryRow;
  readonly delta: MetricDelta;
}

/**
 * Two ARMS of one experiment: the measuring scale held still and a treatment
 * field moved on purpose, so the difference is attributable to the treatment
 * and to nothing else. Kept apart from `delta` so no reader can mistake a
 * between-arms difference for a regression on one arm.
 */
export interface ComparisonArmDelta {
  readonly kind: 'arm-delta';
  readonly dataset: string;
  readonly previous: HistoryRow;
  readonly latest: HistoryRow;
  readonly delta: MetricDelta;
  /** The treatment fields that differ — what the two arms actually are. */
  readonly arms: readonly ProvenanceChange[];
}

/** The refusal: the scale moved, so the numbers are not on the same axis. */
export interface ComparisonRefused {
  readonly kind: 'provenance-changed';
  readonly dataset: string;
  readonly previous: HistoryRow;
  readonly latest: HistoryRow;
  readonly changed: readonly ProvenanceChange[];
}

/** Fewer than two recorded runs for this dataset — nothing to subtract. */
export interface ComparisonMissing {
  readonly kind: 'insufficient-history';
  readonly dataset: string;
  readonly runs: number;
}

export type Comparison =
  | ComparisonDelta
  | ComparisonArmDelta
  | ComparisonRefused
  | ComparisonMissing;

const changedField = (
  previous: HistoryRow,
  latest: HistoryRow,
  field: ProvenanceField
): ProvenanceChange | undefined =>
  previous[field] === latest[field]
    ? undefined
    : { field, previous: previous[field], latest: latest[field] };

const isChange = (change: ProvenanceChange | undefined): change is ProvenanceChange =>
  change !== undefined;

const changesIn = (
  previous: HistoryRow,
  latest: HistoryRow,
  fields: readonly ProvenanceField[]
): readonly ProvenanceChange[] =>
  fields.map(field => changedField(previous, latest, field)).filter(isChange);

/** Every guarded field that moved — all of them, so one report names them all. */
export const provenanceChanges = (
  previous: HistoryRow,
  latest: HistoryRow
): readonly ProvenanceChange[] => changesIn(previous, latest, PROVENANCE_FIELDS);

/** The measuring-scale moves only — the ones that make a pair incomparable. */
export const scaleChanges = (
  previous: HistoryRow,
  latest: HistoryRow
): readonly ProvenanceChange[] => changesIn(previous, latest, SCALE_FIELDS);

/** The treatment moves only — the ones that make a pair an EXPERIMENT. */
export const treatmentChanges = (
  previous: HistoryRow,
  latest: HistoryRow
): readonly ProvenanceChange[] => changesIn(previous, latest, TREATMENT_FIELDS);

const deltaOf = (previous: HistoryRow, latest: HistoryRow): MetricDelta => ({
  ndcg10: latest.ndcg10 - previous.ndcg10,
  recall10: latest.recall10 - previous.recall10,
  recall100: latest.recall100 - previous.recall100,
  mrr10: latest.mrr10 - previous.mrr10,
});

const comparePair = (
  dataset: string,
  previous: HistoryRow,
  latest: HistoryRow
): Comparison => {
  if (scaleChanges(previous, latest).length > 0) {
    const changed = provenanceChanges(previous, latest);
    return { kind: 'provenance-changed', dataset, previous, latest, changed };
  }
  const arms = treatmentChanges(previous, latest);
  const delta = deltaOf(previous, latest);
  return arms.length > 0
    ? { kind: 'arm-delta', dataset, previous, latest, delta, arms }
    : { kind: 'delta', dataset, previous, latest, delta };
};

/**
 * The two most recent rows for `datasetId`, compared — or the reason they were
 * not. History is append-only, so "most recent" is simply the last two rows.
 */
export const compareLastTwo = (
  history: readonly HistoryRow[],
  datasetId: string
): Comparison => {
  const rows = history.filter(row => row.dataset === datasetId);
  const previous = rows.at(-2);
  const latest = rows.at(-1);
  return previous === undefined || latest === undefined
    ? { kind: 'insufficient-history', dataset: datasetId, runs: rows.length }
    : comparePair(datasetId, previous, latest);
};

/** One comparison per dataset in the record, in first-seen order. */
export const compareAll = (history: readonly HistoryRow[]): readonly Comparison[] =>
  [...new Set(history.map(row => row.dataset))].map(dataset =>
    compareLastTwo(history, dataset)
  );

const signed = (value: number): string =>
  `${value >= 0 ? '+' : ''}${value.toFixed(DELTA_DIGITS)}`;

const metricsText = (comparison: ComparisonDelta | ComparisonArmDelta): string =>
  `nDCG@10 ${signed(comparison.delta.ndcg10)}  ` +
  `R@10 ${signed(comparison.delta.recall10)}  ` +
  `R@100 ${signed(comparison.delta.recall100)}  ` +
  `MRR@10 ${signed(comparison.delta.mrr10)}  ` +
  `(${comparison.previous.gitSha} → ${comparison.latest.gitSha})`;

const deltaLine = (comparison: ComparisonDelta): string =>
  `${comparison.dataset}: ${metricsText(comparison)}`;

const changeText = (change: ProvenanceChange): string =>
  `${change.field} ${JSON.stringify(change.previous)} → ${JSON.stringify(change.latest)}`;

const refusalLine = (comparison: ComparisonRefused): string =>
  `${comparison.dataset}: NO DELTA REPORTED — the measurement changed: ` +
  `${comparison.changed.map(changeText).join(', ')}. ` +
  'Re-run both arms under one provenance before reading these numbers as quality.';

/**
 * The arm line leads with the label and the two arms, so the numbers are never
 * read before the reader knows they belong to two different treatments.
 */
const armLine = (comparison: ComparisonArmDelta): string =>
  `${comparison.dataset}: ARM COMPARISON — ${comparison.arms.map(changeText).join(', ')} — ` +
  `two TREATMENTS, not a like-for-like delta: ${metricsText(comparison)}`;

/** One line a human can act on, whichever outcome the comparison had. */
export const formatComparison = (comparison: Comparison): string => {
  if (comparison.kind === 'delta') return deltaLine(comparison);
  if (comparison.kind === 'arm-delta') return armLine(comparison);
  if (comparison.kind === 'provenance-changed') return refusalLine(comparison);
  return `${comparison.dataset}: only ${comparison.runs} recorded run — nothing to compare yet.`;
};
