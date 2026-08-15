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
 * | treatment | `rerankProfile` / `rerankWeight` | a different FUSION rule over the same two orders |
 * | treatment | `rerankModel` | a different CROSS-ENCODER producing the reranked order |
 * | treatment | `analyzer` | a different ANALYSIS chain in the index, so different terms |
 *
 * A moved SCALE is still refused: the two numbers are not on one axis and no
 * label can rescue them. A moved TREATMENT is the experiment, so it is compared
 * — but reported as an ARM COMPARISON, never as a like-for-like delta, because
 * the two arms differ by construction rather than by a regression.
 *
 * `gitSha` and `ts` are deliberately NOT guarded: a changed engine commit is
 * precisely the thing a delta is supposed to measure.
 */
import { RERANK_MODEL_ID } from '../../dp-gnosis/src/config.js';
import { DEFAULT_ANALYZER } from '../../dp-gnosis/src/query.js';
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
export const TREATMENT_FIELDS = [
  'adapter',
  'rerank',
  'rerankProfile',
  'rerankWeight',
  'rerankModel',
  'analyzer',
] as const;

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

/**
 * The signed metric movement from the older run to the newer one. A recall
 * cutoff either run did not measure has NO delta — `undefined`, never a
 * subtraction against a missing value.
 */
export interface MetricDelta {
  readonly ndcg10: number;
  readonly recall10: number;
  readonly recall20: number | undefined;
  readonly recall100: number;
  readonly recall300: number | undefined;
  readonly recall1000: number | undefined;
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

/**
 * What an ABSENT field means, for the fields where absence is not "unknown" but
 * a known older value. A row recorded before the analyzer was selectable was
 * built by `DEFAULT_ANALYZER` — the only chain that ever built one — so reading
 * it as unset would label every first comparison after this landed an ARM
 * COMPARISON against an arm that was never run. The engine's fts5 stamp resolves
 * an unstamped index by exactly this rule.
 *
 * `rerankModel` follows it: every row recorded before the model was selectable
 * was scored by `RERANK_MODEL_ID`, the only reranker the engine ever called.
 */
const FIELD_DEFAULTS: Partial<Record<ProvenanceField, string>> = {
  analyzer: DEFAULT_ANALYZER,
  rerankModel: RERANK_MODEL_ID,
};

const valueOf = (row: HistoryRow, field: ProvenanceField): HistoryRow[ProvenanceField] =>
  row[field] === undefined ? FIELD_DEFAULTS[field] : row[field];

const changedField = (
  previous: HistoryRow,
  latest: HistoryRow,
  field: ProvenanceField
): ProvenanceChange | undefined =>
  valueOf(previous, field) === valueOf(latest, field)
    ? undefined
    : { field, previous: valueOf(previous, field), latest: valueOf(latest, field) };

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

/** Both sides must have measured it; otherwise there is nothing to subtract. */
const optionalDelta = (
  previous: number | undefined,
  latest: number | undefined
): number | undefined =>
  previous === undefined || latest === undefined ? undefined : latest - previous;

const deltaOf = (previous: HistoryRow, latest: HistoryRow): MetricDelta => ({
  ndcg10: latest.ndcg10 - previous.ndcg10,
  recall10: latest.recall10 - previous.recall10,
  recall20: optionalDelta(previous.recall20, latest.recall20),
  recall100: latest.recall100 - previous.recall100,
  recall300: optionalDelta(previous.recall300, latest.recall300),
  recall1000: optionalDelta(previous.recall1000, latest.recall1000),
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

/** A cutoff one side never measured is omitted, not printed as a zero movement. */
const optionalText = (label: string, value: number | undefined): string =>
  value === undefined ? '' : `${label} ${signed(value)}  `;

const metricsText = (comparison: ComparisonDelta | ComparisonArmDelta): string =>
  `nDCG@10 ${signed(comparison.delta.ndcg10)}  ` +
  `R@10 ${signed(comparison.delta.recall10)}  ` +
  optionalText('R@20', comparison.delta.recall20) +
  `R@100 ${signed(comparison.delta.recall100)}  ` +
  optionalText('R@300', comparison.delta.recall300) +
  optionalText('R@1000', comparison.delta.recall1000) +
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
